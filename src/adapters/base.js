export default class BaseAdapter {
    constructor() {
        this.context = null;
        this.config = null;
        this.logger = null;
        this.platformName = 'unknown';
    }

    async init(context) {
        this.context = context;
        this.config = context.config;
        this.logger = context.logger;

        if (this.context.queue) {
            this.context.queue.process(
                `${this.platformName}_out`,
                (job) => this.processEgress(job),
                                       this.getRateLimitConfig()
            );
        }
    }

    async start() { throw new Error('Method start() not implemented'); }
    async stop() { throw new Error('Method stop() not implemented'); }
    async processEgress(envelope) { throw new Error('Method processEgress() not implemented'); }

    getRateLimitConfig() { return null; }

    async persistAttachment(url, type) {
        try {
            return await this.context.storage.storeFromUrl(url, { type });
        } catch (err) {
            this.logger.warn(`Error persistiendo adjunto`, { url, error: err.message });
            return { url, type, mime: 'application/octet-stream' };
        }
    }
}
