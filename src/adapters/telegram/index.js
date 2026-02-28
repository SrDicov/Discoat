// src/adapters/telegram/index.js
import { Bot, InputFile } from 'grammy';
import { run } from '@grammyjs/runner';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

/**
 * Adaptador modular para Telegram.
 * Implementa el patrón Microkernel, conectándose al bus central mediante UMF.
 * Utiliza @grammyjs/runner para absorber alta concurrencia mediante Long Polling
 * y mitigar errores 409 Conflict en arquitecturas balanceadas.
 */
export default class TelegramAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'telegram';
        this.bot = null;
        this.runner = null;
    }

    /**
     * Fase de Inicialización: Prepara el cliente y hereda las colas.
     * @param {Object} context - Contexto compartido (logger, config, etc.)
     * @returns {Promise<void>}
     */
    async init(context) {
        await super.init(context);
    }

    /**
     * Define las opciones de contención de tráfico para evitar sanciones de Telegram.
     * Telegram Bot API estipula un límite estricto aproximado de 30 msgs/seg globales
     * y 1 msg/seg por canal individual.
     * @returns {Object} Configuración de concurrencia y rate limiting.
     */
    getRateLimitConfig() {
        return {
            concurrency: 5,
            rateLimit: { max: 30, duration: 1000 }
        };
    }

    /**
     * Fase de Ejecución: Conecta el bot utilizando el entorno de ejecución multihilo.
     * @returns {Promise<void>}
     * @throws {Error} Si no hay token o falla la conexión inicial.
     */
    async start() {
        const token = this.config.tokens?.telegram;
        if (!token) {
            this.logger.warn(`[${this.platformName}] Token no configurado. El adaptador permanecerá inactivo.`);
            return;
        }

        try {
            this.bot = new Bot(token);
            this._registerEvents();

            // Iniciar utilizando grammY runner para asimilar la cola de actualizaciones
            // concurrentemente sin saturar el Event Loop principal (Evita bloqueos secuenciales).
            this.runner = run(this.bot);

            // Verificar que el token es válido obteniendo la información del bot
            await this.bot.api.getMe().then(me => {
                this.logger.info(`[${this.platformName}] Conectado exitosamente y Runner activo como @${me.username}`);
            });
        } catch (error) {
            this.logger.error(`[${this.platformName}] Fallo crítico al arrancar la instancia:`, { error: error.message });
            throw error;
        }
    }

    /**
     * Fase de Destrucción: Apagado Elegante (Graceful Shutdown) del sondeo y conexiones activas.
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.runner && this.runner.isRunning()) {
            this.logger.info(`[${this.platformName}] Deteniendo orquestador de Long Polling (grammY runner)...`);
            await this.runner.stop();
        }
    }

    /**
     * Reporte de estado telemetría.
     * @returns {Object} Estado actual del adaptador.
     */
    health() {
        return {
            platform: this.platformName,
            status: this.runner?.isRunning() ? 'connected' : 'disconnected',
            breaker: this.breaker ? this.breaker.getSnapshot() : null
        };
    }

    /**
     * Registra los oyentes nativos de Telegram, interceptando flujos para transformarlos a UMF.
     * @private
     */
    _registerEvents() {
        // Barrera de contención global para evitar el colapso del proceso Node
        // Captura cualquier error no manejado dentro de los handlers de grammY.
        this.bot.catch((err) => {
            const e = err.error;
            // Evasión preventiva de colisiones de sondeo (Long Polling 409)
            // Cuando múltiples instancias intentan hacer polling con el mismo token,
            // Telegram lanza 409 Conflict. Detenemos el runner inmediatamente para
            // evitar que la instancia actual siga compitiendo.
            if (e.message && e.message.includes('409 Conflict')) {
                this.logger.error(`[${this.platformName}] Conflicto 409 detectado (Múltiples instancias sondeando). Deteniendo runner de inmediato para estabilizar la red.`, { error: e.message });
                if (this.runner) this.runner.stop();
            } else {
                this.logger.error(`[${this.platformName}] Excepción asíncrona dentro del flujo de grammY:`, { error: e.message });
            }
        });

        // Oyente de Ingreso Principal
        this.bot.on('message', async (ctx) => {
            // Propagación transaccional: Aislar el proceso bajo un ID de seguimiento (Trace ID) nativo
            this.context.logger.withCorrelation({ source: this.platformName }, async () => {
                await this._handleIngress(ctx);
            });
        });
    }

    /**
     * Analiza el evento entrante, empaqueta su naturaleza heterogénea
     * en el Formato Universal y emite hacia la topología central.
     * @param {import('grammy').Context} ctx - Contexto del mensaje de Telegram.
     * @returns {Promise<void>}
     * @private
     */
    async _handleIngress(ctx) {
        // Prevención estricta de Bucles y Ecos (Broadcast Storms)
        // Ignoramos mensajes de bots para evitar loops entre adaptadores.
        if (ctx.from.is_bot) return;

        const msg = ctx.message;
        const attachments = [];
        let mainType = UMF_TYPES.TEXT;

        // Abstracción Multimedia (Degradación y Mapeo Canónico)
        if (msg.photo && msg.photo.length > 0) {
            // Telegram provee un arreglo de miniaturas; extraemos siempre la de mayor resolución
            const highRes = msg.photo[msg.photo.length - 1];
            const file = await ctx.api.getFile(highRes.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

            attachments.push({
                id: highRes.file_unique_id,
                url: fileUrl,
                type: UMF_TYPES.IMAGE,
                mimeType: 'image/jpeg', // Telegram siempre entrega fotos como JPEG
                name: `photo-${highRes.file_unique_id}.jpg`,
                size: highRes.file_size || 0
            });
            mainType = UMF_TYPES.IMAGE;
        }
        else if (msg.document || msg.video || msg.sticker || msg.audio || msg.voice) {
            const media = msg.document || msg.video || msg.sticker || msg.audio || msg.voice;
            const file = await ctx.api.getFile(media.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;

            let mediaType = UMF_TYPES.FILE;
            let mimeType = media.mime_type || 'application/octet-stream';

            if (msg.video) mediaType = UMF_TYPES.VIDEO;
            else if (msg.audio || msg.voice) mediaType = UMF_TYPES.AUDIO;
            else if (msg.sticker) {
                mediaType = UMF_TYPES.STICKER;
                // Clasificación interna para el orquestador de transcodificación (TGS requiere Lottie2WebP)
                if (msg.sticker.is_animated) mimeType = 'application/x-tgsticker';
                else if (msg.sticker.is_video) mimeType = 'video/webm';
                else mimeType = 'image/webp'; // Static stickers
            }

            attachments.push({
                id: media.file_unique_id,
                url: fileUrl,
                type: mediaType,
                mimeType: mimeType,
                name: media.file_name || `media-${media.file_unique_id}`,
                size: media.file_size || 0
            });
            mainType = attachments.length > 0 ? mediaType : UMF_TYPES.FILE;
        }

        // Empaquetado Estructural UMF
        const envelope = createEnvelope({
            type: mainType,
            source: {
                platform: this.platformName,
                channelId: String(ctx.chat.id),
                                        userId: String(ctx.from.id),
                                        username: ctx.from.username || ctx.from.first_name || 'Desconocido',
                                        avatar: null // La obtención de avatares cuesta llamadas API pesadas adicionales, se delega al frontend/rutas
            },
            body: {
                text: msg.text || msg.caption || '',
                attachments
            },
            replyTo: msg.reply_to_message ? { parentId: String(msg.reply_to_message.message_id) } : null,
                                        correlationId: this.context.logger.getCorrelationId()
        });

        // Transmisión al gestor de topologías (Router N-a-N)
        this.emitIngress(envelope);
    }

    /**
     * Consumidor Asíncrono Egress (BullMQ -> Telegram API).
     * Toma el paquete neutral UMF y aplica sintaxis inversa para materializarlo.
     * @param {Object} envelope - Envoltorio UMF con datos de salida.
     * @returns {Promise<void>}
     */
    async processEgress(envelope) {
        // Envoltura de alta disponibilidad; interrumpe el flujo si la API externa entra en pánico
        return this.breaker.fire(async () => {
            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            // Identidad original preservada
            const senderName = `${envelope.head.source.username} (${envelope.head.source.platform})`;

            // Construcción del plano visual
            let caption = `<b>${senderName}</b>:\n${envelope.body.text || ''}`.trim();

            // Degradación Elegante por Restricción de Dominio:
            // Los adjuntos en Telegram no permiten leyendas superiores a 1024 caracteres
            const hasAttachments = envelope.body.attachments && envelope.body.attachments.length > 0;
            if (hasAttachments && caption.length > 1024) {
                caption = caption.substring(0, 1020) + '...';
            }

            try {
                if (hasAttachments) {
                    const att = envelope.body.attachments[0]; // Telegram solo permite un adjunto por mensaje
                    const file = new InputFile(att.url || att.localPath);

                    if (att.type === UMF_TYPES.IMAGE) {
                        await this.bot.api.sendPhoto(destChannelId, file, { caption, parse_mode: 'HTML' });
                    }
                    else if (att.type === UMF_TYPES.VIDEO) {
                        await this.bot.api.sendVideo(destChannelId, file, { caption, parse_mode: 'HTML' });
                    }
                    else if (att.type === UMF_TYPES.STICKER) {
                        await this.bot.api.sendSticker(destChannelId, file);
                        // Los Stickers en Telegram no soportan subtítulos integrados, inyectamos un eco textual consecutivo
                        if (envelope.body.text) {
                            await this.bot.api.sendMessage(destChannelId, caption, { parse_mode: 'HTML' });
                        }
                    }
                    else {
                        await this.bot.api.sendDocument(destChannelId, file, { caption, parse_mode: 'HTML' });
                    }
                }
                else {
                    // Rutina para Inyección de Texto Plano o Enlaces
                    await this.bot.api.sendMessage(destChannelId, caption, {
                        parse_mode: 'HTML',
                        link_preview_options: { is_disabled: false }
                    });
                }
            } catch (error) {
                // Estrategia de evasión activa de Blacklisting (Error 429 Too Many Requests)
                if (error.error_code === 429) {
                    const retryAfter = error.parameters?.retry_after || 5;
                    this.logger.warn(`[${this.platformName}] Barrera de contención API golpeada (429). El trabajo se retrocederá durante ${retryAfter}s.`);
                    // Lanzar el error escala la resolución hacia BullMQ, quien usará Exponential Backoff
                }
                throw error;
            }
        });
    }
     }
