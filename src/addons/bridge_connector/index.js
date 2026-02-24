import { randomUUID, createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export default class BridgeConnector {
    constructor() {
        this.name = 'Bridge Connector';
        this.commands = ['!bridge'];
        this.algorithm = 'aes-256-cbc';
    }

    async init(ctx) { this.ctx = ctx; }

    async start() {
        this.ctx.bus.on('message.ingress', (umf) => this.handleCommand(umf));
    }

    async handleCommand(umf) {
        const text = umf.body.text || '';
        if (!text.startsWith('!bridge connect')) return;

        const args = text.split(' ');
        const { platform, channelId, userId } = umf.head.source;

        const role = await this.ctx.db.getKV(`role:${platform}:${userId}`) || 0;
        if (role < 2) return this._reply(umf, "❌ Permisos insuficientes.");

        if (args.length === 2) {
            const token = this._generateToken(umf);
            await this._reply(umf, `🔑 **Código de Enlace:**\n\`${token}\`\n\nEjecuta esto en el canal destino para unirlo.`);
        } else if (args.length === 3) {
            try {
                const data = this._decryptToken(args[2]);
                let bridgeId = (await this.ctx.db.getChannelLink(data.plat, data.chan))?.bridge_id;

                if (!bridgeId) {
                    bridgeId = randomUUID();
                    this.ctx.db.createBridge(bridgeId, `Red de ${data.plat}`);
                    this.ctx.db.linkChannelToBridge(bridgeId, data.plat, data.chan);
                }

                this.ctx.db.linkChannelToBridge(bridgeId, platform, channelId);
                await this._reply(umf, `✅ **¡Conectado!** Este canal ahora es parte de la red: \`${bridgeId}\``);
            } catch (e) {
                await this._reply(umf, "❌ Código inválido o expirado.");
            }
        }
    }

    _generateToken(umf) {
        const secret = createHash('sha256').update(this.ctx.config.system.nodeId).digest();
        const iv = randomBytes(16);
        const payload = JSON.constData = JSON.stringify({
            plat: umf.head.source.platform,
            chan: umf.head.source.channelId,
            ts: Date.now()
        });
        const cipher = createCipheriv(this.algorithm, secret, iv);
        let encrypted = cipher.update(payload, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return `${iv.toString('hex')}:${encrypted}`;
    }

    _decryptToken(token) {
        const [ivHex, encrypted] = token.split(':');
        const secret = createHash('sha256').update(this.ctx.config.system.nodeId).digest();
        const decipher = createDecipheriv(this.algorithm, secret, Buffer.from(ivHex, 'hex'));
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    }

    async _reply(umf, text) {
        const reply = { ...umf, body: { text }, head: { ...umf.head, dest: umf.head.source } };
        await this.ctx.queue.add(`queue:${umf.head.source.platform}:out`, reply);
    }

    async stop() {}
    async health() { return { status: 'ready' }; }
}