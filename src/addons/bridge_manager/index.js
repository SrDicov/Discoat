// src/addons/bridge_manager/index.js

export default class BridgeManager {
    constructor() {
        this.name = 'Bridge Manager';
        this.commands = ['!bridge.on', '!bridge.off', '!bridge.status', '!bridge.leave'];
    }

    /**
     * Fase de inicialización: recibe el contenedor de servicios (context) del Microkernel.
     */
    async init(context) {
        this.context = context;
    }

    /**
     * Fase de arranque: se suscribe al bus de eventos para procesar comandos administrativos.
     */
    async start() {
        this.context.bus.on('message.ingress', (umf) => this.handle(umf));
    }

    /**
     * Procesa mensajes entrantes que contengan comandos del gestor de puentes.
     */
    async handle(umf) {
        const cmd = umf.body.text?.split(' ')[0];
        if (!this.commands.includes(cmd)) return;

        const { platform, channelId } = umf.head.source;
        // Usar repository (inyectado por el PluginLoader) para acceder a la topología
        const link = await this.context.repository.getChannelLink(platform, channelId);
        if (!link) return;

        switch (cmd) {
            case '!bridge.status':
                const topology = await this.context.repository.getBridgeTopology(link.bridge_id);
                const list = topology.map(t => `• ${t.platform.toUpperCase()}: ${t.native_id}`).join('\n');
                await this._reply(umf, `🌐 **Estado del Puente:**\nID: \`${link.bridge_id}\`\nNodos:\n${list}`);
                break;

            case '!bridge.off':
                // CORRECCIÓN: Usar el método semántico expuesto por el proxy del Kernel
                await this.context.repository.updateBridgeStatus(link.bridge_id, 'off');
                await this._reply(umf, "⏸️ Puente pausado para toda la red.");
                break;

            case '!bridge.on':
                await this.context.repository.updateBridgeStatus(link.bridge_id, 'on');
                await this._reply(umf, "▶️ Puente reactivado.");
                break;

            case '!bridge.leave':
                // CORRECCIÓN: Se asume que el repositorio expone unlinkChannel (debe estar en safeRepository)
                await this.context.repository.unlinkChannel(platform, channelId);
                await this._reply(umf, "🔌 Has salido de la red.");
                break;
        }
    }

    /**
     * Envía una respuesta administrativa de vuelta al canal de origen.
     */
    async _reply(umf, text) {
        // Asegurar la estructura UMF para evitar que los adaptadores de salida fallen
        const reply = {
            ...umf,
            body: { text, attachments: [] },
            head: { ...umf.head, dest: umf.head.source }
        };
        // CORRECCIÓN: usar nomenclatura de colas con guiones bajos (consistente con router y workers)
        const queueName = `queue_${umf.head.source.platform}_out`;
        await this.context.queue.add(queueName, reply);
    }

    /**
     * Fase de detención.
     */
    async stop() {}

    /**
     * Reporte de salud.
     */
    async health() {
        return { status: 'ready' };
    }
}