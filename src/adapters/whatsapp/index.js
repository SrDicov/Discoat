import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

export default class WhatsAppAdapter extends BaseAdapter {
    constructor() {
        super('whatsapp');
        this.sock = null;
        this.tempDir = path.join(process.cwd(), '.temp_wa_media');
        this.baileysLogger = pino({ level: 'silent' });
    }

    async init(context) {
        this.context = context;
        this.logger = context.logger;
        // Obligamos a instanciar el Worker Egress explícitamente sin usar super.start()
        this._worker = new this.context.queue.Worker(
            `queue_${this.platformName}_out`,
            async (job) => await this.processEgress(job.data),
                                                     { connection: this.context.redis }
        );
        this.logger.debug(`Worker Egress registrado localmente para: [queue_${this.platformName}_out]`);

        if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // EL MÉTODO START() PURO Y EXPLÍCITO
    async start() {
        this.logger.info(`[${this.platformName}] Iniciando motor criptográfico de Baileys...`);
        // Usamos await para garantizar que la ejecución no siga si WhatsApp falla al iniciar
        await this._connectWA();
    }

    async _connectWA() {
        const authFolder = path.join(process.cwd(), 'auth_baileys');
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        this.sock = makeWASocket({
            auth: state,
            logger: this.baileysLogger,
            browser: ['Discoat Bridge', 'Chrome', '2.0.0'],
            printQRInTerminal: false // Quitamos el feature obsoleto
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Dibujar QR con paquete externo
            if (qr) {
                this.logger.info(`[${this.platformName}] 📱 Escanea este código QR para conectar WhatsApp:`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                this.logger.warn(`[${this.platformName}] Socket cerrado. ¿Reconectar? ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => this._connectWA(), 4000);
                } else {
                    this.logger.error(`[${this.platformName}] Sesión inválida. Borra la carpeta auth_baileys.`);
                }
            } else if (connection === 'open') {
                this.logger.info(`[${this.platformName}] Conectado exitosamente a la matriz Meta.`);
            }
        });

        this._registerEvents();
    }

    _registerEvents() {
        // Escuchar nuevos mensajes
        this.sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                // Prevenir bucles infinitos ignorando nuestros propios mensajes
                if (msg.key.fromMe) continue;

                // Ignorar estados y mensajes de sistema
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (!msg.message) continue;

                this.context.logger.withCorrelation({ source: this.platformName }, async () => {
                    await this._handleIngress(msg);
                });
            }
        });
    }

    async _handleIngress(msg) {
        const chanId = msg.key.remoteJid; // El ID del chat o grupo
        const authorId = msg.key.participant || msg.key.remoteJid; // Quién lo envió (participant para grupos)

        // Obtener el nombre del contacto si está disponible
        const authorName = msg.pushName || authorId.split('@')[0];

        // Extracción agnóstica del tipo de mensaje
        const messageType = Object.keys(msg.message)[0];
        const msgContent = msg.message[messageType];

        // Extracción de Texto
        let text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msgContent?.caption || '';

        const attachments = [];
        let isVoiceNote = false;

        // MANEJO DE MULTIMEDIA (Cifrado E2E -> Archivo Local)
        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType)) {
            try {
                // Nota: Baileys requiere descargar el archivo aquí para poder desencriptarlo
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: this.baileysLogger });
                const ext = this._getExtensionFromMime(msgContent.mimetype);
                const localPath = path.join(this.tempDir, `${randomUUID()}${ext}`);
                fs.writeFileSync(localPath, buffer);

                if (messageType === 'audioMessage' && msgContent.ptt) isVoiceNote = true;

                attachments.push({
                    id: msg.key.id,
                    localPath: localPath, // Pasamos el path local en lugar de URL
                    type: messageType.includes('audio') ? UMF_TYPES.AUDIO : (messageType === 'stickerMessage' ? UMF_TYPES.STICKER : UMF_TYPES.FILE),
                                 mimeType: msgContent.mimetype,
                                 name: msgContent.fileName || `wa_media_${msg.key.id}${ext}`
                });
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Fallo al descargar adjunto cifrado de WA: ${error.message}`);
            }
        }

        // MANEJO DE QUOTES (Respuestas)
        const contextInfo = msg.message.extendedTextMessage?.contextInfo;
        let replyData = null;
        if (contextInfo && contextInfo.quotedMessage) {
            const quotedType = Object.keys(contextInfo.quotedMessage)[0];
            const quotedContent = contextInfo.quotedMessage[quotedType];

            replyData = {
                parentId: contextInfo.stanzaId,
                parentText: contextInfo.quotedMessage.conversation || quotedContent?.text || quotedContent?.caption || '',
                parentAttachments: []
            };

            // Intentar descargar media citada para el Transcriptor
            if (['imageMessage', 'videoMessage', 'audioMessage'].includes(quotedType)) {
                try {
                    // Creamos un objeto de mensaje falso simulando el formato que pide Baileys para descargas
                    const fakeMsg = { message: contextInfo.quotedMessage };
                    const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: this.baileysLogger });
                    const ext = this._getExtensionFromMime(quotedContent.mimetype);
                    const localPath = path.join(this.tempDir, `${randomUUID()}_quote${ext}`);
                    fs.writeFileSync(localPath, buffer);

                    replyData.parentAttachments.push({
                        id: contextInfo.stanzaId,
                        localPath: localPath,
                        type: quotedType.includes('audio') ? UMF_TYPES.AUDIO : UMF_TYPES.FILE,
                                                     mimeType: quotedContent.mimetype
                    });
                } catch (e) {
                    // Ignoramos si falla, los audios antiguos citados pueden no estar disponibles
                }
            }
        }

        // Construir sobre el Contrato UMF
        const envelope = createEnvelope({
            type: attachments.length > 0 && !text ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
            source: {
                platform: this.platformName,
                channelId: chanId,
                userId: authorId,
                username: authorName,
                avatar: null // WA no da avatar fácil por mensaje
            },
            body: { text, attachments },
            replyTo: replyData,
            correlationId: this.context.logger.getCorrelationId(),
                                        trace_path: [`${this.platformName}:${chanId}`] // Prevención de Bucles
        });

        this.emitIngress(envelope);
    }

    /**
     * ENRUTAMIENTO DE SALIDA HACIA WHATSAPP
     */
    async processEgress(envelope) {
        return this.breaker.fire(async () => {
            if (!this.sock) throw new Error('Socket de WhatsApp no inicializado.');

            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            // SOLUCIÓN MASQUERADE: Como WA no tiene Webhooks, simulamos visualmente la cabecera
            const senderTag = `*[ ${envelope.head.source.username} | ${envelope.head.source.platform.toUpperCase()} ]*`;

            // Sanitización básica para WA (convertir HTML a Markdown de WA)
            let content = envelope.body.text || '';
            content = content
            .replace(/<b>/g, '*').replace(/<\/b>/g, '*')
            .replace(/<i>/g, '_').replace(/<\/i>/g, '_')
            .replace(/<@!?(\d+)>/g, '@$1'); // Limpiar tags feos de Discord

            let finalMessageText = content ? `${senderTag}\n${content}` : senderTag;

            const attachments = envelope.body.attachments || [];

            // Si NO hay adjuntos, enviamos solo texto simple
            if (attachments.length === 0) {
                await this.sock.sendMessage(destChannelId, { text: finalMessageText });
                return;
            }

            // Si HAY adjuntos, evaluamos
            for (const att of attachments) {
                let buffer;
                try {
                    // Obtenemos el buffer ya sea de localPath (MediaWorker) o URL
                    if (att.localPath && fs.existsSync(att.localPath)) {
                        buffer = fs.readFileSync(att.localPath);
                    } else if (att.url) {
                        const response = await fetch(att.url);
                        buffer = Buffer.from(await response.arrayBuffer());
                    } else continue;

                    // Enviar según el tipo de archivo (WA es muy estricto con las keys)
                    if (att.mimeType?.startsWith('image/') || att.type === UMF_TYPES.STICKER) {
                        // En WA nativo enviar stickers es complejo (requiere WebP exacto con EXIF).
                        // Fallback seguro: Enviarlo como imagen normal.
                        await this.sock.sendMessage(destChannelId, { image: buffer, caption: finalMessageText });
                        finalMessageText = ''; // Limpiamos el texto para no repetirlo si hay múltiples fotos
                    }
                    else if (att.mimeType?.startsWith('video/')) {
                        await this.sock.sendMessage(destChannelId, { video: buffer, caption: finalMessageText });
                        finalMessageText = '';
                    }
                    else if (att.mimeType?.startsWith('audio/')) {
                        // Audio requiere ptt: true para ser nota de voz, sino es archivo de música
                        await this.sock.sendMessage(destChannelId, { audio: buffer, ptt: true });
                        // Si era un audio, mandamos el texto de forma separada
                        if (finalMessageText) {
                            await this.sock.sendMessage(destChannelId, { text: finalMessageText });
                            finalMessageText = '';
                        }
                    }
                    else {
                        // Archivo genérico (Document)
                        await this.sock.sendMessage(destChannelId, {
                            document: buffer,
                            mimetype: att.mimeType || 'application/octet-stream',
                            fileName: att.name || 'archivo',
                            caption: finalMessageText
                        });
                        finalMessageText = '';
                    }
                } catch (err) {
                    this.logger.error(`[${this.platformName}] Fallo al enviar archivo a WA: ${err.message}`);
                }
            }
        });
    }

    _getExtensionFromMime(mimeType) {
        if (!mimeType) return '.bin';
        if (mimeType.includes('image/jpeg')) return '.jpg';
        if (mimeType.includes('image/png')) return '.png';
        if (mimeType.includes('image/webp')) return '.webp';
        if (mimeType.includes('video/mp4')) return '.mp4';
        if (mimeType.includes('audio/ogg')) return '.ogg';
        if (mimeType.includes('audio/mpeg')) return '.mp3';
        return '';
    }

    async stop() {
        if (this.sock) {
            this.sock.end(new Error('Sistema apagándose'));
        }
    }

    async health() {
        return { status: this.sock ? 'active' : 'disconnected' };
    }
}
