import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import BaseAdapter from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';
import path from 'node:path';
import process from 'node:process';

export default class WhatsAppAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'whatsapp';
        this.sock = null;
    }

    async start() {
        const authPath = path.resolve(process.cwd(), 'data', 'auth_whatsapp');
        this.logger.info('adapter:whatsapp', `Guardando sesión en ${authPath}`);

        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['OpenChat', 'Linux', '2.0.0'],
            syncFullHistory: false,
            connectTimeoutMs: 60000,
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.logger.info('adapter:whatsapp', '⚠️ ESCANEA ESTE QR PARA CONECTAR WHATSAPP:');
                console.log(qr);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
                this.logger.warn('adapter:whatsapp', `Desconectado. Reconectando: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => this.start(), 3000);
                }
            } else if (connection === 'open') {
                this.logger.info('adapter:whatsapp', '¡Conexión establecida!');
            }
        });

        this.sock.ev.on('messages.upsert', (m) => this._handleIngress(m));
    }

    async stop() {
        if (this.sock) this.sock.end(undefined);
    }

    async health() {
        return { status: this.sock ? 'active' : 'inactive' };
    }

    getRateLimitConfig() {
        return { max: 5, duration: 2000 };
    }

    async processEgress(envelope) {
        const targetJid = envelope.head.dest.channelId;
        const { source } = envelope.head;
        const body = envelope.body;

        let text = `*${source.username}*: ${body.text}`;
        await this.sock.sendPresenceUpdate('composing', targetJid);

        if (body.attachments.length > 0) {
            const att = body.attachments[0];
            const msgContent = {};

            if (att.type === 'image') msgContent.image = { url: att.url };
            else if (att.type === 'video') msgContent.video = { url: att.url };
            else msgContent.document = { url: att.url, mimetype: att.mime, fileName: att.name };

            msgContent.caption = text;
            await this.sock.sendMessage(targetJid, msgContent);
        } else {
            await this.sock.sendMessage(targetJid, { text });
        }
    }

    _handleIngress({ messages, type }) {
        if (type !== 'notify') return;
        messages.forEach(msg => {
            if (msg.key.fromMe) return;
            this.context.logger.withCorrelation({ source: 'whatsapp' }, async () => {
                try {
                    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                    const envelope = createEnvelope({
                        type: UMF_TYPES.TEXT,
                        source: {
                            platform: 'whatsapp',
                            channelId: msg.key.remoteJid,
                            userId: msg.key.participant || msg.key.remoteJid,
                            username: msg.pushName || 'WhatsApp User'
                        },
                        body: { text }
                    });
                    this.context.bus.emit('message.ingress', envelope);
                } catch (e) {
                    this.logger.error('adapter:whatsapp', 'Error ingress', { error: e });
                }
            });
        });
    }
}
