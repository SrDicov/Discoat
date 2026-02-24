import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export default class PluginLoader {
    constructor(kernelContext) {
        this.context = kernelContext;
        this.plugins = new Map();
        this.paths = {
            adapters: path.resolve('src/adapters'),
            addons: path.resolve('src/addons')
        };
    }

    async loadAddons() {
        await this._loadPluginsFromDir(this.paths.addons, 'addon');
    }

    async loadAdapters() {
        await this._loadPluginsFromDir(this.paths.adapters, 'adapter');
    }

    async startAll() {
        const startPromises = [];
        for (const [name, plugin] of this.plugins) {
            this.context.logger.info('Loader', `Iniciando plugin: ${name}...`);
            startPromises.push(
                plugin.start().catch(err => {
                    this.context.logger.error('Loader', `Fallo al iniciar ${name}`, { error: err.message });
                })
            );
        }
        await Promise.allSettled(startPromises);
    }

    async stopAll() {
        const stopPromises = [];
        for (const [name, plugin] of this.plugins) {
            stopPromises.push(plugin.stop().catch(e => console.error(e)));
        }
        await Promise.allSettled(stopPromises);
    }

    async _loadPluginsFromDir(directory, type) {
        try {
            await fs.access(directory).catch(() => null);
            const entries = await fs.readdir(directory, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const pluginName = entry.name;
                    const pluginPath = path.join(directory, pluginName, 'index.js');

                    try {
                        const moduleUrl = pathToFileURL(pluginPath).href;
                        const { default: PluginClass } = await import(moduleUrl);

                        this._validateInterface(pluginName, PluginClass);

                        const pluginContext = this._createPluginContext(pluginName, type);
                        const instance = new PluginClass();

                        await instance.init(pluginContext);
                        this.plugins.set(`${type}:${pluginName}`, instance);

                        this.context.logger.debug('Loader', `Plugin cargado: ${pluginName} (${type})`);
                    } catch (err) {
                        this.context.logger.error('Loader', `Error cargando plugin ${pluginName}`, { error: err.message });
                    }
                }
            }
        } catch (err) {
            this.context.logger.error('Loader', `Error leyendo directorio ${directory}`, { error: err.message });
        }
    }

    _createPluginContext(name, type) {
        const scopedLogger = {
            info: (msg, meta = {}) => this.context.logger.info(`${type}:${name}`, msg, meta),
            error: (msg, meta = {}) => this.context.logger.error(`${type}:${name}`, msg, meta),
            warn: (msg, meta = {}) => this.context.logger.warn(`${type}:${name}`, msg, meta),
            debug: (msg, meta = {}) => this.context.logger.debug(`${type}:${name}`, msg, meta),
            withCorrelation: (meta, fn) => this.context.logger.withCorrelation(meta, fn)
        };

        return {
            config: this.context.config,
            bus: this.context.bus,
            db: this.context.db,
            queue: this.context.queue,
            storage: this.context.storage,
            logger: scopedLogger,
            pluginName: name,
            pluginType: type
        };
    }

    _validateInterface(name, PluginClass) {
        if (typeof PluginClass !== 'function') {
            throw new Error(`El módulo ${name} no exporta una clase por defecto.`);
        }
        const requiredMethods = ['init', 'start', 'stop', 'health'];
        const prototype = PluginClass.prototype;
        const missing = requiredMethods.filter(m => typeof prototype[m] !== 'function');

        if (missing.length > 0) {
            throw new Error(`Plugin ${name} interfaz incompleta. Faltan: ${missing.join(', ')}`);
        }
    }
}
