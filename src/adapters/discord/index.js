// src/adapters/discord/index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

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
            intents: [], // Se pueden añadir intents según necesidades futuras
            partials: [Partials.Message, Partials.Channel] // Permite recibir mensajes parciales (no cacheados)
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
            rateLimit: { max: 10, duration: 1000 } // Límite conservador
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
        this.client.once('ready', () => {
            this.logger.info(`[${this.platformName}] Conectado exitosamente como ${this.client.user.tag}`);
        });

        this.client.on('messageCreate', async (msg) => {
            // Ejecutar el procesamiento de Ingress dentro del contexto asíncrono para Trazabilidad (Trace ID)
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
        // Prevención estricta de Bucles y Tormentas de Difusión: Ignorar bots y webhooks
        if (msg.author.bot || msg.webhookId) return;

        // Escudo de Hidratación: Recuperar datos si el mensaje es "partial" (no cacheado)
        if (msg.partial) {
            try {
                await msg.fetch();
            } catch (error) {
                this.logger.error(`[${this.platformName}] Error al hidratar mensaje parcial.`, { error: error.message });
                return;
            }
        }

        // Mapeo de adjuntos evitando Buffers en memoria (se envían URLs transitorias)
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

        // Detección de Stickers de Discord (Especialmente formato Lottie = 3)
        if (msg.stickers && msg.stickers.size > 0) {
            for (const [id, sticker] of msg.stickers) {
                attachments.push({
                    id: sticker.id,
                    url: sticker.url,
                    type: UMF_TYPES.STICKER,
                    // Si es Lottie (3), requerirá transcodificación pesada en los workers
                    mimeType: sticker.format === 3 ? 'application/json+lottie' : 'image/png',
                    name: `${sticker.name}.sticker`
                });
            }
        }

        // Estructuración Canónica (UMF Envelope)
        const envelope = createEnvelope({
            type: attachments.length > 0 && !msg.content ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
            source: {
                platform: this.platformName,
                channelId: msg.channel.id,
                userId: msg.author.id,
                username: msg.author.globalName || msg.author.username,
                avatar: msg.author.displayAvatarURL({ extension: 'png', size: 512 })
            },
            body: {
                text: msg.content,
                attachments
            },
            replyTo: msg.reference ? { parentId: msg.reference.messageId } : null,
            correlationId: this.context.logger.getCorrelationId()
        });

        // Emitir al enrutador central
        this.emitIngress(envelope);
    }

    /**
     * Receptor de trabajos desde BullMQ (Egress).
     * Transforma el objeto UMF al formato propietario de Discord.
     * @param {Object} envelope - Envoltorio UMF con datos de salida.
     * @returns {Promise<void>}
     */
    async processEgress(envelope) {
        // Envolver la ejecución en el Circuit Breaker para tolerar caídas de la API de Discord
        return this.breaker.fire(async () => {
            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            const channel = await this.client.channels.fetch(destChannelId).catch(() => null);
            if (!channel) {
                this.logger.warn(`[${this.platformName}] Canal destino inaccesible o no existe: ${destChannelId}`);
                return;
            }

            // Identidad original abstraída en UMF
            const senderName = `${envelope.head.source.username} (${envelope.head.source.platform})`;
            const avatarUrl = envelope.head.source.avatar || this.config.storage?.cdnUrl + '/default-avatar.png';

            // Preparar el cuerpo del mensaje nativo
            const payload = {
                content: envelope.body.text || undefined,
                files: envelope.body.attachments?.map(att => att.url || att.localPath).filter(Boolean) || []
            };

            // Degradación Elegante: Si el mensaje supera el límite de 2000 caracteres de Discord
            if (payload.content && payload.content.length > 2000) {
                payload.content = payload.content.substring(0, 1996) + '...';
            }

            // Fallback de contenido vacío (Ej: Solo se envió un sticker no soportado)
            if (!payload.content && payload.files.length === 0) {
                payload.content = `*[Contenido multimedia no compatible o vacío]*`;
            }

            // Suplantación de identidad mediante Webhooks para hilos visualmente orgánicos
            if (channel.isTextBased() && !channel.isDMBased()) {
                const webhook = await this._getOrCreateWebhook(channel);
                if (webhook) {
                    await webhook.send({
                        ...payload,
                        username: senderName,
                        avatarURL: avatarUrl,
                        // Prevenir menciones masivas accidentales (Security)
                        allowedMentions: { parse: ['users'] }
                    });
                    return;
                }
            }

            // Fallback: Si no hay webhook o es DM, enviar como Bot embebiendo el nombre del autor
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
        // Intentar obtener de caché en memoria
        if (this.webhookCache.has(channel.id)) {
            return this.webhookCache.get(channel.id);
        }

        // Intentar obtener de caché persistente (Redis/BD) - CORRECCIÓN: Añadido await
        let webhookData = null;
        if (this.context.db && typeof this.context.db.getKV === 'function') {
            try {
                webhookData = await this.context.db.getKV(`webhook:dc:${channel.id}`);
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Error al leer caché persistente para webhook en canal ${channel.id}`, { error: error.message });
            }
        }

        if (webhookData) {
            // Reconstruir objeto webhook a partir de datos guardados (ej. { id, token })
            try {
                const webhook = await this.client.fetchWebhook(webhookData.id, webhookData.token);
                this.webhookCache.set(channel.id, webhook);
                return webhook;
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Webhook persistente no válido, se recreará.`, { error: error.message });
                // Si falla, se procede a crear uno nuevo (eliminar entrada corrupta)
                if (this.context.db && typeof this.context.db.delKV === 'function') {
                    await this.context.db.delKV(`webhook:dc:${channel.id}`).catch(() => {});
                }
            }
        }

        // Si no hay en caché, buscar o crear webhook en Discord
        try {
            const webhooks = await channel.fetchWebhooks();
            let webhook = webhooks.find(wh => wh.token); // Buscar uno utilizable por el bot

            if (!webhook) {
                // Discord limita a 15 webhooks por canal
                if (webhooks.size >= 15) {
                    webhook = webhooks.first(); // Reutilizar el más antiguo
                } else {
                    webhook = await channel.createWebhook({
                        name: 'OpenChat Bridge',
                        reason: 'Generado automáticamente por el Microkernel para interconexión N-a-N'
                    });
                }
            }

            // Guardar en caché en memoria y persistente
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
