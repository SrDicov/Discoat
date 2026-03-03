import { Client } from 'stoat.js';
import { BaseAdapter } from '../base.js';
import { createEnvelope, UMF_TYPES, getPlatformAlias } from '../../core/utils/umf.js';

export default class StoatAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'stoat';
        this.client = null;
        this.autumnBaseUrl = 'https://autumn.revolt.chat';
    }

    async init(context) {
        await super.init(context);
        this.client = new Client();
        this._registerEvents();
    }

    getRateLimitConfig() {
        return {
            concurrency: 5,
            rateLimit: { max: 5, duration: 1000 }
        };
    }

    async start() {
        const token = this.config.tokens?.stoat;
        if (!token) {
            this.logger.warn(`[${this.platformName}] Token no configurado. El adaptador permanecerá inactivo.`);
            return;
        }

        try {
            await this.client.loginBot(token);
        } catch (error) {
            this.logger.error(`[${this.platformName}] Fallo crítico al iniciar sesión:`, { error: error.message });
            throw error;
        }
    }

    async stop() {
        if (this.client) {
            this.logger.info(`[${this.platformName}] Desconectando cliente...`);
            if (typeof this.client.disconnect === 'function') {
                this.client.disconnect();
            } else if (typeof this.client.destroy === 'function') {
                this.client.destroy();
            } else if (typeof this.client.logout === 'function') {
                this.client.logout();
            } else {
                this.logger.warn(`[${this.platformName}] No se encontró un método de desconexión conocido.`);
            }
        }
    }

    health() {
        return {
            platform: this.platformName,
            status: this.client?.user ? 'connected' : 'disconnected',
            breaker: this.breaker ? this.breaker.getSnapshot() : null
        };
    }

    _registerEvents() {
        this.client.on('ready', () => {
            this.logger.info(`[${this.platformName}] Conectado exitosamente como ${this.client.user?.username || 'Bot'}`);
        });

        this.client.on('error', (err) => {
            this.logger.error(`[${this.platformName}] Error asíncrono en el cliente:`, {
                error: err.message || 'Error desconocido'
            });
        });

        const handleMessage = async (msg) => {
            this.context.logger.withCorrelation({ source: this.platformName }, async () => {
                await this._handleIngress(msg);
            });
        };

        this.client.on('message', handleMessage);
        this.client.on('messageCreate', handleMessage);
    }

    async _handleIngress(msg) {
        if (msg.author?.bot || msg.masquerade || msg.system) return;

        const chanId = msg.channelId || msg.channel_id;
        const authorId = msg.authorId || msg.author_id;
        if (!chanId) return;

        const attachments = [];
        if (msg.attachments?.length > 0) {
            for (const att of msg.attachments) {
                const fileUrl = `${this.autumnBaseUrl}/attachments/${att._id}/${encodeURIComponent(att.filename)}`;
                attachments.push({
                    id: att._id,
                    url: fileUrl,
                    type: UMF_TYPES.FILE,
                    mimeType: att.metadata?.type || 'application/octet-stream',
                    name: att.filename
                });
            }
        }

        const revoltEmojiRegex = /:([A-Z0-9]{26}):/g;
        let match;
        let cleanText = msg.content || '';
        while ((match = revoltEmojiRegex.exec(msg.content)) !== null) {
            attachments.push({
                id: match[1],
                url: `${this.autumnBaseUrl}/emojis/${match[1]}`,
                type: UMF_TYPES.STICKER,
                mimeType: 'image/png',
                name: `emoji-${match[1]}.png`
            });
            cleanText = cleanText.replace(match[0], '').trim();
        }

        if (msg.mentions && msg.mentions.length > 0) {
            msg.mentions.forEach(mentionedUser => {
                const userId = mentionedUser._id;
                const username = mentionedUser.username || mentionedUser.original_name || 'Usuario';
                const mentionRegex = new RegExp(`<@${userId}>`, 'g');
                cleanText = cleanText.replace(mentionRegex, `@${username}`);
            });
        }

        const envelope = createEnvelope({
            type: (attachments.length > 0 && !cleanText) ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
                                        source: {
                                            platform: this.platformName,
                                            channelId: chanId,
                                            userId: authorId,
                                            username: msg.author?.username || 'Unknown',
                                            avatar: msg.author?.avatar ? `${this.autumnBaseUrl}/avatars/${msg.author.avatar._id}` : null
                                        },
                                        body: { text: cleanText || '', attachments },
                                        replyTo: (msg.reply_ids && msg.reply_ids.length > 0) ? { parentId: msg.reply_ids[0] } : null,
                                        correlationId: this.context.logger.getCorrelationId(),
                                        trace_path: [`${this.platformName}:${chanId}`]
        });

        this.emitIngress(envelope);
    }

    async processEgress(envelope) {
        return this.breaker.fire(async () => {
            const destChannelId = envelope.head.dest?.channelId;
            if (!destChannelId) throw new Error('Destino no especificado en el envelope UMF.');

            let channel = this.client.channels.get(destChannelId);
            if (!channel && typeof this.client.channels.fetch === 'function') {
                try {
                    channel = await this.client.channels.fetch(destChannelId);
                } catch (err) {
                    this.logger.warn(`[${this.platformName}] Fallo al forzar fetch del canal.`);
                }
            }

            if (!channel) {
                throw new Error(`Canal destino no está listo o no existe: ${destChannelId}`);
            }

            const alias = getPlatformAlias(envelope.head.source.platform);
            const senderName = `${envelope.head.source.username} (${alias})`;
            let avatarUrl = envelope.head.source.avatar;

            let content = envelope.body.text || '';
            if (envelope.body.attachments?.length > 0) {
                content += '\n\n[Archivos adjuntos]:';
                envelope.body.attachments.forEach(att => {
                    content += `\n📎 ${att.name}: ${att.url || att.localPath}`;
                });
            }
            if (!content) content = '*[Mensaje multimedia]*';

            const masquerade = {
                name: senderName.substring(0, 32)
            };
            if (avatarUrl && avatarUrl.startsWith('http')) {
                masquerade.avatar = avatarUrl;
            }

            try {
                await channel.sendMessage({
                    content: content,
                    masquerade: masquerade
                });
            } catch (error) {
                this.logger.warn(`[${this.platformName}] Fallo en Masquerade. Degradando a mensaje estándar.`, { error: error.message });
                try {
                    await channel.sendMessage({
                        content: `**${masquerade.name}**:\n${content}`
                    });
                } catch (fatalError) {
                    throw fatalError;
                }
            }
        });
    }
}
