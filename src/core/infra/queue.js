import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

export default class QueueService {
    constructor(context) {
        this.context = context;
        this.config = context.config;
        this.logger = context.logger;

        this.queues = new Map();
        this.workers = new Map();
        this.redisConnection = null;
    }

    async init() {
        const redisUrl = this.config.redis?.url || 'redis://127.0.0.1:6379';
        const safeUrl = redisUrl.replace(/:([^@]+)@/, ':***@');

        this.logger.info({ section: 'infra:queue', url: safeUrl }, 'Conectando a Redis...');

        this.redisConnection = new IORedis(redisUrl, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: true,
            retryStrategy(times) {
                const delay = Math.min(times * 50, 2000);
                return delay;
            }
        });

        this.redisConnection.on('error', (err) => {
            this.logger.warn({ section: 'infra:queue', error: err.message }, 'Evento de error en Redis (no crítico)');
        });

        try {
            await this.redisConnection.connect();
            await this.redisConnection.ping();
            this.logger.info({ section: 'infra:queue' }, 'Redis conectado y listo.');
        } catch (error) {
            if (error.message.includes('ENOTFOUND')) {
                this.logger.error({ section: 'infra:queue' }, '❌ ERROR DNS REDIS: El host no existe.');
                this.logger.error({ section: 'infra:queue' }, '💡 SOLUCIÓN: Verifica config/main.js o tu .env. Si estás en local, usa "127.0.0.1". Si estás en Docker, usa el nombre del servicio.');
            } else if (error.message.includes('ECONNREFUSED')) {
                this.logger.error({ section: 'infra:queue' }, '❌ ERROR CONEXIÓN REDIS: Conexión rechazada.');
                this.logger.error({ section: 'infra:queue' }, '💡 SOLUCIÓN: ¿Está corriendo el servidor de Redis? (sudo service redis-server start)');
            }
            throw new Error(`Fallo crítico Redis: ${error.message}`);
        }
    }

    async add(queueName, data, options = {}) {
        const queue = this._getQueue(queueName);

        const defaultOptions = {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: 100,
            removeOnFail: 500
        };

        return await queue.add('process', data, { ...defaultOptions, ...options });
    }

    process(queueName, processorFn, limitOptions = null) {
        if (this.workers.has(queueName)) return;

        const workerOptions = {
            connection: this.redisConnection,
            concurrency: limitOptions?.concurrency || 5,
            limiter: limitOptions?.rateLimit ? {
                max: limitOptions.rateLimit.max,
                duration: limitOptions.rateLimit.duration
            } : undefined
        };

        const worker = new Worker(queueName, async (job) => {
            const traceId = job.data?.head?.correlationId || `job-${job.id}`;

            return this.logger.withCorrelation({ correlationId: traceId, source: `worker:${queueName}` }, async () => {
                try {
                    await processorFn(job.data);
                } catch (err) {
                    this.logger.error({ section: 'infra:queue', error: err.message }, `Error procesando job en ${queueName}`);
                    throw err;
                }
            });
        }, workerOptions);

        worker.on('failed', (job, err) => {
            this.logger.warn({ section: 'infra:queue', jobId: job.id, error: err.message }, `Job falló en ${queueName}`);
        });

        this.workers.set(queueName, worker);
    }

    async stop() {
        this.logger.info({ section: 'infra:queue' }, 'Deteniendo colas y workers...');
        const closePromises = [];

        for (const worker of this.workers.values()) closePromises.push(worker.close());
        for (const queue of this.queues.values()) closePromises.push(queue.close());

        await Promise.allSettled(closePromises);

        if (this.redisConnection) {
            try {
                await this.redisConnection.quit();
            } catch (e) {
                // ignore
            }
        }
    }

    _getQueue(name) {
        if (!this.queues.has(name)) {
            const queue = new Queue(name, { connection: this.redisConnection });
            this.queues.set(name, queue);
        }
        return this.queues.get(name);
    }
}
