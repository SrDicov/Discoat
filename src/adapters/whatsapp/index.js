import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    makeWASocket,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    useMultiFileAuthState
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

    /**
     * Método de inicio modificado: si S3 no está disponible, usa almacenamiento local (modo degradado).
     */
    async start() {
        this.logger.info(`[${this.platformName}] Levantando proceso de Baileys...`);

        const storageService = this.context.storage;
        let authState, saveCredsFn;

        // 1. Decidir método de autenticación según disponibilidad de S3
        if (!storageService || !storageService.isReady) {
            // MODO DEGRADADO (desarrollo local)
            this.logger.warn(`[${this.platformName}] ⚠️ [MODO DEGRADADO] S3 no detectado. Usando almacenamiento local. NO APTO PARA PRODUCCIÓN EN CLÚSTER.`);
            const authPath = path.resolve(process.cwd(), 'data', 'auth_whatsapp');
            const { state, saveCreds } = await useMultiFileAuthState(authPath);
            authState = state;
            saveCredsFn = saveCreds;
        } else {
            // MODO PRODUCCIÓN (autenticación distribuida en S3)
            this.logger.info(`[${this.platformName}] Inicializando sesión distribuida en bucket S3...`);
            const { state, saveCreds } = await this._useDistributedAuthState(storageService, 'whatsapp_session');
            authState = state;
            saveCredsFn = saveCreds;
        }

        // 2. Obtener última versión de la API de WhatsApp
        const { version, isLatest } = await fetchLatestBaileysVersion();
        this.logger.info(`[${this.platformName}] Conectando a WA v${version.join('.')} (Última: ${isLatest})`);

        // 3. Crear el socket con la configuración obtenida
        this.sock = makeWASocket({
            version,
            auth: authState,
            logger: this.baileysLogger,
            browser: ['Discoat Bridge', 'Chrome', '2.0.0'],
            printQRInTerminal: false,
            syncFullHistory: false
        });

        // 4. Guardar actualizaciones de credenciales
        this.sock.ev.on('creds.update', saveCredsFn);

        // 5. Manejar eventos de conexión (incluye reconexión y QR)
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.logger.info(`[${this.platformName}] 📱 Escanea este código QR para conectar WhatsApp:`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                this.isConnecting = false;

                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode || error?.output?.payload?.statusCode;
                const reason = error?.message || 'Desconocida';

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                this.logger.warn(`[${this.platformName}] Socket cerrado. Código: ${statusCode}, Razón: ${reason}. ¿Reconectar? ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(() => this.start(), 4000);
                } else {
                    this.logger.error(`[${this.platformName}] Sesión cerrada permanentemente. Verifica credenciales y reinicia.`);
                }
            } else if (connection === 'open') {
                this.isConnecting = false;
                this.logger.info(`[${this.platformName}] Conectado exitosamente.`);
            }
        });

        // 6. Registrar manejadores de mensajes entrantes
        this._registerEvents();
    }

    /**
     * Almacenamiento distribuido en S3 (sin cambios).
     */
    async _useDistributedAuthState(storage, sessionFolder) {
        const writeData = async (data, file) => {
            await storage.uploadFile(
                Buffer.from(JSON.stringify(data, null, 2)),
                                     `${sessionFolder}/${file}.json`,
                                     'application/json'
            );
        };

        const readData = async (file) => {
            try {
                const buffer = await storage.downloadFile(`${sessionFolder}/${file}.json`);
                return JSON.parse(buffer.toString('utf-8'));
            } catch {
                return null;
            }
        };

        const removeData = async (file) => {
            await storage.deleteFile(`${sessionFolder}/${file}.json`);
        };

        const creds = (await readData('creds')) || {
            noiseKey: { private: null, public: null },
            signedIdentityKey: { private: null, public: null },
            signedPreKey: { keyPair: { private: null, public: null }, signature: null, keyId: null },
            registrationId: 0,
            advSecretKey: null,
            nextPreKeyId: 1,
            firstUnuploadedPreKeyId: 1,
            accountSyncCounter: 0,
            accountSettings: { unarchiveChats: false },
            deviceId: '',
            phoneId: '',
            identityId: '',
            registered: false,
            backupToken: '',
            latestExactMessageId: '',
            latestMessageId: '',
            routingInfo: null,
        };

        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const data = {};
                        await Promise.all(
                            ids.map(async id => {
                                let value = await readData(`${type}-${id}`);
                                if (type === 'app-state-sync-key' && value && value.keyData) {
                                    value = { ...value, keyData: Buffer.from(value.keyData, 'base64') };
                                }
                                data[id] = value;
                            })
                        );
                        return data;
                    },
                    set: async (data) => {
                        const tasks = [];
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id];
                                const file = `${category}-${id}`;
                                tasks.push(value ? writeData(value, file) : removeData(file));
                            }
                        }
                        await Promise.all(tasks);
                    }
                }
            },
            saveCreds: () => writeData(creds, 'creds')
        };
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

        let avatarUrl = null;
        try {
            avatarUrl = await this.sock.profilePictureUrl(authorId, 'image');
        } catch (error) {
            this.logger.debug(`[${this.platformName}] No se pudo obtener avatar para ${authorId}: ${error.message}`);
        }

        const messageType = Object.keys(msg.message)[0];
        const msgContent = msg.message[messageType];

        let text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msgContent?.caption || '';

        const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        mentionedJids.forEach(jid => {
            const phone = jid.split('@')[0];
            const regex = new RegExp(`@${phone}`, 'g');
            text = text.replace(regex, `@Usuario_${phone.slice(-4)}`);
        });

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
                avatar: avatarUrl
            },
            body: { text, attachments },
            replyTo: replyData,
            correlationId: this.context.logger.getCorrelationId(),
                                        trace_path: [`${this.platformName}:${chanId}`]
        });

        this.emitIngress(envelope);
    }

    async processEgress(envelope) {
        // Defensa perimetral: Si el socket no está inicializado, ignoramos silenciosamente el trabajo.
        if (!this.sock) {
            this.logger.debug(`[${this.platformName}] Trabajo Egress descartado. Socket inactivo.`);
            return; // Retorno temprano sin error, BullMQ da el trabajo por completado.
        }

        return this.breaker.fire(async () => {
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
