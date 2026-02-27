// src/addons/admin/index.js
import { randomUUID } from 'node:crypto';

/**
 * Addon de Administración y Gestión de Topologías.
 * Escucha comandos en texto plano (ej.!ping,!bridge,!link) a través del bus de eventos
 * y gestiona las conexiones en la base de datos (Repository) en tiempo real.
 */
export default class AdminAddon {
    constructor() {
        this.context = null;
        this.platformName = 'admin';
        this.prefix = '!'; // Prefijo universal de comandos
    }

    /**
     * Fase de Inicialización: Recibe el contenedor de dependencias de solo lectura.
     */
    async init(context) {
        this.context = context;
        if (this.context.logger) {
            this.context.logger.info(`[${this.platformName}] Inicializado (Módulo de Comandos de Control)`);
        }
    }

    /**
     * Fase de Ejecución: Intercepta todos los mensajes entrantes para evaluar comandos.
     */
    async start() {
        this.context.bus.on('message.ingress', async (envelope) => {
            const text = envelope.body?.text  ||  '';

            // Ignorar eventos que no posean contenido textual o no inicien con el prefijo
            if (!text.startsWith(this.prefix)) return;

            const correlationId = envelope.head?.correlationId;

            // Mantener trazabilidad (Trace ID) inyectando el contexto asíncrono
            if (this.context.logger) {
                this.context.logger.withCorrelation(correlationId, async () => {
                    await this._handleCommand(envelope, text);
                });
            } else {
                await this._handleCommand(envelope, text);
            }
        });

        if (this.context.logger) {
            this.context.logger.info(`[${this.platformName}] Escuchando comandos administrativos.`);
        }
    }

    /**
     * Fase de Destrucción: Apagado elegante.
     */
    async stop() {
        if (this.context.logger) {
            this.context.logger.info(`[${this.platformName}] Módulo de administración detenido.`);
        }
    }

    /**
     * Reporte de telemetría de vida del módulo.
     */
    health() {
        return {
            platform: this.platformName,
            status: 'active'
        };
    }

    /**
     * Motor de resolución de comandos.
     */
    async _handleCommand(envelope, text) {
        // Analizador sintáctico básico (parser)
        const args = text.slice(this.prefix.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        const source = envelope.head.source;

        // Se recomienda en el futuro integrar validación de permisos con PermissionsManager aquí
        // Ejemplo: if (this.context.permissions.getRole(source.platform, source.userId) < 2) return;

        try {
            switch (command) {
                case 'ping':
                    await this._reply(envelope, '🏓 Pong! El Microkernel está operativo, enrutando y escuchando.');
                    break;

                case 'id':
                    await this._reply(envelope, `ℹ️ **Información Topológica**\nPlataforma: \`${source.platform}\`\nID de Canal Nativo: \`${source.channelId}\`\nIdentidad Emisor: \`${source.userId}\``);
                    break;

                case 'bridge': {
                    const name = args.join(' ')  ||  'Puente Genérico';
                    const bridgeId = this.context.repository.createBridge(name);
                    await this._reply(envelope, `🌉 **Grupo Virtual Creado**\nNombre: ${name}\nID del Puente: \`${bridgeId}\`\n\nEjecuta \`!link ${bridgeId}\` en las redes que desees anexar.`);
                    break;
                }

                case 'link': {
                    const targetBridgeId = args;
                    if (!targetBridgeId) {
                        await this._reply(envelope, '❌ Error sintáctico. Falta el parámetro ID.\nUso correcto: `!link <ID_DEL_PUENTE>`');
                        return;
                    }

                    this.context.repository.linkChannelToBridge({
                        bridgeId: targetBridgeId,
                        platform: source.platform,
                        nativeId: source.channelId,
                        config: {}
                    });

                    await this._reply(envelope, `✅ **Suscripción Exitosa**\nEste canal nativo ha sido acoplado al nodo de enrutamiento: \`${targetBridgeId}\``);
                    break;
                }

                case 'status': {
                    const link = this.context.repository.getChannelLink(source.platform, source.channelId);
                    if (!link) {
                        await this._reply(envelope, '⚠️ Estado: Aislado. Este canal no recibe ni emite tráfico a ningún puente multiconexión.');
                    } else {
                        await this._reply(envelope, `📊 **Estado de Conexión N-a-N**\nSuscrito a Puente: \`${link.bridge_id}\`\nTráfico: \`${link.status.toUpperCase()}\``);
                    }
                    break;
                }
            }
        } catch (error) {
            if (this.context.logger) {
                this.context.logger.error(`[${this.platformName}] Excepción durante ejecución de!${command}:`, { error: error.message, stack: error.stack });
            }
            await this._reply(envelope, `❌ **Fallo Crítico:** ${error.message}`);
        }
    }

    /**
     * Construye un envoltorio UMF inverso para inyectar una respuesta de sistema directamente
     * hacia la plataforma y chat que emitió la petición original.
     */
    async _reply(originalEnvelope, textResponse) {
        const targetPlatform = originalEnvelope.head.source.platform;
        const targetChannelId = originalEnvelope.head.source.channelId;

        const responseEnvelope = {
            head: {
                id: randomUUID(),
                correlationId: originalEnvelope.head.correlationId,
                timestamp: Date.now(),
                type: 'text/plain',
                source: {
                    platform: 'system',
                    channelId: 'admin',
                    userId: 'root',
                    username: 'OpenChat Ops',
                    avatar: null // Delegar la carga del icono al cliente objetivo
                },
                dest: {
                    platform: targetPlatform,
                    channelId: targetChannelId
                },
                replyTo: {
                    parentId: originalEnvelope.head.id,
                    parentText: originalEnvelope.body.text
                },
                // Horizonte dividido para evitar rebotes cíclicos de la respuesta del sistema
                trace_path: ['system:admin']
            },
            body: {
                text: textResponse,
                raw: textResponse,
                attachments: []
            }
        };

        // Emitir directamente hacia el encolador final, eludiendo la evaluación del Router
        const egressQueueName = `queue_${targetPlatform}_out`;
        await this.context.queue.add(egressQueueName, responseEnvelope);
    }
}
