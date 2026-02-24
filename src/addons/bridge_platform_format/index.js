export default class FormatBridgeLogic {
    async init(ctx) {
        this.ctx = ctx;
        const platforms = ['whatsapp', 'telegram', 'signal'];

        platforms.forEach(p => {
            ctx.bus.on(`bridge.transform.${p}`, (umf) => {
                const author = umf.head.source.username;
                const plat = umf.head.source.platform.toUpperCase();
                umf.body.text = `*${author} [${plat}]:*\n${umf.body.text}`;
            });
        });
    }
    async start() {}
    async stop() {}
    async health() { return { status: 'active' }; }
}