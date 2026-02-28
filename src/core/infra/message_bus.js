// src/core/infra/message_bus.js
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

/**
 * Abstracción del Sistema Nervioso de la plataforma (Arquitectura Event-Driven).
 * Permite comunicación asíncrona (Pub/Sub) agnóstica entre adaptadores y addons.
 * Soporta modo 'memory' (desarrollo/single-node) y 'redis' (producción/escalabilidad horizontal N-a-N).
 */
export class MessageBus {
    constructor(configInstance, logger) {
        // Asignación directa: consumimos el objeto plano inyectado por el Microkernel
        this.config = configInstance || {};
        this.logger = logger;

        // Bus local basado en memoria
        this.localBus = new EventEmitter();
        // Aumentar el límite para soportar la escucha masiva de múltiples adaptadores sin alertas de Memory Leak
        this.localBus.setMaxListeners(100);

        this.mode = 'memory';
        this.pubClient = null;
        this.subClient = null;
    }

    /**
     * Establece la conexión al bus. Si se define una URL de Redis en la configuración,
     * inicializa el modo clúster distribuido.
     */
    async connect() {
        const redisUrl = this.config.redis?.url;

        if (redisUrl && redisUrl !== 'memory' && this.config.system?.env === 'production') {
            this.mode = 'redis';
            this.logger.info('Inicializando MessageBus en modo Distribuido (Redis Pub/Sub)...');
            await this._initRedis(redisUrl);
        } else {
            this.mode = 'memory';
            this.logger.info('Inicializando MessageBus en modo Local (EventEmitter nativo)...');
        }
    }

    /**
     * Inicializa de forma segura el driver ioredis para escenarios de Alta Disponibilidad.
     */
    async _initRedis(url) {
        return new Promise((resolve, reject) => {
            const redisOptions = {
                // Estrategia de Exponential Backoff para resiliencia de conexión
                retryStrategy: (times) => Math.min(times * 50, 2000),
                           maxRetriesPerRequest: null
            };

            // Redis Pub/Sub requiere conexiones físicamente separadas para emitir y escuchar
            this.pubClient = new Redis(url, redisOptions);
            this.subClient = new Redis(url, redisOptions);

            let readyCount = 0;
            const onReady = () => {
                readyCount++;
                if (readyCount === 2) { // Esperar a que ambos clientes estén listos
                    this._setupRedisRouting();
                    resolve();
                }
            };

            this.pubClient.on('ready', onReady);
            this.subClient.on('ready', onReady);

            this.pubClient.on('error', (err) => {
                this.logger.error('Error de conexión en bus Redis (PubClient):', { error: err });
            });
            this.subClient.on('error', (err) => {
                this.logger.error('Error de conexión en bus Redis (SubClient):', { error: err });
            });
        });
    }

    /**
     * Enruta los mensajes distribuidos en la capa de red hacia el bus de memoria local
     * de la instancia actual del proceso Node.js.
     */
    _setupRedisRouting() {
        this.subClient.on('message', (channel, message) => {
            try {
                const payload = JSON.parse(message);
                // Ejecutar el evento localmente en el contexto de los plugins suscritos
                this.localBus.emit(channel, payload);
            } catch (error) {
                this.logger.error(`Fallo de deserialización en el canal de red: ${channel}`, { error });
            }
        });
    }

    /**
     * Publica un evento en la malla (Fire-and-Forget).
     * Garantiza siempre la existencia de un Correlation ID (Trace ID) para observabilidad.
     *
     * @param {string} event - Nombre del tópico/evento (ej. 'message.ingress')
     * @param {Object} payload - Contenedor de datos (típicamente esquema UMF)
     */
    emit(event, payload = {}) {
        // Extraer o generar el Trace ID. Prioriza contexto inyectado nativamente por AsyncContextFrame
        const correlationId = payload.correlationId
        || (this.logger && this.logger.getCorrelationId())
        || randomUUID();

        const enrichedPayload = { ...payload, correlationId };

        if (this.mode === 'redis') {
            this.pubClient.publish(event, JSON.stringify(enrichedPayload)).catch(err => {
                this.logger.error(`Error emitiendo evento [${event}] a Redis`, { error: err, correlationId });
            });
        } else {
            // En modo memoria, se impone el uso de setImmediate para obligar la salida
            // del marco de ejecución síncrono, simulando el comportamiento asíncrono real de una red y evitando bloqueos.
            setImmediate(() => {
                this.localBus.emit(event, enrichedPayload);
            });
        }
    }

    /**
     * Suscribe un manejador asíncrono a un evento.
     */
    async on(event, handler) {
        this.localBus.on(event, handler);

        if (this.mode === 'redis') {
            try {
                // Informar al clúster de Redis que este nodo escuchará este canal
                await this.subClient.subscribe(event);
            } catch (error) {
                this.logger.error(`Error al suscribir nodo al canal de red [${event}]`, { error });
            }
        }
    }

    /**
     * Escucha un evento por una única vez.
     */
    async once(event, handler) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            handler(...args);
        };
        await this.on(event, wrapper);
    }

    /**
     * Remueve la suscripción de un manejador específico.
     */
    async off(event, handler) {
        this.localBus.off(event, handler);

        if (this.mode === 'redis') {
            // Optimización: Solo informar al clúster para desuscribir si ya no quedan listeners locales en esta instancia
            if (this.localBus.listenerCount(event) === 0) {
                try {
                    await this.subClient.unsubscribe(event);
                } catch (error) {
                    this.logger.error(`Error al desuscribir nodo del canal de red [${event}]`, { error });
                }
            }
        }
    }

    /**
     * Apagado elegante de la infraestructura de mensajería (Graceful Shutdown).
     */
    async disconnect() {
        if (this.logger) this.logger.info('Desconectando MessageBus y vaciando listeners de eventos...');

        this.localBus.removeAllListeners();

        if (this.mode === 'redis' && this.pubClient && this.subClient) {
            try {
                await Promise.all([
                    this.pubClient.quit(),
                                  this.subClient.quit()
                ]);
            } catch (error) {
                if (this.logger) this.logger.error('Error cerrando conexiones de Redis en MessageBus', { error });
            }
        }
    }
}
