import process from 'node:process';
import http from 'node:http';
import ConfigLoader from '../../config/main.js';
import Logger from './utils/observability.js';
import MessageBus from './infra/message_bus.js';
import Repository from './infra/repository.js';
import PluginLoader from './plugin_loader.js';

export class Kernel {
    constructor() {
        this.startTime = Date.now();
        this.isShuttingDown = false;

        this.context = {
            config: null,
            logger: Logger,
            bus: null,
            db: null,
            services: {},
            kernel: this
        };
    }

    async start() {
        console.clear();
        Logger.info('Kernel', '=== INICIANDO OPENCHAT v2.0 (MICROKERNEL) ===');

        try {
            await this._initInfrastructure();
            await this._loadPlugins();

            this.context.bus.emit('system.ready', {
                timestamp: Date.now(),
                                  uptime: 0
            });

            this._startHealthServer();

            Logger.info('Kernel', `Sistema operativo. Iniciado en ${(Date.now() - this.startTime)}ms.`);
            this._bindSignalHandlers();

        } catch (error) {
            console.error('\n❌ [FATAL KERNEL ERROR]:', error.message);
            console.error(error.stack);
            process.exit(1);
        }
    }

    async _initInfrastructure() {
        Logger.debug('Kernel', 'Cargando infraestructura base...');

        this.context.config = ConfigLoader;

        if (!this.context.config) {
            throw new Error('La configuración maestra está vacía o es inválida.');
        }

        this.context.bus = new MessageBus(this.context.config);
        await this.context.bus.init();

        this.context.db = new Repository(this.context.config);
        await this.context.db.connect();

        Logger.info('Kernel', 'Infraestructura base inicializada correctamente.');
    }

    async _loadPlugins() {
        Logger.info('Kernel', 'Cargando plugins...');
        const loader = new PluginLoader(this.context);

        await loader.loadAddons();
        await loader.loadAdapters();

        this.pluginManager = loader;

        await this.pluginManager.startAll();
    }

    _startHealthServer() {
        const port = process.env.PORT || 3000;

        this.healthServer = http.createServer((req, res) => {
            if (req.url === '/health') {
                const status = this.context.db ? 200 : 503;
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: status === 200 ? 'ok' : 'error',
                    uptime: process.uptime(),
                                       nodeId: this.context.config.system.nodeId
                }));
            } else {
                res.writeHead(404);
                res.end();
            }
        });

        this.healthServer.listen(port, () => {
            Logger.info('Kernel', `Healthcheck server escuchando en puerto ${port}`);
        });
    }

    _bindSignalHandlers() {
        ['SIGINT', 'SIGTERM'].forEach(sig => {
            process.on(sig, () => this.shutdown(sig));
        });
    }

    async shutdown(signal) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        Logger.warn('Kernel', `Deteniendo sistema por señal: ${signal}`);

        try {
            if (this.context.bus) this.context.bus.emit('system.shutdown', { signal });
            if (this.pluginManager) await this.pluginManager.stopAll();
            if (this.context.db) await this.context.db.disconnect();

            if (this.healthServer) {
                await new Promise(resolve => this.healthServer.close(resolve));
            }

            Logger.info('Kernel', 'Apagado limpio completado.');
            process.exit(0);
        } catch (error) {
            console.error('Error durante el apagado:', error);
            process.exit(1);
        }
    }
}
