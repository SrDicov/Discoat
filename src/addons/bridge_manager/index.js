export default class BridgeManager {
    constructor() {
        this.name = 'Bridge Manager';
        this.commands = ['!bridge.on', '!bridge.off', '!bridge.status', '!bridge.leave'];
    }

    async init(ctx) { this.ctx = ctx; }

    async start() {
        this.ctx.bus.on('message.ingress', (umf) => this.handle(umf));
    }

    async handle(umf) {
        const cmd = umf.body.text?.split(' ')[0];
        if (!this.commands.includes(cmd)) return;

        const { platform, channelId } = umf.head.source;
        const link = await this.ctx.db.getChannelLink(platform, channelId);
        if (!link) return;

        switch (cmd) {
            case '!bridge.status':
                const topology = await this.ctx.db.getBridgeTopology(link.bridge_id);
                const list = topology.map(t => `• ${t.platform.toUpperCase()}: ${t.native_id}`).join('\n');
                await this._reply(umf, `🌐 **Estado del Puente:**\nID: \`${link.bridge_id}\`\nNodos:\n${list}`);
                break;
            case '!bridge.off':
                await this.ctx.db.setKV(`status:${link.bridge_id}`, 'off');
                await this._reply(umf, "⏸️ Puente pausado para toda la red.");
                break;
            case '!bridge.on':
                await this.ctx.db.setKV(`status:${link.bridge_id}`, 'on');
                await this._reply(umf, "▶️ Puente reactivado.");
                break;
            case '!bridge.leave':
                await this.ctx.db.unlinkChannel(platform, channelId);
                await this._reply(umf, "🔌 Has salido de la red.");
                break;
        }
    }

    async _reply(umf, text) {
        const reply = { ...umf, body: { text }, head: { ...umf.head, dest: umf.head.source } };
        await this.ctx.queue.add(`queue:${umf.head.source.platform}:out`, reply);
    }
    async stop() {}
    async health() { return { status: 'ready' }; }
}