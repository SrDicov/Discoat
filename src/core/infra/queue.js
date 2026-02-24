import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

export default class QueueService {
    constructor(context) {
        this.context = context;
        this.config = context.config;
        this.logger = context.logger;

        this.queues = new Map();
        this.workers = new Map();

        this.redisConnection = new IORedis(this.config.redis?.url || 'redis://localhost:6379', {
            maxRetriesPerRequest: null,
            enableReadyCheck: false
        });
    }

    async init() {
        try {
            await this.redisConnection.ping();
        } catch (error) {
            throw error;
        }
    }

    async add(queueName, data, options = {}) {
        const queue = this._getQueue(queueName);

        const defaultOptions = {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 1000
            },
            removeOnComplete: 100,
            removeOnFail: 500
        };

        const jobOptions = { ...defaultOptions, ...options };

        try {
            const job = await queue.add('process', data, jobOptions);
            return job;
        } catch (error) {
            throw error;
        }
    }

    process(queueName, processorFn, limitOptions = null) {
        if (this.workers.has(queueName)) {
            return;
        }

        const workerOptions = {
            connection: this.redisConnection,
            concurrency: limitOptions ? 1 : 5,
            limiter: limitOptions ? {
                max: limitOptions.max,
                duration: limitOptions.duration
            } : undefined
        };

        const worker = new Worker(queueName, async (job) => {
            const traceId = job.data?.head?.correlationId || 'no-trace';

            return this.context.logger.withCorrelation({ correlationId: traceId, source: 'worker' }, async () => {
                try {
                    await processorFn(job.data);
                } catch (err) {
                    throw err;
                }
            });
        }, workerOptions);

        worker.on('failed', (job, err) => {
        });

        this.workers.set(queueName, worker);
    }

    async stop() {
        const closePromises = [];

        for (const [name, worker] of this.workers) {
            closePromises.push(worker.close());
        }

        for (const [name, queue] of this.queues) {
            closePromises.push(queue.close());
        }

        await Promise.allSettled(closePromises);

        if (this.redisConnection) {
            await this.redisConnection.quit();
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
