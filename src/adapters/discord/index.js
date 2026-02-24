import { Client, GatewayIntentBits, Partials, WebhookClient, EmbedBuilder } from 'discord.js';
import BaseAdapter from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

export default class DiscordAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'discord';
        this.client = null;
    }

    async start() {
        const token = this.context.config.tokens.discord;
        if (!token) throw new Error('Token de Discord no configurado');

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildWebhooks
            ],
            partials: [Partials.Message, Partials.Channel]
        });

        this.client.on('ready', () => this.logger.info(`Conectado como ${this.client.user.tag}`));
        this.client.on('messageCreate', (msg) => this._handleIngress(msg));
        this.client.on('error', (err) => this.logger.error('Gateway Error', { error: err }));

        await this.client.login(token);
    }

    async stop() {
        if (this.client) await this.client.destroy();
    }

    async health() {
        return {
            status: this.client?.isReady() ? 'connected' : 'disconnected',
            ping: this.client?.ws?.ping
        };
    }

    async processEgress(envelope) {
        const { channelId } = envelope.head.dest;
        const channel = await this.client.channels.fetch(channelId).catch(() => null);

        if (!channel) {
            this.logger.warn(`Canal destino inaccesible: ${channelId}`);
            return;
        }

        const sent = await this._sendViaWebhook(channel, envelope);

        if (!sent) {
            await this._sendAsBot(channel, envelope);
        }
    }

    async _handleIngress(msg) {
        if (msg.author.bot || msg.system) return;

        this.context.logger.withCorrelation({ source: 'discord' }, async () => {
            try {
                const attachments = [];
                for (const att of msg.attachments.values()) {
                    const type = att.contentType?.startsWith('image') ? 'image' : 'file';
                    const stored = await this.persistAttachment(att.url, type);
                    stored.name = att.name;
                    attachments.push(stored);
                }

                const envelope = createEnvelope({
                    type: attachments.length > 0 ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
                    source: {
                        platform: 'discord',
                        channelId: msg.channelId,
                        userId: msg.author.id,
                        username: msg.member?.displayName || msg.author.username,
                        avatar: msg.author.displayAvatarURL({ extension: 'png', forceStatic: true })
                    },
                    body: {
                        text: msg.content,
                        raw: msg.content
                    },
                    attachments,
                    replyTo: msg.reference ? await this._resolveReply(msg) : null
                });

                this.context.bus.emit('message.ingress', envelope);

            } catch (error) {
                this.logger.error('Error procesando mensaje entrante', { error });
            }
        });
    }

    async _sendViaWebhook(channel, envelope) {
        let webhookData = this.context.db.getKV(`webhook:dc:${channel.id}`);
        let webhookClient;

        try {
            if (!webhookData) {
                if (channel.permissionsFor(this.client.user).has(GatewayIntentBits.GuildWebhooks)) {
                    const wh = await channel.createWebhook({
                        name: 'OpenChat Bridge',
                        avatar: 'https://i.imgur.com/AfFp7pu.png'
                    });
                    webhookData = { id: wh.id, token: wh.token };
                    this.context.db.setKV(`webhook:dc:${channel.id}`, webhookData);
                } else {
                    return false;
                }
            }

            webhookClient = new WebhookClient(webhookData);

            const { source } = envelope.head;
            await webhookClient.send({
                content: envelope.body.text || undefined,
                username: `${source.username} · ${source.platform}`,
                avatarURL: source.avatar,
                files: envelope.body.attachments.map(a => a.url)
            });
            return true;

        } catch (err) {
            if (err.code === 10015) {
                this.logger.warn(`Webhook inválido en ${channel.id}. Invalidando caché.`);
                this.context.db.setKV(`webhook:dc:${channel.id}`, null);
            }
            return false;
        }
    }

    async _sendAsBot(channel, envelope) {
        const { source } = envelope.head;
        const embed = new EmbedBuilder()
        .setAuthor({ name: `${source.username} (${source.platform})`, iconURL: source.avatar })
        .setDescription(envelope.body.text || '📁 *Adjunto multimedia*')
        .setColor(0x5865F2)
        .setFooter({ text: 'OpenChat Fallback Mode' });

        await channel.send({
            embeds: [embed],
            files: envelope.body.attachments.map(a => a.url)
        });
    }

    async _resolveReply(msg) {
        try {
            const ref = await msg.fetchReference();
            return { id: ref.id, text: ref.content };
        } catch { return null; }
    }
}
