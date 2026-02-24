export default class StoatBridgeLogic {
    async init(ctx) {
        this.ctx = ctx;
        ctx.bus.on('bridge.transform.stoat', (umf) => {
            umf.head.source.username = `${umf.head.source.username} [${umf.head.source.platform.toUpperCase()}]`;
        });
    }
    async start() {}
    async stop() {}
    async health() { return { status: 'active' }; }
}