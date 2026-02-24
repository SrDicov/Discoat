// src/addons/admin/index.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

export class AdminAddon extends EventEmitter {
    constructor() {
        super();
        this.context = null;
        this.commands = ['!ping', '!id', '!reset', '!diag', '!status'];
        // IDs de usuarios administradores (puedes moverlo a config)
        this.adminIds = ['584826058862100481', 'global_admin_id'];
    }

    async init(context) {
        this.context = context;
        this.context.logger.info({ section: 'addon:admin' }, 'Inicializando herramientas de administración.');

        // Crear carpeta para reportes si no existe
        const reportDir = path.resolve('data', 'reports');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    }

    async start() {
        this.context.logger.info({ section: 'addon:admin' }, 'Escuchando comandos de sistema...');

        // Escuchar todos los mensajes entrantes
        this.context.bus.on('message.ingress', async (envelope) => {
            await this._processMessage(envelope);
        });
    }

    async stop() {
        this.context.logger.info({ section: 'addon:admin' }, 'Deteniendo administración.');
    }

    async health() {
        return { status: 'ok', commands: this.commands.length };
    }

    // --- Procesador Central de Mensajes ---
    async _processMessage(envelope) {
        // Ignorar mensajes sin texto
        if (!envelope.body || !envelope.body.text) return;

        const text = envelope.body.text.trim();
        const args = text.split(/\s+/);
        const command = args[0].toLowerCase();

        // Verificar si es un comando conocido
        if (!this.commands.includes(command)) return;

        this.context.logger.debug({ section: 'addon:admin', cmd: command }, 'Comando detectado');

        try {
            switch (command) {
                case '!ping':
                case '!id':
                    await this._handleId(envelope, args);
                    break;
                case '!reset':
                    await this._handleReset(envelope, args);
                    break;
                case '!diag':
                case '!status':
                    await this._handleDiagnostic(envelope);
                    break;
            }
        } catch (error) {
            this.context.logger.error({ section: 'addon:admin', err: error }, 'Error ejecutando comando');
            await this._reply(envelope, `❌ Error interno ejecutando ${command}: ${error.message}`);
        }
    }

    // --- 1. Lógica de Identidad (Antiguo ping.js) ---
    async _handleId(envelope, args) {
        const source = envelope.head.source;
        let targetId = source.userId;
        let targetName = source.username || 'Usuario';
        let type = 'Tu ID Personal';

        // Detectar si es respuesta a otro mensaje (Reply)
        // Nota: El adaptador debe llenar 'head.replyTo' si soporta respuestas
        if (envelope.head.replyTo) {
            targetId = envelope.head.replyTo.userId;
            targetName = envelope.head.replyTo.username || 'Usuario Mencionado';
            type = 'Usuario Respondido';
        }
        // Si hay menciones en el UMF (si el adaptador las extrajo)
        else if (envelope.body.mentions && envelope.body.mentions.length > 0) {
            const mention = envelope.body.mentions[0];
            targetId = mention.id;
            targetName = mention.name;
            type = 'Usuario Mencionado';
        }
        // Si el argumento es "canal" o "chat"
        else if (args[1] && ['canal', 'chat', 'channel'].includes(args[1].toLowerCase())) {
            targetId = source.channelId;
            targetName = 'Canal Actual';
            type = 'ID de Canal';
        }

        const response = [
            `🆔 **Información de Identidad** (${source.platform.toUpperCase()})`,
            `──────────────────────────`,
            `> **Tipo:** ${type}`,
            `> **Nombre:** ${targetName}`,
            `> **ID:** \`${targetId}\``,
            `──────────────────────────`
        ].join('\n');

        await this._reply(envelope, response);
    }

    // --- 2. Lógica de Reinicio (Antiguo reset.js) ---
    async _handleReset(envelope, args) {
        // Verificación de seguridad simple
        if (!this.adminIds.includes(envelope.head.source.userId) && process.env.NODE_ENV === 'production') {
            return this._reply(envelope, '⛔ **Acceso Denegado**: No tienes permisos para reiniciar el núcleo.');
        }

        const level = args[1] || '1';
        let msg = '';

        if (level === '3' || level === 'force') {
            msg = '🔌 **Apagado Forzado**: Deteniendo proceso Node.js...';
            await this._reply(envelope, msg);

            // Esperar un poco para que salga el mensaje
            setTimeout(() => {
                this.context.kernel.shutdown('ADMIN_RESET_FORCE');
            }, 1000);
        } else {
            msg = '🔄 **Reinicio Suave**: Recargando plugins (No implementado en v2.0 todavía, usando reinicio completo)...';
            await this._reply(envelope, msg);
            setTimeout(() => {
                this.context.kernel.shutdown('ADMIN_RESET_SOFT');
            }, 1000);
        }
    }

