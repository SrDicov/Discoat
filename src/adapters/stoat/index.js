import { Client } from 'stoat.js';
import BaseAdapter from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

export default class StoatAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'stoat';
        this.client = null;
    }

    async start() {
        const token = this.context.config.tokens.stoat;
        this.client = new Client();

        this.client.on('ready', () => this.logger.info('Stoat conectado.'));
        this.client.on('message', (m) => this._handleIngress(m));

        await this.client.loginBot(token);
    }

    async stop() {
        if (this.client) this.client.disconnect();
    }

    async processEgress(envelope) {
        const channelId = envelope.head.dest.channelId;
        const { source } = envelope.head;
        const { text, attachments } = envelope.body;

        const payload = {
            content: text,
            masquerade: {
                name: `${source.username} · ${source.platform}`,
                avatar: source.avatar
            },
            attachments: attachments.map(a => a.url)
        };

        const channel = await this.client.channels.fetch(channelId);
        await channel.sendMessage(payload);
    }

    async _handleIngress(msg) {
        if (msg.author.bot || msg.masquerade) return;

        this.context.logger.withCorrelation({ source: 'stoat' }, async () => {
            const envelope = createEnvelope({
                type: UMF_TYPES.TEXT,
                source: {
                    platform: 'stoat',
                    channelId: msg.channelId,
                    userId: msg.author.id,
                    username: msg.author.username,
                    avatar: msg.author.avatar?.url
                },
                body: { text: msg.content },
                attachments: msg.attachments?.map(a => ({ url: a.url, type: 'file' })) || []
            });

            this.context.bus.emit('message.ingress', envelope);
        });
    }
}