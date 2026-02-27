// src/core/infra/queue.js
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

/**
 * Gestor avanzado de colas basado en BullMQ.
 * Centraliza la limitación de tasa (Rate Limiting) dinámica por plataforma
 * y maneja los reintentos automáticos para mitigar errores 429 de APIs externas.
 */
export class QueueManager {
    constructor(configInstance, logger) {
        // Obtenemos la configuración inmutable inyectada por el Kernel
        this.config = configInstance? configInstance.get() : {};
        this.logger = logger;

        // Estructuras de rastreo para evitar la duplicación de hilos
        this.queues = new Map();
        this.workers = new Map();
        this.redisClient = null;
    }

    /**
     * Establece la conexión asíncrona dedicada para las colas.
     * BullMQ requiere maxRetriesPerRequest en null obligatoriamente.
     */
    async connect() {
        if (this.logger) this.logger.info('Inicializando QueueManager (BullMQ)...');

        const redisUrl = this.config.redis?.url  ||  'redis://127.0.0.1:6379';

        return new Promise((resolve) => {
            this.redisClient = new Redis(redisUrl, {
                maxRetriesPerRequest: null,
                // Estrategia de Retroceso (Backoff) progresivo
                retryStrategy: (times) => Math.min(times * 50, 2000)
            });

            let isResolved = false;

            this.redisClient.on('ready', () => {
                if (!isResolved) {
                    if (this.logger) this.logger.info('Conexión nativa de Redis para BullMQ establecida exitosamente.');
                    isResolved = true;
                    resolve();
                }
            });

            this.redisClient.on('error', (err) => {
                if (this.logger) this.logger.error('Fallo de conexión persistente en QueueManager (Redis):', { error: err.message });
            });
        });
    }

    /**
     * Helper interno para abstraer y reutilizar las instancias de Colas de envío.
     *
     * @param {string} queueName - Nombre de la cola (ej. 'discord:out')
     */
    _getQueue(queueName) {
        if (!this.queues.has(queueName)) {
            const queue = new Queue(queueName, { connection: this.redisClient });
            this.queues.set(queueName, queue);
        }
        return this.queues.get(queueName);
    }

    /**
     * Registra un nuevo evento/mensaje en la cola especificada.
     * Asegura políticas estrictas de auto-limpieza para no saturar la memoria RAM.
     *
     * @param {string} queueName - Identificador del destino
     * @param {Object} jobData - Carga útil (habitualmente el Formato Universal de Mensaje UMF)
     * @param {Object} options - Parámetros particulares del trabajo
     */
    async add(queueName, jobData, options = {}) {
        const queue = this._getQueue(queueName);

        // Inyectar o asegurar persistencia del Trace ID transversal
        if (!jobData.correlationId && this.logger) {
            jobData.correlationId = this.logger.getCorrelationId()  ||  randomUUID();
        }

        const defaultOptions = {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            // Eliminación predeterminada para evitar desbordamiento en memoria volátil de Redis
            removeOnComplete: 100,
            removeOnFail: 500
        };

        const mergedOptions = {...defaultOptions,...options };
        return queue.add(queueName, jobData, mergedOptions);
    }

    /**
     * Instancia un Trabajador (Worker) consumidor de cola aplicando
     * restricciones de velocidad para no ser suspendido por los proveedores externos.
     *
     * @param {string} queueName - Cola de la cual extraer trabajos
     * @param {Function} processorFn - Lógica asíncrona de procesamiento a delegar
     * @param {Object} limitOptions - Configuración de contención y cuotas
     */
    process(queueName, processorFn, limitOptions = {}) {
        if (this.workers.has(queueName)) {
            if (this.logger) this.logger.warn(`Intento de duplicación de worker abortado para la cola: [${queueName}]`);
            return;
        }

        const workerOptions = {
            connection: this.redisClient,
            concurrency: limitOptions.concurrency  ||  5
        };

        // Abstracción estricta del limitador global usando algoritmo Token Bucket de BullMQ
        if (limitOptions.rateLimit) {
            workerOptions.limiter = {
                max: limitOptions.rateLimit.max,
                duration: limitOptions.rateLimit.duration
            };
        }

        const worker = new Worker(queueName, async (job) => {
            // Extracción de contexto para observabilidad en el Worker aislado
            const correlationId = job.data.correlationId  ||  job.data.head?.correlationId  ||  job.id;

            if (this.logger) {
                // Inyectar el Correlation ID en el AsyncContextFrame de Node.js 24
                return this.logger.withCorrelation(correlationId, async () => {
                    return processorFn(job);
                });
            } else {
                return processorFn(job);
            }
        }, workerOptions);

        worker.on('failed', (job, err) => {
            if (this.logger) {
                this.logger.error(`Trabajo fallido en cola delegada [${queueName}] (ID: ${job?.id}):`, {
                    error: err.message,
                    stack: err.stack,
                    attemptsMade: job?.attemptsMade
                });
            }
        });

        this.workers.set(queueName, worker);
    }

    /**
     * Cierra de forma ordenada todo el flujo de trabajos y colas,
     * devolviendo los trabajos pendientes a Redis (Graceful Shutdown).
     */
    async disconnect() {
        if (this.logger) this.logger.info('Pausando flujos y desconectando dependencias de QueueManager...');

        try {
            const closePromises = [];

            // Drenado de trabajadores
            for (const worker of this.workers.values()) {
                closePromises.push(worker.close());
            }

            // Cierre de colas emisoras
            for (const queue of this.queues.values()) {
                closePromises.push(queue.close());
            }

            // Garantizar la limpieza de todos sin importar el error individual de uno
            await Promise.allSettled(closePromises);

            if (this.redisClient) {
                await this.redisClient.quit();
            }
        } catch (error) {
            if (this.logger) this.logger.error('Anomalía técnica al desconectar el cluster de encolado:', { error });
        }
    }
}