    // --- 3. Diagnóstico del Sistema (Antiguo test.js) ---
    async _handleDiagnostic(envelope) {
        await this._reply(envelope, '🔄 **Ejecutando Diagnóstico del Sistema**... Por favor espera.');

        const uptime = process.uptime();
        const mem = process.memoryUsage();
        const cpus = os.cpus();

        // Recopilar estado de adaptadores (si es posible)
        let adapterStatus = "Desconocido (Plugin Manager no expuesto)";
        if (this.context.kernel.pluginManager) {
            // Esto asume que tienes acceso al mapa de plugins en el loader
            // Si no, solo mostramos general
            adapterStatus = "Activo";
        }

        let dbStatus = "Desconectado";
        try {
            // Verificar si DB responde (si es SQL) o si existe objeto
            if (this.context.db) dbStatus = "Conectado (Driver cargado)";
        } catch (e) { dbStatus = `Error: ${e.message}`; }

        const reportLines = [
            `====================================================`,
            ` 🩺 REPORTE DE DIAGNÓSTICO: OPENCHAT v2.0`,
            `====================================================`,
            `📅 Fecha: ${new Date().toISOString()}`,
            `⏱️ Uptime: ${Math.floor(uptime / 60)} min ${Math.floor(uptime % 60)} sec`,
            `💾 Memoria (RSS): ${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
            `💾 Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
            `💻 CPU: ${cpus[0].model} (${cpus.length} cores)`,
            `----------------------------------------------------`,
            `🔌 **Subsistemas:**`,
            `   - Base de Datos: ${dbStatus}`,
            `   - Adaptadores: ${adapterStatus}`,
            `   - Bus de Eventos: Activo`,
            `====================================================`
        ];

        const reportText = reportLines.join('\n');

        // Guardar reporte en disco
        const fileName = `diagnostico_${Date.now()}.txt`;
        const filePath = path.resolve('data', 'reports', fileName);

        try {
            fs.writeFileSync(filePath, reportText, 'utf8');
            this.context.logger.info({ section: 'addon:admin', file: fileName }, 'Reporte generado');

            // Responder con resumen y ruta
            await this._reply(envelope, `${reportText}\n\n✅ **Reporte guardado en server:** \`data/reports/${fileName}\``);
        } catch (e) {
            await this._reply(envelope, `❌ Error guardando reporte: ${e.message}`);
        }
    }

    // --- Helper para enviar respuestas ---
    async _reply(originalEnvelope, text) {
        // Construir envelope de salida (Egress)
        // Intercambiamos origen por destino para responder

        // NOTA: En una implementación real, el Router debería encargarse de esto,
        // pero el Admin Addon a veces necesita responder directo.

        const responseEnvelope = {
            head: {
                id: crypto.randomUUID(),
                correlationId: originalEnvelope.head.correlationId,
                timestamp: Date.now(),
                source: { platform: 'core', component: 'admin' },
                // IMPORTANTE: Definir destino basado en el origen del mensaje
                target: {
                    platform: originalEnvelope.head.source.platform,
                    channelId: originalEnvelope.head.source.channelId,
                    userId: originalEnvelope.head.source.userId
                }
            },
            body: {
                text: text,
                type: 'text'
            }
        };

        // Emitir a la cola de salida de la plataforma correspondiente
        const targetQueue = `queue:${originalEnvelope.head.source.platform}:out`;

        // Si tienes colas configuradas:
        if (this.context.queue) {
            // this.context.queue.add(targetQueue, responseEnvelope);
        }

        // Si usas bus directo (desarrollo):
        // Emitimos un evento que los adaptadores escuchen, ej: 'discord.egress'
        this.context.bus.emit(`${originalEnvelope.head.source.platform}.egress`, responseEnvelope);
    }
}

export default AdminAddon;
