// src/addons/bridge_router/index.js
export default class UniversalRouter {
    constructor() {
        this.ctx = null;
    }

    async init(ctx) {
        this.ctx = ctx;
        this.logger = ctx.logger;
    }

    async start() {
        this.logger.info('Router activo y escuchando message.ingress');
        this.ctx.bus.on('message.ingress', (umf) => this.route(umf));
    }

    async route(umf) {
        try {
            if (!umf.head || !umf.head.source) return;

            const link = this.ctx.db.getChannelLink(umf.head.source.platform, umf.head.source.channelId);
            if (!link) return;

            const targets = this.ctx.db.getBridgeTopology(link.bridge_id);

            for (const target of targets) {
                if (target.platform === umf.head.source.platform && target.native_id === umf.head.source.channelId) continue;

                const outbox = JSON.parse(JSON.stringify(umf));
                outbox.head.dest = {
                    platform: target.platform,
                    channelId: target.native_id,
                    bridgeId: link.bridge_id
                };

                const queueName = `${target.platform}_out`;
                await this.ctx.queue.add(queueName, outbox, { removeOnComplete: true });

                this.logger.debug(`Enrutando mensaje de ${umf.head.source.platform} a ${target.platform}`);
            }
        } catch (error) {
            this.logger.error('Error enrutando mensaje', { error: error.message });
        }
    }

    async stop() {}
    async health() { return { status: 'ok' }; }
}
