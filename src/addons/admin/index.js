// src/addons/admin/index.js
import { randomUUID } from 'node:crypto';

export default class AdminAddon {
    constructor() {
        this.context = null;
        this.commands = ['!ping', '!id', '!bridge', '!link'];
    }

    async init(context) {
        this.context = context;
        this.logger = context.logger;
    }

    async start() {
        this.logger.info('Admin Addon listo. Escuchando comandos.');
        this.context.bus.on('message.ingress', (msg) => this.handleMessage(msg));
    }

    async handleMessage(envelope) {
        const text = envelope.body.text || '';
        if (!text.startsWith('!')) return;

        const args = text.split(' ');
        const command = args[0].toLowerCase();

        this.context.logger.withCorrelation({ source: 'admin' }, async () => {
            if (command === '!ping') {
                await this.reply(envelope, '🏓 Pong! El núcleo está operativo.');
            }
            else if (command === '!id') {
                const { platform, channelId } = envelope.head.source;
                await this.reply(envelope, `🆔 **Info del Canal**\nPlataforma: \`${platform}\`\nID: \`${channelId}\``);
            }
            else if (command === '!bridge') {
                const name = args[1] || 'Puente Genérico';
                const id = randomUUID().split('-')[0];
                this.context.db.createBridge(id, name);
                await this.reply(envelope, `🌉 Puente creado: **${name}** (ID: \`${id}\`)`);
            }
            else if (command === '!link') {
                const bridgeId = args[1];
                if (!bridgeId) return await this.reply(envelope, '❌ Uso: `!link <BRIDGE_ID>`');

                const { platform, channelId } = envelope.head.source;
                this.context.db.linkChannelToBridge(bridgeId, platform, channelId);
                await this.reply(envelope, `🔗 Canal vinculado al puente \`${bridgeId}\`.`);
            }
        });
    }

    async reply(originalEnvelope, text) {
        const response = {
            head: {
                id: randomUUID(),
                correlationId: originalEnvelope.head.correlationId,
                source: { platform: 'system', username: 'System Bot' },
                dest: {
                    platform: originalEnvelope.head.source.platform,
                    channelId: originalEnvelope.head.source.channelId
                }
            },
            body: { text: text, attachments: [] }
        };

        const queueName = `${originalEnvelope.head.source.platform}_out`;
        await this.context.queue.add(queueName, response);
    }

    async stop() {}
    async health() { return { status: 'active' }; }
}
