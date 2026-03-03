// src/adapters/discord/index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES, getPlatformAlias } from '../../core/utils/umf.js';

/**
 * Adaptador modular para Discord.
 * Implementa el patrón Microkernel, conectándose al bus central mediante UMF.
 * Utiliza Webhooks internamente para suplantar la identidad (Masquerading) de
 * usuarios de otras redes en los canales puenteados.
 */
export default class DiscordAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'discord';
        this.client = null;
        this.webhookCache = new Map(); // Caché de Webhooks por canal para evitar recreaciones
    }

    /**
     * Fase de Inicialización: Configura el cliente sin conectarlo aún.
     * @param {Object} context - Contexto compartido (logger, config, etc.)
     * @returns {Promise<void>}
     */
    async init(context) {
        await super.init(context);

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ],
            partials: [Partials.Message, Partials.Channel]
        });

        this._registerEvents();
    }

    /**
     * Define las opciones de contención de tráfico para evitar baneos de la API de Discord.
     * @returns {Object} Configuración de concurrencia y rate limiting.
     */
    getRateLimitConfig() {
        return {
            concurrency: 5,
            rateLimit: { max: 10, duration: 1000 }
        };
    }

    /**
     * Fase de Ejecución: Conecta al WebSocket de Discord.
     * @returns {Promise<void>}
     * @throws {Error} Si el token es inválido o falla la conexión.
     */
    async start() {
        const token = this.config.tokens?.discord;
        if (!token) {
            this.logger.warn(`[${this.platformName}] Token no configurado. El adaptador permanecerá inactivo.`);
            return;
        }

        try {
            await this.client.login(token);
        } catch (error) {
            this.logger.error(`[${this.platformName}] Fallo crítico al iniciar sesión:`, { error: error.message });
            throw error;
        }
    }

    /**
     * Fase de Destrucción: Cierre seguro de WebSockets y limpieza de caché.
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.client) {
            this.logger.info(`[${this.platformName}] Desconectando cliente...`);
            this.client.destroy();
            this.webhookCache.clear();
        }
    }

    /**
     * Reporte de estado para el orquestador.
     * @returns {Object} Estado actual del adaptador.
     */
    health() {
        return {
            platform: this.platformName,
            status: this.client?.isReady() ? 'connected' : 'disconnected',
            ping: this.client?.ws?.ping,
            breaker: this.breaker ? this.breaker.getSnapshot() : null
        };
    }

    /**
     * Registra los oyentes nativos de Discord (Ingress).
     * @private
     */
    _registerEvents() {
        this.client.once('clientReady', () => {
            this.logger.info(`[${this.platformName}] Conectado exitosamente como ${this.client.user.tag}`);
        });

        this.client.on('error', (err) => {
            this.logger.error(`[${this.platformName}] Error en la conexión de Discord:`, { error: err.message });
        });

        this.client.on('messageCreate', async (msg) => {
            this.context.logger.withCorrelation({ source: this.platformName }, async () => {
                await this._handleIngress(msg);
            });
        });
    }

    /**
     * Procesa los mensajes entrantes de Discord, los mapea a UMF y los envía al Bus.
     * @param {import('discord.js').Message} msg - Mensaje de Discord.
     * @returns {Promise<void>}
     * @private
     */
    async _handleIngress(msg) {
        if (msg.author.bot || msg.webhookId) return;

        if (msg.partial) {
            try {
                await msg.fetch();
            } catch (error) {
                this.logger.error(`[${this.platformName}] Error al hidratar mensaje parcial.`, { error: error.message });
                return;
            }
        }

        const attachments = [];
        for (const [id, att] of msg.attachments) {
            attachments.push({
                id: att.id,
                url: att.url,
                type: UMF_TYPES.FILE,
                mimeType: att.contentType || 'application/octet-stream',
                name: att.name,
                size: att.size
            });
        }

        if (msg.stickers && msg.stickers.size > 0) {
            for (const [id, sticker] of msg.stickers) {
                attachments.push({
                    id: sticker.id,
                    url: sticker.url,
                    type: UMF_TYPES.STICKER,
                    mimeType: sticker.format === 3 ? 'application/json+lottie' : 'image/png',
                    name: `${sticker.name}.sticker`
                });
            }
        }

        let cleanText = msg.cleanContent || '';

        const customEmojiRegex = /<a?:([a-zA-Z0-9_]+):(\d+)>/g;
        let match;
        while ((match = customEmojiRegex.exec(msg.content)) !== null) {
            const isAnimated = match[0].startsWith('<a:');
            attachments.push({
                id: match[2],
                url: `https://cdn.discordapp.com/emojis/${match[2]}.${isAnimated ? 'gif' : 'png'}`,
                type: UMF_TYPES.STICKER,
                mimeType: `image/${isAnimated ? 'gif' : 'png'}`,
                name: `${match[1]}.${isAnimated ? 'gif' : 'png'}`
            });
            cleanText = cleanText.replace(match[0], '').trim();
        }

        let replyData = null;
        if (msg.reference && msg.reference.messageId) {
            try {
                const parentMsg = await msg.channel.messages.fetch(msg.reference.messageId);
                const parentAtts = [];

                if (parentMsg.attachments.size > 0) {
                    parentMsg.attachments.forEach(att => {
                        parentAtts.push({
                            id: att.id,
                            url: att.url,
                            type: att.contentType?.includes('audio') ? UMF_TYPES.AUDIO : UMF_TYPES.FILE,
                                        mimeType: att.contentType,
                                        name: att.name
                        });
                    });
                }

                replyData = {
                    parentId: parentMsg.id,
                    parentText: parentMsg.content,
                    parentAttachments: parentAtts
                };
            } catch (e) {
                this.context.logger.warn(`[discord] Fallo al hacer fetch del mensaje citado.`);
            }
        }

        const envelope = createEnvelope({
            type: attachments.length > 0 && !cleanText ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
            source: {
                platform: this.platformName,
                channelId: msg.channel.id,
                userId: msg.author.id,
                username: msg.author.globalName || msg.author.username,
                avatar: msg.author.displayAvatarURL({ extension: 'png', size: 512 })
            },
            body: {
                text: cleanText,
                attachments
            },
            replyTo: replyData,
            correlationId: this.context.logger.getCorrelationId(),
                                        trace_path: [`${this.platformName}:${msg.channel.id}`]
        });

        this.emitIngress(envelope);
    }

    /**
     * Receptor de trabajos desde BullMQ (Egress).
     * Transforma el objeto UMF al formato propietario de Discord.
     * @param {Object} envelope - Envoltorio UMF con datos de salida.
     * @returns {Promise<void>}
     */
    async processEgress(envelope) {
        return this.breaker.fire(async () => {
            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            const channel = await this.client.channels.fetch(destChannelId).catch(() => null);
            if (!channel) {
                this.logger.warn(`[${this.platformName}] Canal destino inaccesible o no existe: ${destChannelId}`);
                return;
            }

            // Abreviatura de plataforma
            const alias = getPlatformAlias(envelope.head.source.platform);
            let senderName = `${envelope.head.source.username} (${alias})`;

            // Sanitización básica
            senderName = senderName.replace(/discord/gi, 'DC').replace(/clyde/gi, 'Cld').substring(0, 80);

            // Avatar con fallback público
            let avatarUrl = envelope.head.source.avatar;
            if (!avatarUrl || !avatarUrl.startsWith('http')) {
                avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
            }

            const payload = {
                content: envelope.body.text || undefined,
                files: envelope.body.attachments?.map(att => att.url || att.localPath).filter(Boolean) || []
            };

            if (payload.content && payload.content.length > 2000) {
                payload.content = payload.content.substring(0, 1996) + '...';
            }

            if (!payload.content && payload.files.length === 0) {
                payload.content = `*[Contenido multimedia no compatible o vacío]*`;
            }

            if (channel.isTextBased() && !channel.isDMBased()) {
                const webhook = await this._getOrCreateWebhook(channel);
                if (webhook) {
                    await webhook.send({
                        ...payload,
                        username: senderName,
                        avatarURL: avatarUrl,
                        allowedMentions: { parse: ['users'] }
                    });
                    return;
                }
            }

            payload.content = `**${senderName}:**\n${payload.content || ''}`;
            await channel.send(payload);
        });
    }

    /**
     * Gestor interno de Webhooks (Caché en RAM + persistencia en Redis/BD).
     * @param {import('discord.js').TextChannel} channel - Canal de texto.
     * @returns {Promise<import('discord.js').Webhook|null>} Webhook utilizable o null.
     * @private
     */
    async _getOrCreateWebhook(channel) {
        if (this.webhookCache.has(channel.id)) {
            return this.webhookCache.get(channel.id);
        }

        let webhookData = null;
        if (this.context.db && typeof this.context.db.getKV === 'function') {
            try {
                webhookData = await this.context.db.getKV(`webhook:dc:${channel.id}`);
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Error al leer caché persistente para webhook en canal ${channel.id}`, { error: error.message });
            }
        }

        if (webhookData) {
            try {
                const webhook = await this.client.fetchWebhook(webhookData.id, webhookData.token);
                this.webhookCache.set(channel.id, webhook);
                return webhook;
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Webhook persistente no válido, se recreará.`, { error: error.message });
                if (this.context.db && typeof this.context.db.delKV === 'function') {
                    await this.context.db.delKV(`webhook:dc:${channel.id}`).catch(() => {});
                }
            }
        }

        try {
            const webhooks = await channel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.token);

            if (!webhook) {
                if (webhooks.size >= 15) {
                    webhook = webhooks.first();
                } else {
                    webhook = await channel.createWebhook({
                        name: 'OpenChat Bridge',
                        reason: 'Generado automáticamente por el Microkernel para interconexión N-a-N'
                    });
                }
            }

            this.webhookCache.set(channel.id, webhook);
            if (this.context.db && typeof this.context.db.setKV === 'function') {
                try {
                    await this.context.db.setKV(`webhook:dc:${channel.id}`, { id: webhook.id, token: webhook.token });
                } catch (error) {
                    this.logger.warn(`[${this.platformName}] No se pudo persistir webhook en Redis`, { error: error.message });
                }
            }

            return webhook;
        } catch (error) {
            this.logger.warn(`[${this.platformName}] Imposible gestionar Webhooks en el canal ${channel.id}. Se aplicará Fallback.`, { error: error.message });
            return null;
        }
    }
     }
