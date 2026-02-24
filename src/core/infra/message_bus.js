import { EventEmitter } from 'node:events';
import Redis from 'ioredis';

export default class MessageBus {
    constructor(config) {
        this.config = config;
        this.logger = null;
        this.mode = 'memory';

        this.localBus = new EventEmitter();
        this.localBus.setMaxListeners(50);

        this.pubClient = null;
        this.subClient = null;
    }

    async init() {
        if (this.config.redis?.enabled && this.config.redis?.url) {
            this.mode = 'redis';
            await this._initRedis();
        } else {
            this.mode = 'memory';
        }
    }

    async close() {
        if (this.mode === 'redis') {
            await this.pubClient.quit();
            await this.subClient.quit();
        }
        this.localBus.removeAllListeners();
    }

    async emit(channel, payload = {}) {
        if (!payload._meta) payload._meta = {};

        if (!payload._meta.correlationId) {
            payload._meta.correlationId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
        }

        if (this.mode === 'redis') {
            try {
                const messageString = JSON.stringify(payload);
                await this.pubClient.publish(channel, messageString);
            } catch (error) {
                throw error;
            }
        } else {
            setImmediate(() => {
                this.localBus.emit(channel, payload);
            });
        }
    }

    async on(channel, handler) {
        if (this.mode === 'redis') {
            try {
                await this.subClient.subscribe(channel);
                this.localBus.on(channel, handler);
            } catch (error) {
            }
        } else {
            this.localBus.on(channel, handler);
        }
    }

    async off(channel, handler) {
        this.localBus.off(channel, handler);

        if (this.mode === 'redis') {
            if (this.localBus.listenerCount(channel) === 0) {
                await this.subClient.unsubscribe(channel);
            }
        }
    }

    async _initRedis() {
        this.pubClient = new Redis(this.config.redis.url, {
            retryStrategy: (times) => Math.min(times * 50, 2000)
        });

        this.subClient = new Redis(this.config.redis.url, {
            retryStrategy: (times) => Math.min(times * 50, 2000)
        });

        return new Promise((resolve, reject) => {
            let connectedCount = 0;
            const checkReady = () => {
                connectedCount++;
                if (connectedCount === 2) {
                    this._setupRedisRouting();
                    resolve();
                }
            };

            this.pubClient.on('ready', checkReady);
            this.subClient.on('ready', checkReady);

            this.pubClient.on('error', (err) => {});
            this.subClient.on('error', (err) => {});
        });
    }

    _setupRedisRouting() {
        this.subClient.on('message', (channel, message) => {
            try {
                const payload = JSON.parse(message);
                this.localBus.emit(channel, payload);
            } catch (err) {
            }
        });
    }
}