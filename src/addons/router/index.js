// src/addons/router/index.js

/**
 * Addon Enrutador Central (Broker N-a-N).
 * Reemplaza al obsoleto bridge_router.js acoplado (Punto a Punto).
 * Opera agnósticamente sobre eventos del bus y distribuye cargas útiles UMF
 * mediante un patrón de abanico (Fan-out) hacia las colas de salida.
 */
export default class RouterAddon {
    constructor() {
        this.context = null;
        this.platformName = 'router';
    }

    /**
     * Fase de Inicialización: Recibe el contenedor seguro de servicios.
     */
    async init(context) {
        this.context = context;
        if (this.context.logger) {
            this.context.logger.info(`[${this.platformName}] Inicializado (Microkernel Message Broker)`);
        }
    }

    /**
     * Fase de Ejecución: Se suscribe al bus de eventos asíncronos.
     */
    async start() {
        // Interceptar todos los mensajes entrantes previamente normalizados a UMF por los adaptadores
        this.context.bus.on('message.ingress', async (envelope) => {
            // Preservar la trazabilidad inyectando el Correlation ID en el marco asíncrono
            const correlationId = envelope.head?.correlationId;

            if (this.context.logger) {
                this.context.logger.withCorrelation(correlationId, async () => {
                    await this._routeMessage(envelope);
                });
            } else {
                await this._routeMessage(envelope);
            }
        });

        if (this.context.logger) {
            this.context.logger.info(`[${this.platformName}] Enrutador activo y escuchando eventos 'message.ingress'`);
        }
    }

    /**
     * Lógica central de distribución en abanico (Fan-out) basada en la topología de la BD.
     */
    async _routeMessage(envelope) {
        try {
            const source = envelope.head?.source;
            if (!source || !source.platform || !source.channelId) {
                if (this.context.logger) this.context.logger.warn(`[${this.platformName}] Envelope descartado por ausencia de metadatos de origen.`);
                return;
            }

            // 1. Resolver la Topología: ¿A qué puente pertenece este canal?
            const link = this.context.repository.getChannelLink(source.platform, source.channelId);

            if (!link) {
                // El canal no está suscrito a ningún puente, se ignora pasivamente.
                return;
            }

            // Validar barrera de seguridad: El puente debe estar encendido
            if (link.status !== 'on') {
                if (this.context.logger) {
                    this.context.logger.debug(`[${this.platformName}] Enrutamiento abortado: El puente ${link.bridge_id} está pausado/apagado.`);
                }
                return;
            }

            // 2. Extraer todos los canales de destino del grupo virtual (Clúster)
            const targets = this.context.repository.getBridgeTopology(link.bridge_id);
            if (!targets || targets.length === 0) return;

            // CORRECCIÓN 1: Asegurar que el objeto en memoria TENGA un array válido ANTES de clonar
            if (!envelope.head.trace_path) {
                envelope.head.trace_path = [];
            }

            // Rastro criptográfico seguro
            const tracePath = envelope.head.trace_path;
            const sourceIdentifier = `${source.platform}:${source.channelId}`;

            // Añadimos el origen al tracePath inicial para el Split Horizon
            if (!tracePath.includes(sourceIdentifier)) {
                tracePath.push(sourceIdentifier);
            }

            // 3. Distribución (Fan-out) y Protección contra Bucles (Spanning Tree / Split Horizon)
            for (const target of targets) {
                const targetIdentifier = `${target.platform}:${target.native_id}`;

                // A. Horizonte Dividido (Split Horizon) estricto:
                // Jamás retransmitir el mensaje hacia el canal exacto que lo originó.
                if (targetIdentifier === sourceIdentifier) continue;

                // B. Evasión de Tormentas de Difusión (Broadcast Storms):
                // CORRECCIÓN 2: Solo bloqueamos si el IDENTIFICADOR EXACTO (Plataforma + ID de Canal) ya procesó el mensaje.
                if (tracePath.includes(targetIdentifier)) {
                    if (this.context.logger) {
                        this.context.logger.debug(`[${this.platformName}] Bucle evadido hacia ${targetIdentifier} gracias al Trace Path.`);
                    }
                    continue;
                }

                // 4. Clonar el UMF aislando la carga útil para este destino específico
                const outboxEnvelope = JSON.parse(JSON.stringify(envelope));

                // Marcar el destino explícito para el adaptador Egress
                outboxEnvelope.head.dest = {
                    platform: target.platform,
                    channelId: target.native_id
                };

                // Actualizar el historial de saltos (Trace Path) – ahora 100% seguro porque existe
                outboxEnvelope.head.trace_path.push(targetIdentifier);

                // Despachar a la cola BullMQ correspondiente a la plataforma destino
                const egressQueueName = `queue_${target.platform}_out`;

                await this.context.queue.add(egressQueueName, outboxEnvelope, {
                    jobId: `${outboxEnvelope.head.id || Date.now()}-${target.platform}-${target.native_id}` // Evita duplicidad a nivel de Job
                });

                if (this.context.logger) {
                    this.context.logger.info(`[${this.platformName}] Carga enrutada: ${source.platform} -> ${target.platform} (${target.native_id})`);
                }
            }

        } catch (error) {
            if (this.context.logger) {
                this.context.logger.error(`[${this.platformName}] Fallo crítico en el orquestador de enrutamiento:`, { error: error.message, stack: error.stack });
            }
        }
    }

    /**
     * Fase de Destrucción.
     */
    async stop() {
        if (this.context.logger) {
            this.context.logger.info(`[${this.platformName}] Módulo enrutador desconectado.`);
        }
    }

    /**
     * Reporte de telemetría local.
     */
    health() {
        return {
            platform: this.platformName,
            status: 'active'
        };
    }
}
