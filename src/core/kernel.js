import process from 'node:process';
import ConfigLoader from '../../config/main.js';
import Logger from './utils/observability.js';
import MessageBus from './infra/message_bus.js';
import Repository from './infra/repository.js';
import PluginLoader from './plugin_loader.js';
import QueueService from './infra/queue.js';
import StorageService from './infra/storage.js';
export class Kernel {
    constructor() {
        this.startTime = Date.now();
        this.isShuttingDown = false;

        this.context = {
            config: null,
            logger: Logger,
            bus: null,
            db: null,
            queue: null,
            storage: null,
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
        if (!this.context.config) throw new Error('No se pudo cargar la configuración.');

        this.context.bus = new MessageBus();

        this.context.db = new Repository();
        await this.context.db.init(this.context);
        await this.context.db.connect();

        this.context.queue = new QueueService(this.context);
        await this.context.queue.init();

        this.context.storage = new StorageService(this.context);
        await this.context.storage.init();
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

            if (this.context.queue) await this.context.queue.stop();

            if (this.context.db) {
                if (typeof this.context.db.disconnect === 'function') await this.context.db.disconnect();
                else if (typeof this.context.db.close === 'function') this.context.db.close();
            }

            Logger.info('Kernel', 'Apagado limpio completado.');
            process.exit(0);
        } catch (error) {
            console.error('Error durante el apagado:', error);
            process.exit(1);
        }
    }
}
