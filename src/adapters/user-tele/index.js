import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES, getPlatformAlias } from '../../core/utils/umf.js';

export default class TelegramUserbotAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'telegram_userbot';
        this.client = null;
    }

    async init(context) {
        await super.init(context);
    }

    // Configuración de limitación para evitar Baneos por Spam (FloodWait)
    getRateLimitConfig() {
        return {
            concurrency: 2, // Más restrictivo que Discord, Telegram banea rápido a los userbots
            rateLimit: { max: 15, duration: 60000 }
        };
    }

    async start() {
        const { apiId, apiHash, sessionString } = this.config.tokens?.telegramUserbot || {};

        if (!apiId || !apiHash) {
            this.logger.warn(`[${this.platformName}] Credenciales MTProto faltantes. Adaptador inactivo.`);
            return;
        }

        // El StringSession guarda el token de autorización (evita pedir código SMS cada vez)
        const stringSession = new StringSession(sessionString || '');
        this.client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 5,
        });

        // Conectar silenciosamente (Asume que sessionString ya es válido)
        await this.client.connect();

        this.logger.info(`[${this.platformName}] Userbot MTProto conectado como cuenta de usuario.`);

        this._registerEvents();
    }

    _registerEvents() {
        // Ingress: Escuchar nuevos mensajes
        this.client.addEventHandler(async (event) => {
            this.context.logger.withCorrelation({ source: this.platformName }, async () => {
                await this._handleIngress(event.message);
            });
        }, new NewMessage({}));
    }

    async _handleIngress(msg) {
        // 🛡️ ANTI-BUCLES CRÍTICO: Ignorar mensajes enviados por nosotros mismos (el propio userbot)
        if (msg.out) return;

        let chanId = null;
        if (msg.peerId) {
            if (msg.peerId.className === 'PeerChannel') {
                chanId = '-100' + msg.peerId.channelId.toString();
            } else if (msg.peerId.className === 'PeerChat') {
                chanId = '-' + msg.peerId.chatId.toString();
            } else if (msg.peerId.className === 'PeerUser') {
                chanId = msg.peerId.userId.toString();
            }
        }
        if (!chanId && msg.chatId) chanId = msg.chatId.toString();
        if (!chanId) return;

        // 🛠️ CORRECCIÓN INGRESS (SOPORTE DE FOROS): Aislar los Topics de Telegram
        if (msg.replyTo && msg.replyTo.forumTopic) {
            // Extraer el ID de la raíz del Tema (Topic ID)
            const topicId = msg.replyTo.replyToTopId || msg.replyTo.replyToMsgId;
            if (topicId) {
                // Creamos un ID compuesto para el enrutador del Microkernel
                chanId = `${chanId}_${topicId}`;
            }
        }

        // 🛠️ Tolerancia a Comunidades y Admins Anónimos
        let authorId = null;
        if (msg.senderId) {
            authorId = msg.senderId.toString();
        } else if (msg.fromId) {
            // Extraer ID nativo desde objetos PeerUser, PeerChat o PeerChannel
            const idObj = msg.fromId.userId || msg.fromId.channelId || msg.fromId.chatId;
            if (idObj) authorId = idObj.toString();
        }

        // Si todo falla (el mensaje es 100% anónimo), usamos el chanId como el autor
        if (!authorId) authorId = chanId;

        let cleanText = msg.message || '';
        const attachments = [];

        // Si hay multimedia, extraemos metadatos básicos (Descargar buffers puros aquí bloquearía el Event Loop)
        if (msg.media) {
            attachments.push({
                id: msg.id.toString(),
                             url: null, // GramJS usa buffers, en el futuro se debe enviar a un Worker Thread para subir a un S3/R2
                             type: UMF_TYPES.FILE,
                             name: `telegram_media_${msg.id}`,
                             // Hack temporal: guardar el objeto de media para que el Worker de Egress lo descargue después
                             _rawMediaObject: msg.media
            });
        }

        // Mapear info del remitente
        const sender = await msg.getSender();
        const username = sender?.username || sender?.firstName || 'Usuario TG';

        const envelope = createEnvelope({
            type: (attachments.length > 0 && !cleanText) ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
                                        source: {
                                            platform: this.platformName,
                                            channelId: chanId,
                                            userId: authorId,
                                            username: username,
                                            avatar: null // Recuperar avatar en GramJS consume API calls extras, se recomienda diferir
                                        },
                                        body: { text: cleanText, attachments },
                                        replyTo: msg.replyToMsgId ? { parentId: msg.replyToMsgId.toString() } : null,
                                        correlationId: this.context.logger.getCorrelationId(),
                                        trace_path: [`${this.platformName}:${chanId}`]
        });

        this.emitIngress(envelope);
    }

    async processEgress(envelope) {
        return this.breaker.fire(async () => {
            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            const alias = getPlatformAlias(envelope.head.source.platform);
            const senderName = `${envelope.head.source.username} (${alias})`;
            let content = `**${senderName}:**\n${envelope.body.text || ''}`;

            // 🛠️ CORRECCIÓN EGRESS: Extracción de Tópicos (Desarmar el ID compuesto)
            let peerEntity;
            let targetTopicId = undefined;

            if (destChannelId.includes('_')) {
                const parts = destChannelId.split('_');
                peerEntity = BigInt(parts[0]); // El Chat ID Base (-100xxxxxxx)
        targetTopicId = parseInt(parts[1], 10); // El Topic ID (ej. 55)
            } else if (/^-?\d+$/.test(destChannelId)) {
                peerEntity = BigInt(destChannelId);
            } else {
                peerEntity = destChannelId; // Fallback usernames
            }

            // 🛡️ ESCUDO ANTI-SNOWFLAKE CON ANCLAJE AL FORO
            let finalReplyTo = targetTopicId; // Por defecto, anclamos el mensaje al Tópico configurado
            const parentId = envelope.head.replyTo?.parentId;

            if (parentId && parentId.length < 12) {
                // Si el mensaje citado proviene del mismo Telegram (ID corto), permitimos citarlo directamente
                finalReplyTo = parseInt(parentId, 10);
            } else if (parentId) {
                this.logger.debug(`[${this.platformName}] Ignorando ID cruzado (${parentId}). Anclando al Topic: ${targetTopicId || 'General'}`);
            }

            try {
                // GramJS usa 'replyTo' para inyectar mensajes en subprocesos/foros
                const sendOptions = { message: content };
                if (finalReplyTo !== undefined) {
                    sendOptions.replyTo = finalReplyTo;
                }

                await this.client.sendMessage(peerEntity, sendOptions);
            } catch (error) {
                this.logger.error(`[${this.platformName}] Fallo al enviar mensaje MTProto`, { error: error.message });
            }
        });
    }
}
