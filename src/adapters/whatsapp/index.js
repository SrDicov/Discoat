import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
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
        this.isConnecting = false;
    }

    async init(context) {
        await super.init(context);
        if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
    }

    async start() {
        this.logger.info(`[${this.platformName}] Levantando proceso de Baileys...`);
        await this._connectWA();
    }

    async _connectWA() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        try {
            const authFolder = path.join(process.cwd(), 'auth_baileys');
            const { state, saveCreds } = await useMultiFileAuthState(authFolder);

            // SOLUCIÓN 1: Forzar la última versión de la API de WhatsApp
            const { version, isLatest } = await fetchLatestBaileysVersion();
            this.logger.info(`[${this.platformName}] Conectando a WA v${version.join('.')} (Última: ${isLatest})`);

            // SOLUCIÓN 2: Mostrar errores fatales de Baileys en lugar de silencio total
            const waLogger = pino({ level: 'error' });

            this.sock = makeWASocket({
                version,
                auth: state,
                logger: waLogger,
                browser: ['Discoat Bridge', 'Chrome', '2.0.0'],
                printQRInTerminal: false
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.logger.info(`[${this.platformName}] 📱 Escanea este código QR para conectar WhatsApp:`);
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    this.isConnecting = false;

                    // SOLUCIÓN 3: Telemetría exacta del cierre
                    const error = lastDisconnect?.error;
                    const statusCode = error?.output?.statusCode || error?.output?.payload?.statusCode;
                    const reason = error?.message || 'Desconocida';

                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    this.logger.warn(`[${this.platformName}] Socket cerrado. Código: ${statusCode}, Razón: ${reason}. ¿Reconectar? ${shouldReconnect}`);

                    if (shouldReconnect) {
                        setTimeout(() => this._connectWA(), 4000);
                    } else {
                        this.logger.error(`[${this.platformName}] Sesión cerrada permanentemente. Borra auth_baileys y reinicia.`);
                    }
                } else if (connection === 'open') {
                    this.isConnecting = false;
                    this.logger.info(`[${this.platformName}] Conectado exitosamente.`);
                }
            });

            this._registerEvents();
        } catch (error) {
            this.isConnecting = false;
            this.logger.error(`[${this.platformName}] Falla crítica al inicializar Baileys: ${error.message}`);
        }
    }

    _registerEvents() {
        this.sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (!msg.message) continue;

                this.context.logger.withCorrelation({ source: this.platformName }, async () => {
                    await this._handleIngress(msg);
                });
            }
        });
    }

    async _handleIngress(msg) {
        const chanId = msg.key.remoteJid;
        const authorId = msg.key.participant || msg.key.remoteJid;
        const authorName = msg.pushName || authorId.split('@')[0];

        const messageType = Object.keys(msg.message)[0];
        const msgContent = msg.message[messageType];

        let text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msgContent?.caption || '';

        const attachments = [];

        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType)) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: this.baileysLogger });
                const ext = this._getExtensionFromMime(msgContent.mimetype);
                const localPath = path.join(this.tempDir, `${randomUUID()}${ext}`);
                fs.writeFileSync(localPath, buffer);

                attachments.push({
                    id: msg.key.id,
                    localPath: localPath,
                    type: messageType.includes('audio') ? UMF_TYPES.AUDIO : (messageType === 'stickerMessage' ? UMF_TYPES.STICKER : UMF_TYPES.FILE),
                                 mimeType: msgContent.mimetype,
                                 name: msgContent.fileName || `wa_media_${msg.key.id}${ext}`
                });
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Fallo al descargar adjunto cifrado de WA: ${error.message}`);
            }
        }

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

            if (['imageMessage', 'videoMessage', 'audioMessage'].includes(quotedType)) {
                try {
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
                } catch (e) {}
            }
        }

        const envelope = createEnvelope({
            type: attachments.length > 0 && !text ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
            source: {
                platform: this.platformName,
                channelId: chanId,
                userId: authorId,
                username: authorName,
                avatar: null
            },
            body: { text, attachments },
            replyTo: replyData,
            correlationId: this.context.logger.getCorrelationId(),
                                        trace_path: [`${this.platformName}:${chanId}`]
        });

        this.emitIngress(envelope);
    }

    async processEgress(envelope) {
        return this.breaker.fire(async () => {
            if (!this.sock) throw new Error('Socket de WhatsApp no inicializado.');

            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            const senderTag = `*[ ${envelope.head.source.username} | ${envelope.head.source.platform.toUpperCase()} ]*`;

            let content = envelope.body.text || '';
            content = content
            .replace(/<b>/g, '*').replace(/<\/b>/g, '*')
            .replace(/<i>/g, '_').replace(/<\/i>/g, '_')
            .replace(/<@!?(\d+)>/g, '@$1');

            let finalMessageText = content ? `${senderTag}\n${content}` : senderTag;

            const attachments = envelope.body.attachments || [];

            if (attachments.length === 0) {
                await this.sock.sendMessage(destChannelId, { text: finalMessageText });
                return;
            }

            for (const att of attachments) {
                let buffer;
                try {
                    if (att.localPath && fs.existsSync(att.localPath)) {
                        buffer = fs.readFileSync(att.localPath);
                    } else if (att.url) {
                        const response = await fetch(att.url);
                        buffer = Buffer.from(await response.arrayBuffer());
                    } else continue;

                    if (att.mimeType?.startsWith('image/') || att.type === UMF_TYPES.STICKER) {
                        await this.sock.sendMessage(destChannelId, { image: buffer, caption: finalMessageText });
                        finalMessageText = '';
                    }
                    else if (att.mimeType?.startsWith('video/')) {
                        await this.sock.sendMessage(destChannelId, { video: buffer, caption: finalMessageText });
                        finalMessageText = '';
                    }
                    else if (att.mimeType?.startsWith('audio/')) {
                        await this.sock.sendMessage(destChannelId, { audio: buffer, ptt: true });
                        if (finalMessageText) {
                            await this.sock.sendMessage(destChannelId, { text: finalMessageText });
                            finalMessageText = '';
                        }
                    }
                    else {
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
