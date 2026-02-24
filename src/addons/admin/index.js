import { randomUUID } from 'node:crypto';
import * as Permissions from '../../core/utils/permissions.js';
import { createEnvelope } from '../../core/utils/umf.js';

export default class AdminAddon {
    constructor() {
        this.context = null;
        this.commands = ['!admin', '!bridge', '!net'];
    }

    async init(context) {
        this.context = context;
    }

    async start() {
        this.context.bus.on('message.ingress', this.handleMessage.bind(this));
    }

    async stop() {
        this.context.bus.off('message.ingress', this.handleMessage.bind(this));
    }

    async health() {
        return { status: 'active', commands: this.commands };
    }

    async handleMessage(envelope) {
        try {
            const text = envelope.body.text || '';
            const args = text.trim().split(/\s+/);
            const command = args[0].toLowerCase();

            if (!this.commands.includes(command)) return;

            const { platform, userId } = envelope.head.source;
            const userRole = Permissions.getRole(platform, userId);

            if (userRole < 2) {
                await this._reply(envelope, "⛔ **Acceso Denegado:** Requiere privilegios de Administrador.");
                return;
            }

            const subCommand = args[1] ? args[1].toLowerCase() : 'status';
            const param = args[2];

            await this._routeCommand(subCommand, param, envelope, userRole);

        } catch (error) {
        }
    }

    async _routeCommand(subCommand, param, envelope, userRole) {
        const { platform, channelId } = envelope.head.source;
        const repo = this.context.db;

        switch (subCommand) {
            case 'status':
            case 'info': {
                const link = repo.getChannelLink(platform, channelId);
                if (!link) {
                    return this._reply(envelope, "📡 **Estado:** Aislado (Sin conexión a redes).");
                }

                const topology = repo.getBridgeTopology(link.bridge_id);
                const bridgeInfo = repo.getBridge(link.bridge_id);

                const nodeList = topology
                .map(n => `• [${n.platform.toUpperCase()}] ${n.native_id}`)
                .join('\n');

                await this._reply(envelope,
                                  `🌐 **Red: ${bridgeInfo ? bridgeInfo.name : 'Unknown'}**\n` +
                                  `🆔 UUID: \`${link.bridge_id}\`\n` +
                                  `📊 Nodos (${topology.length}):\n${nodeList}`
                );
                break;
            }

            case 'create':
            case 'new': {
                const existing = repo.getChannelLink(platform, channelId);
                if (existing) {
                    return this._reply(envelope, "⚠️ Ya estás en una red. Usa `!bridge leave` primero.");
                }

                const newBridgeId = randomUUID();
                const name = param || `Red de ${platform}/${channelId}`;

                repo.createBridge(newBridgeId, name);
                repo.linkChannelToBridge(newBridgeId, platform, channelId, { role: 'creator' });

                await this._reply(envelope,
                                  `✨ **Nueva Red Creada**\n` +
                                  `🆔 ID: \`${newBridgeId}\`\n` +
                                  `Para unir otros chats: \`!bridge join ${newBridgeId}\``
                );
                break;
            }

            case 'join': {
                if (!param) return this._reply(envelope, "❌ Faltó el ID de la red.");

                const current = repo.getChannelLink(platform, channelId);
                if (current) return this._reply(envelope, "⚠️ Sal de tu red actual antes de unirte a otra.");

                const bridge = repo.getBridge(param);
                if (!bridge) return this._reply(envelope, "❌ La red especificada no existe.");

                repo.linkChannelToBridge(param, platform, channelId);
                const topology = repo.getBridgeTopology(param);

                await this._reply(envelope, `🔗 **Conectado** a la red. Total nodos: ${topology.length}.`);
                break;
            }

            case 'leave': {
                const current = repo.getChannelLink(platform, channelId);
                if (!current) return this._reply(envelope, "👻 No estás conectado a nada.");

                repo.unlinkChannel(platform, channelId);
                await this._reply(envelope, "🔌 **Desconectado** de la red.");
                break;
            }

            case 'nuke': {
                if (userRole < 3) return this._reply(envelope, "⛔ Requiere nivel Owner.");

                const link = repo.getChannelLink(platform, channelId);
                if (!link) return this._reply(envelope, "Nada que destruir aquí.");

                const topology = repo.getBridgeTopology(link.bridge_id);
                topology.forEach(node => {
                    repo.unlinkChannel(node.platform, node.native_id);
                });

                await this._reply(envelope, `☢️ **NUKE:** Se han desconectado ${topology.length} nodos.`);
                break;
            }

            default:
                await this._reply(envelope,
                                  "🛠️ **Comandos:** status, create, join <id>, leave"
                );
        }
    }

    async _reply(originalEnvelope, messageText) {
        const { platform, channelId } = originalEnvelope.head.source;

        const replyEnvelope = {
            head: {
                id: randomUUID(),
                correlationId: originalEnvelope.head.correlationId,
                timestamp: Date.now(),
                source: { platform: 'system', userId: 'admin' },
                dest: { platform, channelId }
            },
            body: {
                text: messageText,
                attachments: []
            }
        };

        const queueName = `queue:${platform}:out`;

        await this.context.queue.add(queueName, replyEnvelope);
    }
}
