// src/adapters/stoat/index.js
import { Client } from 'stoat.js';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES, getPlatformAlias } from '../../core/utils/umf.js';

/**
 * Adaptador modular para la plataforma Stoat (basada en Revolt).
 * Implementa el patrón Microkernel interactuando mediante el formato universal UMF.
 * Soporta "Masquerading" nativo para la suplantación de identidad en puentes N-a-N.
 */
export default class StoatAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'stoat';
        this.client = null;
        this.autumnBaseUrl = 'https://autumn.revolt.chat'; // Proxy CDN nativo de la plataforma
    }

    /**
     * Fase de Inicialización: Prepara el cliente y hereda las colas.
     * @param {Object} context - Contexto compartido (logger, config, etc.)
     * @returns {Promise<void>}
     */
    async init(context) {
        await super.init(context);

        this.client = new Client();
        this._registerEvents();
    }

    /**
     * Define las opciones de contención de tráfico para evitar restricciones de la API de Stoat.
     * @returns {Object} Configuración de concurrencia y rate limiting.
     */
    getRateLimitConfig() {
        return {
            concurrency: 5,
            rateLimit: { max: 5, duration: 1000 } // Límite conservador
        };
    }

    /**
     * Fase de Ejecución: Inicia sesión usando el token provisto.
     * @returns {Promise<void>}
     * @throws {Error} Si el token es inválido o falla la autenticación.
     */
    async start() {
        const token = this.config.tokens?.stoat;
        if (!token) {
            this.logger.warn(`[${this.platformName}] Token no configurado. El adaptador permanecerá inactivo.`);
            return;
        }

        try {
            await this.client.loginBot(token);
        } catch (error) {
            this.logger.error(`[${this.platformName}] Fallo crítico al iniciar sesión:`, { error: error.message });
            throw error;
        }
    }

    /**
     * Fase de Destrucción: Desconexión limpia.
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.client) {
            this.logger.info(`[${this.platformName}] Desconectando cliente...`);

            // CORRECCIÓN: Manejo defensivo según la API de la librería
            if (typeof this.client.disconnect === 'function') {
                this.client.disconnect();
            } else if (typeof this.client.destroy === 'function') {
                this.client.destroy();
            } else if (typeof this.client.logout === 'function') {
                this.client.logout(); // Fallback
            } else {
                this.logger.warn(`[${this.platformName}] No se encontró un método de desconexión conocido. El cliente podría no cerrarse correctamente.`);
            }
        }
    }

    /**
     * Reporte de estado para el orquestador.
     * @returns {Object} Estado actual del adaptador.
     */
    health() {
        return {
            platform: this.platformName,
            status: this.client?.user ? 'connected' : 'disconnected',
            breaker: this.breaker ? this.breaker.getSnapshot() : null
        };
    }

    /**
     * Registra los oyentes de eventos nativos.
     * @private
     */
    _registerEvents() {
        this.client.on('ready', () => {
            this.logger.info(`[${this.platformName}] Conectado exitosamente como ${this.client.user?.username || 'Bot'}`);
        });

        // SOLUCIÓN: Interceptar errores de la librería/WebSocket para evitar un colapso del proceso (Crash)
        this.client.on('error', (err) => {
            this.logger.error(`[${this.platformName}] Error asíncrono en el cliente o WebSocket subyacente:`, {
                error: err.message || 'Error desconocido',
                raw: err
            });
            // El CircuitBreaker o la lógica de reconexión interna de stoat.js deberían manejar el reintento.
        });

        // Soporte dual para retrocompatibilidad con versiones de SDK
        const handleMessage = async (msg) => {
            this.context.logger.withCorrelation({ source: this.platformName }, async () => {
                await this._handleIngress(msg);
            });
        };

        this.client.on('message', handleMessage);
        this.client.on('messageCreate', handleMessage);
    }

    /**
     * Procesa los mensajes entrantes, los mapea a UMF y los emite al bus central.
     * @param {Object} msg - Mensaje nativo de Stoat.
     * @returns {Promise<void>}
     * @private
     */
    async _handleIngress(msg) {
        // Prevención estricta
        if (msg.author?.bot || msg.masquerade || msg.system) return;

        // SOLUCIÓN: Tolerancia a nombres de propiedades (stoat.js usa camelCase)
        const chanId = msg.channelId || msg.channel_id;
        const authorId = msg.authorId || msg.author_id;
        if (!chanId) return;

        const attachments = [];

        if (msg.attachments?.length > 0) {
            for (const att of msg.attachments) {
                const fileUrl = `${this.autumnBaseUrl}/attachments/${att._id}/${encodeURIComponent(att.filename)}`;
                attachments.push({
                    id: att._id,
                    url: fileUrl,
                    type: UMF_TYPES.FILE,
                    mimeType: att.metadata?.type || 'application/octet-stream',
                    name: att.filename
                });
            }
        }

        // SOLUCIÓN EMOJIS: Extraer emojis personalizados de Revolt (:[ULID]:)
        const revoltEmojiRegex = /:([A-Z0-9]{26}):/g;
        let match;
        let cleanText = msg.content || '';
        while ((match = revoltEmojiRegex.exec(msg.content)) !== null) {
            attachments.push({
                id: match[1],
                url: `${this.autumnBaseUrl}/emojis/${match[1]}`,
                type: UMF_TYPES.STICKER,
                mimeType: 'image/png',
                name: `emoji-${match[1]}.png`
            });
            // Eliminar la marca del texto
            cleanText = cleanText.replace(match[0], '').trim();
        }

        // SOLUCIÓN MENCIONES: Reemplazar menciones de usuario en formato <@ULID> por un placeholder legible
        const mentionRegex = /<@([A-Z0-9]{26})>/g;
        while ((match = mentionRegex.exec(msg.content)) !== null) {
            const userId = match[1];
            const lastFour = userId.slice(-4);
            // Reemplazar la mención en el texto con un placeholder
            cleanText = cleanText.replace(match[0], `@usuario_${lastFour}`);
        }

        // Si hay un arreglo de menciones en el mensaje, podríamos intentar resolver nombres reales,
        // pero como fallback usamos el placeholder.

        const envelope = createEnvelope({
            type: (attachments.length > 0 && !cleanText) ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
                                        source: {
                                            platform: this.platformName,
                                            channelId: chanId,
                                            userId: authorId,
                                            username: msg.author?.username || 'Unknown',
                                            avatar: msg.author?.avatar ? `${this.autumnBaseUrl}/avatars/${msg.author.avatar._id}` : null
                                        },
                                        body: { text: cleanText || '', attachments },
                                        replyTo: (msg.reply_ids && msg.reply_ids.length > 0) ? { parentId: msg.reply_ids[0] } : null,
                                        correlationId: this.context.logger.getCorrelationId(),
                                        // RECUPERACIÓN CRÍTICA: Horizonte Dividido
                                        trace_path: [`${this.platformName}:${chanId}`]
        });

        this.emitIngress(envelope);
    }

    /**
     * Transforma el objeto UMF de la cola al formato nativo de Stoat (Masquerading).
     * @param {Object} envelope - Envoltorio UMF con datos de salida.
     * @returns {Promise<void>}
     */
    async processEgress(envelope) {
        return this.breaker.fire(async () => {
            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            // SOLUCIÓN 1: Recuperación de caché dinámica (Prevenir Condición de Carrera)
            let channel = this.client.channels.get(destChannelId);
            if (!channel && typeof this.client.channels.fetch === 'function') {
                try {
                    channel = await this.client.channels.fetch(destChannelId);
                } catch (err) {
                    this.logger.warn(`[${this.platformName}] Fallo al forzar fetch del canal.`);
                }
            }

            if (!channel) {
                // Si aún no está, BullMQ lo reintentará gracias a su Backoff exponencial
                throw new Error(`Canal destino no está listo o no existe: ${destChannelId}`);
            }

            // SOLUCIÓN: Usar abreviatura de plataforma
            const alias = getPlatformAlias(envelope.head.source.platform);
            const senderName = `${envelope.head.source.username} (${alias})`;
            let avatarUrl = envelope.head.source.avatar;

            // Construir contenido base
            let content = envelope.body.text || '';

            // Degradación Elegante de Adjuntos
            if (envelope.body.attachments?.length > 0) {
                content += '\n\n[Archivos adjuntos]:';
                envelope.body.attachments.forEach(att => {
                    content += `\n📎 ${att.name}: ${att.url || att.localPath}`;
                });
            }

            if (!content) content = '*[Mensaje multimedia]*';

            // SOLUCIÓN 2: Masquerade Seguro (Evitar HTTP 400 de Revolt)
            const masquerade = {
                name: senderName.substring(0, 32) // Límite estricto de 32 caracteres
            };

            // Solo añadir el avatar si es una URL pública segura
            if (avatarUrl && avatarUrl.startsWith('http')) {
                masquerade.avatar = avatarUrl;
            }

            try {
                // Intento Principal: Usar suplantación de identidad
                await channel.sendMessage({
                    content: content,
                    masquerade: masquerade
                });
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Fallo en Masquerade. Degradando a mensaje estándar.`, { error: error.message });

                // SOLUCIÓN 3: Fallback de Rescate Absoluto
                try {
                    await channel.sendMessage({
                        content: `**${masquerade.name}**:\n${content}`
                    });
                } catch (fatalError) {
                    throw fatalError; // Que BullMQ lo marque como fallido
                }
            }
        });
    }
}
