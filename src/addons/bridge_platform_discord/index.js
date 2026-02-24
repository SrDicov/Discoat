export default class DiscordBridgeLogic {
    async init(ctx) {
        this.ctx = ctx;
        ctx.bus.on('bridge.transform.discord', (umf) => {
            const originalName = umf.head.source.username;
            const originalPlatform = umf.head.source.platform.toUpperCase();
            umf.head.source.username = `${originalName} · ${originalPlatform}`;
        });
    }
    async start() {}
    async stop() {}
    async health() { return { status: 'active' }; }
}