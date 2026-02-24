import { createHash } from 'node:crypto';

export default class BridgeDedup {
    async init(ctx) {
        this.ctx = ctx;
        this.cache = new Map();
        this.cleanupInterval = setInterval(() => this.cache.clear(), 300000);
    }

    async start() {
        this.ctx.bus.on('message.ingress', async (umf) => {
            const hash = createHash('sha256')
            .update(`${umf.body.text}:${umf.head.source.userId}:${umf.head.source.channelId}`)
            .digest('hex');

            if (this.cache.has(hash)) {
                umf._isDuplicate = true;
                return;
            }
            this.cache.set(hash, Date.now());
        });
    }

    async stop() {
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        this.cache.clear();
    }

    async health() {
        return { status: 'active', cacheSize: this.cache.size };
    }
}
