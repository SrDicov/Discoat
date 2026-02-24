export default class UniversalRouter {
    constructor() {
        this.name = 'Universal Router';
    }

    async init(ctx) { this.ctx = ctx; }

    async start() {
        this.ctx.bus.on('message.ingress', (umf) => this.route(umf));
    }

    async route(umf) {
        const link = await this.ctx.db.getChannelLink(umf.head.source.platform, umf.head.source.channelId);
        if (!link) return;

        const status = await this.ctx.db.getKV(`status:${link.bridge_id}`) || 'on';
        if (status !== 'on') return;

        const targets = await this.ctx.db.getBridgeTopology(link.bridge_id);

        for (const target of targets) {
            if (target.platform === umf.head.source.platform && target.native_id === umf.head.source.channelId) continue;

            const outbox = JSON.parse(JSON.stringify(umf));
            outbox.head.dest = { platform: target.platform, channelId: target.native_id };

            await this.ctx.bus.emit(`bridge.transform.${target.platform}`, outbox);

            await this.ctx.queue.add(`queue:${target.platform}:out`, outbox);
        }
    }

    async stop() {}
    async health() { return { status: 'active' }; }
}