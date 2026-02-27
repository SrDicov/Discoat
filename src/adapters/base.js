// src/adapters/base.js
import { randomUUID } from 'node:crypto';
import { validateEnvelope } from '../core/utils/umf.js';

/**
 * Interfaz base abstracta para los Adaptadores de Red (Plugins).
 * Define el contrato estricto que todas las plataformas (Discord, WhatsApp, Telegram, etc.) deben cumplir.
 * Centraliza la lógica transversal como Limitación de Tasa, Circuit Breakers y Emisión al Bus.
 */
export class BaseAdapter {
    constructor() {
        this.platformName = 'unknown';
        this.context = null;
        this.config = null;
        this.logger = null;
        this.breaker = null; // Instancia de Circuit Breaker para protección API
    }

    /**
     * Inicializa el adaptador inyectando el contenedor de dependencias proxy.
     * Configura automáticamente el consumidor de la cola de salida (Egress Worker).
     *
     * @param {Object} context - Objeto de contexto aislado inyectado por el PluginLoader
     */
    async init(context) {
        this.context = context;
        this.config = context.config;
        this.logger = context.logger;

        // Asigna el nombre de la plataforma desde el registro del plugin si no fue predefinido en la clase hija
        if (this.platformName === 'unknown') {
            this.platformName = context.pluginName || 'unknown';
        }

        // 1. Inicializar Circuit Breaker para las llamadas a la API de esta red externa
        if (this.context.circuitBreaker) {
            this.breaker = this.context.circuitBreaker.get(`${this.platformName}_api`, this.getCircuitBreakerConfig());
        }

        // 2. Registrar el Worker de BullMQ para procesar el flujo Egress asíncronamente
        if (this.context.queue) {
            const queueName = `queue_${this.platformName}_out`;
            const limitOptions = this.getRateLimitConfig();

            // El QueueManager envuelve automáticamente esta función con el CorrelationID (Trace ID)
            this.context.queue.process(queueName, async (job) => {
                const envelope = job.data;

                // Validación del contrato antes de procesamiento pesado (Fail-fast)
                if (!validateEnvelope(envelope)) {
                    throw new Error(`[${this.platformName}] Envelope UMF inválido descartado en Egress Queue.`);
                }

                await this.processEgress(envelope);
            }, limitOptions);

            if (this.logger) {
                this.logger.debug(`Worker Egress registrado y escuchando la cola: [${queueName}]`);
            }
        }

        if (this.logger) this.logger.info(`Adaptador base inicializado estructuralmente: [${this.platformName}]`);
    }

    /**
     * Helper centralizado para emitir mensajes entrantes (Ingress) al bus del sistema.
     * Realiza una validación esquemática antes de inundar la topología.
     *
     * @param {Object} envelope - Mensaje construido y normalizado con UMF
     */
    emitIngress(envelope) {
        if (!validateEnvelope(envelope)) {
            if (this.logger) this.logger.warn(`[${this.platformName}] Intento de emitir un evento UMF inválido hacia el bus abortado.`);
            return;
        }

        if (this.context && this.context.bus) {
            this.context.bus.emit('message.ingress', envelope);
        }
    }

    /**
     * Orquestador para descarga y transcodificación de multimedia (Stickers, imágenes).
     * Delega la lógica de in-memory processing a los Worker Threads de la capa Storage.
     */
    async persistAttachment(url, type, optimizeFor = null) {
        if (!this.context ||!this.context.storage) {
            return this._createFallbackAttachment(url, type);
        }

        try {
            // Se le solicita al storage central descargar y transformar el recurso (ej. TGS a WebP)
            const mediaMeta = await this.context.storage.fetchAndProcessMedia(url, {
                type,
                optimizeFor: optimizeFor || this.platformName
            });
            return mediaMeta;
        } catch (error) {
            if (this.logger) {
                this.logger.warn(`[${this.platformName}] Error persistiendo adjunto. Ejecutando Degradación Elegante a enlace en crudo.`, { url, error: error.message });
            }
            return this._createFallbackAttachment(url, type);
        }
    }

    /**
     * Mapeo descendente en caso de fallo en la red o dependencias faltantes.
     */
    _createFallbackAttachment(url, type) {
        return {
            id: randomUUID(),
            url: url,
            type: type || 'file',
            mimeType: 'application/octet-stream',
            size: 0,
            name: `fallback-${Date.now()}.bin`
        };
    }

    /**
     * Configuración del Limitador de Tasa (Rate Limiting).
     * Diseñado para ser sobreescrito (Overridden) por clases hijas.
     */
    getRateLimitConfig() {
        return {
            concurrency: 5 // Default: Hasta 5 peticiones simultáneas, sin restricción por tiempo estricta
        };
    }

    /**
     * Configuración del Patrón Cortocircuito.
     * Diseñado para ser sobreescrito (Overridden) por clases hijas.
     */
    getCircuitBreakerConfig() {
        return {
            failureThreshold: 5,
            resetTimeout: 30000, // 30s de penalización
            requestTimeout: 10000 // Timeout agresivo de 10s para prevenir bloqueos de conectividad
        };
    }

    // =====================================================================
    // MÉTODOS ABSTRACTOS: OBLIGATORIAMENTE IMPLEMENTADOS POR LA CLASE HIJA
    // =====================================================================

    /**
     * Conecta con la plataforma de destino (Login en Discord, WS en WhatsApp, etc.)
     */
    async start() {
        throw new Error(`[${this.platformName}] El método abstracto start() no ha sido implementado.`);
    }

    /**
     * Finaliza la conexión de forma limpia liberando puertos y WebSockets (Graceful Shutdown).
     */
    async stop() {
        throw new Error(`[${this.platformName}] El método abstracto stop() no ha sido implementado.`);
    }

    /**
     * Lógica de traducción inversa: Convierte UMF a las llamadas API nativas de la plataforma externa.
     * @param {Object} envelope - Mensaje unificado UMF extraído de la cola.
     */
    async processEgress(envelope) {
        throw new Error(`[${this.platformName}] El método abstracto processEgress(envelope) no ha sido implementado.`);
    }

    /**
     * Suministra telemetría de vida del módulo para métricas del orquestador.
     */
    health() {
        return {
            platform: this.platformName,
            status: 'unimplemented',
            breaker: this.breaker? this.breaker.getSnapshot() : null
        };
    }
}
