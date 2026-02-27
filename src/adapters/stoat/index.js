// src/adapters/stoat/index.js
import { Client } from 'stoat.js';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

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
        const token = this.config.integrations?.stoat;
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
            this.client.logout();
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
            this.logger.info(`[${this.platformName}] Conectado exitosamente como ${this.client.user.username}`);
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
        // Prevención estricta de Bucles: Ignorar mensajes del propio bot o creados vía Masquerade
        if (msg.author?.bot || msg.masquerade) return;

        const attachments = [];

        // Mapeo multimedia usando el proxy Autumn sin descargar buffers en memoria principal
        if (msg.attachments && msg.attachments.length > 0) {
            for (const att of msg.attachments) {
                const fileUrl = `${this.autumnBaseUrl}/attachments/${att._id}/${encodeURIComponent(att.filename)}`;
                attachments.push({
                    id: att._id,
                    url: fileUrl,
                    type: UMF_TYPES.FILE,
                    mimeType: att.metadata?.type || 'application/octet-stream',
                    name: att.filename,
                    size: att.size || 0
                });
            }
        }

        // Resolución del avatar (Fallback a Autumn CDN manual si createFileURL falla)
        let avatarUrl = null;
        if (msg.author?.avatar) {
            avatarUrl = `${this.autumnBaseUrl}/avatars/${msg.author.avatar._id}`;
        }

        // Estructuración Canónica (UMF Envelope)
        const envelope = createEnvelope({
            type: (attachments.length > 0 && !msg.content) ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
                                        source: {
                                            platform: this.platformName,
                                            channelId: msg.channel_id,
                                            userId: msg.author_id,
                                            username: msg.author?.username || 'Unknown',
                                            avatar: avatarUrl
                                        },
                                        body: {
                                            text: msg.content || '',
                                            attachments
                                        },
                                        replyTo: (msg.reply_ids && msg.reply_ids.length > 0) ? { parentId: msg.reply_ids } : null,
                                        correlationId: this.context.logger.getCorrelationId()
        });

        // Emitir al bus para que el Router se encargue
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

            const channel = this.client.channels.get(destChannelId);
            if (!channel) {
                this.logger.warn(`[${this.platformName}] Canal destino no encontrado en caché: ${destChannelId}`);
                return;
            }

            const senderName = `${envelope.head.source.username} (${envelope.head.source.platform})`;
            const avatarUrl = envelope.head.source.avatar || `${this.config.storage?.cdnUrl}/default-avatar.png`;

            // Construir contenido base
            let content = envelope.body.text || '';

            // Degradación Elegante: Añadir enlaces de adjuntos directamente al texto
            if (envelope.body.attachments?.length > 0) {
                content += '\n\n[Archivos adjuntos]:';
                envelope.body.attachments.forEach(att => {
                    content += `\n📎 ${att.name}: ${att.url || att.localPath}`;
                });
            }

            if (!content) content = '*[Mensaje multimedia]*';

            // Parámetros para Masquerade (Suplantación de identidad)
            const masquerade = {
                name: senderName.substring(0, 32), // Stoat tiene límite estricto de nombre
                                 avatar: avatarUrl
            };

            try {
                await channel.sendMessage({
                    content: content,
                    masquerade: masquerade
                });
            } catch (error) {
                // Fallback de rescate: Si falla por avatar inválido (400/403 de Autumn), reintentamos sin el avatar
                if (error?.response?.status === 400 || error?.response?.status === 403) {
                    this.logger.warn(`[${this.platformName}] Envío con Masquerade falló (Avatar rechazado). Ejecutando degradación a solo nombre.`, { error: error.message });
                    await channel.sendMessage({
                        content: content,
                        masquerade: { name: masquerade.name }
                    });
                } else {
                    throw error;
                }
            }
        });
    }
}
