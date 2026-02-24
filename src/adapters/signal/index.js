import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import BaseAdapter from '../base.js';
import { createEnvelope, UMF_TYPES } from '../../core/utils/umf.js';

export default class SignalAdapter extends BaseAdapter {
    constructor() {
        super();
        this.platformName = 'signal';
        this.client = null;
        this.daemon = null;
        this.buffer = '';
        this.signalHost = '127.0.0.1';
        this.signalPort = 8080;
    }

    async start() {
        const botNumber = this.config.tokens?.signal?.phone;
        if (!botNumber) {
            throw new Error('Número de teléfono de Signal no encontrado en tokens.signal.phone');
        }

        this.daemon = spawn('signal-cli', [
            '-u', botNumber,
            'daemon',
            '--tcp', `${this.signalHost}:${this.signalPort}`
        ]);

        this.daemon.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg.includes('Error') || msg.includes('Exception')) {
            }
        });

        await new Promise(resolve => setTimeout(resolve, 3000));
        await this._connectSocket(botNumber);
    }

    async stop() {
        if (this.client) this.client.destroy();
        if (this.daemon) this.daemon.kill();
    }

    async processEgress(envelope) {
        const botNumber = this.config.tokens.signal.phone;
        const { channelId } = envelope.head.dest;
        const { text, attachments } = envelope.body;

        const formatted = this._formatText(text);

        const params = {
            account: botNumber,
            message: formatted.text,
            textStyles: formatted.textStyles
        };

        if (channelId.startsWith('group.')) {
            params.groupId = channelId;
        } else {
            params.recipient = [channelId];
        }

        if (attachments && attachments.length > 0) {
            params.attachments = attachments.map(a => a.localPath).filter(Boolean);
        }

        const request = {
            jsonrpc: "2.0",
            method: "send",
            params,
            id: envelope.head.id
        };

        this._sendRaw(request);
    }

    async _connectSocket(botNumber) {
        this.client = new net.Socket();

        this.client.connect(this.signalPort, this.signalHost, () => {
            this._sendRaw({
                jsonrpc: "2.0",
                method: "receive",
                params: { account: botNumber },
                id: "init-sub"
            });
        });

        this.client.on('data', (data) => this._onSocketData(data));
        this.client.on('error', (err) => {});
        this.client.on('close', () => {
            setTimeout(() => this._connectSocket(botNumber), 5000);
        });
    }

    _onSocketData(data) {
        this.buffer += data.toString();
        let boundary = this.buffer.indexOf('\n');

        while (boundary !== -1) {
            const input = this.buffer.substring(0, boundary);
            this.buffer = this.buffer.substring(boundary + 1);

            if (input.trim()) {
                try {
                    const json = JSON.parse(input);
                    if (json.method === 'receive') this._handleIngress(json);
                } catch (e) {
                }
            }
            boundary = this.buffer.indexOf('\n');
        }
    }

    async _handleIngress(msg) {
        const envelope = msg.params?.envelope;
        if (!envelope?.dataMessage) return;

        const dataMsg = envelope.dataMessage;
        const sender = envelope.sourceUuid || envelope.source;

        this.context.logger.withCorrelation({ source: 'signal' }, async () => {
            try {
                const attachments = [];
                if (dataMsg.attachments) {
                    for (const att of dataMsg.attachments) {
                        const type = att.contentType?.split('/')[0] || 'file';
                        if (att.storedFilename) {
                            const stored = await this.context.storage.storeFromUrl(`file://${att.storedFilename}`, { type });
                            attachments.push(stored);
                        }
                    }
                }

                const umf = createEnvelope({
                    type: attachments.length > 0 ? UMF_TYPES.FILE : UMF_TYPES.TEXT,
                    source: {
                        platform: 'signal',
                        channelId: dataMsg.groupInfo?.groupId || sender,
                        userId: sender,
                        username: envelope.sourceName || 'Usuario Signal'
                    },
                    body: {
                        text: dataMsg.message || '',
                        raw: dataMsg.message
                    },
                    attachments,
                    correlationId: envelope.timestamp.toString()
                });

                this.context.bus.emit('message.ingress', umf);
            } catch (error) {
            }
        });
    }

    _formatText(rawText) {
        if (typeof rawText !== 'string') return { text: rawText, textStyles: [] };

        let strippedText = rawText;
        const textStyles = [];
        const tokenRegex = /(\*)([^\*]+)(\*)|(_)([^_]+)(_)|(`)([^`]+)(`)/g;

        let match;
        while ((match = tokenRegex.exec(strippedText)) !== null) {
            let style = ''; let content = '';
            if (match[1]) { style = 'BOLD'; content = match[2]; }
            else if (match[4]) { style = 'ITALIC'; content = match[5]; }
            else if (match[7]) { style = 'MONOSPACE'; content = match[8]; }

            const start = match.index;
            strippedText = strippedText.slice(0, start) + content + strippedText.slice(start + match[0].length);
            textStyles.push(`${start}:${content.length}:${style}`);
            tokenRegex.lastIndex = start + content.length;
        }
        return { text: strippedText, textStyles };
    }

    _sendRaw(obj) {
        if (this.client?.writable) {
            this.client.write(JSON.stringify(obj) + '\n');
        }
    }

    async health() {
        return {
            status: this.client?.writable ? 'connected' : 'disconnected',
            platform: this.platformName
        };
    }
}