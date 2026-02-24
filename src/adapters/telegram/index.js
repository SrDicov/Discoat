import { Bot, InputFile } from 'grammy';
import { run } from '@grammyjs/runner';
import BaseAdapter from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

export default class TelegramAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'telegram';
        this.bot = null;
        this.runner = null;
    }

    async start() {
        const token = this.context.config.tokens.telegram;
        if (!token) throw new Error('Token de Telegram faltante');

        this.bot = new Bot(token);
        await this.bot.init();

        this.bot.on('message', (ctx) => this._handleIngress(ctx));
        this.bot.catch((err) => this.logger.error('adapter:telegram', 'Polling Error', { error: err }));

        this.runner = run(this.bot);
        this.logger.info('adapter:telegram', `Telegram Runner iniciado (@${this.bot.botInfo.username})`);
    }

    async stop() {
        if (this.runner && this.runner.isRunning()) await this.runner.stop();
    }

    async health() {
        return {
            status: (this.runner && this.runner.isRunning()) ? 'active' : 'inactive',
            botId: this.bot?.botInfo?.id
        };
    }

    async processEgress(envelope) {
        const chatId = envelope.head.dest.channelId;
        const { source } = envelope.head;

        const header = `<b>${source.username}</b> (${source.platform}):\n`;
        const text = envelope.body.text || '';
        const caption = (header + text).slice(0, 1024);

        try {
            if (envelope.body.attachments.length > 0) {
                const att = envelope.body.attachments[0];
                const resource = new InputFile({ url: att.url });

                if (att.type === 'image') {
                    await this.bot.api.sendPhoto(chatId, resource, { caption, parse_mode: 'HTML' });
                } else {
                    await this.bot.api.sendDocument(chatId, resource, { caption, parse_mode: 'HTML' });
                }
            } else {
                await this.bot.api.sendMessage(chatId, header + text, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: false }
                });
            }
        } catch (error) {
            this.logger.error('adapter:telegram', 'Error enviando mensaje', { error });
        }
    }

    async _handleIngress(ctx) {
        if (ctx.from.is_bot) return;

        this.context.logger.withCorrelation({ source: 'telegram' }, async () => {
            const msg = ctx.msg;
            const attachments = [];

            if (msg.photo) {
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                try {
                    const file = await ctx.api.getFile(fileId);
                    const url = `https://api.telegram.org/file/bot${this.context.config.tokens.telegram}/${file.file_path}`;
                    attachments.push({ url, type: 'image' });
                } catch (e) {
                    this.logger.error('adapter:telegram', 'Error obteniendo archivo', { error: e });
                }
            }

            const envelope = createEnvelope({
                type: attachments.length ? UMF_TYPES.IMAGE : UMF_TYPES.TEXT,
                source: {
                    platform: 'telegram',
                    channelId: msg.chat.id.toString(),
                                            userId: msg.from.id.toString(),
                                            username: msg.from.username || msg.from.first_name,
                                            avatar: null
                },
                body: { text: msg.text || msg.caption || '' },
                attachments
            });

            this.context.bus.emit('message.ingress', envelope);
        });
    }
}
