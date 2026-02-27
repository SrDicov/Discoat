// src/core/plugin_loader.js
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Gestor dinámico de módulos (Plugins).
 * Reemplaza al antiguo loader.js, abandonando dependencias estáticas
 * y el uso de `require.cache` en favor de ECMAScript Modules (ESM) para Node.js 24.
 */
export class PluginLoader {
    constructor(kernelContext) {
        this.kernelContext = kernelContext;
        this.plugins = new Map();

        // Directorios donde residen los complementos (Microkernel Architecture)
        this.pluginDirectories = [
            path.resolve(process.cwd(), 'src/adapters'),
            path.resolve(process.cwd(), 'src/addons')
        ];
    }

    /**
     * Crea un Sandbox o contenedor de inyección de dependencias (DI) apoderado
     * para aislar los privilegios del plugin y evitar accesos globales.
     */
    _createPluginContext(pluginName) {
        // Se restringe el acceso directo a la base de datos para obligar a usar los métodos del DAO
        const safeRepository = {
            getBridgeTopology: this.kernelContext.repository?.getBridgeTopology.bind(this.kernelContext.repository),
            getAllActiveBridges: this.kernelContext.repository?.getAllActiveBridges.bind(this.kernelContext.repository),
            linkChannelToBridge: this.kernelContext.repository?.linkChannelToBridge.bind(this.kernelContext.repository),
            updateBridgeStatus: this.kernelContext.repository?.updateBridgeStatus.bind(this.kernelContext.repository)
        };

        // Inmutabilidad para evitar la contaminación cruzada (Object.freeze)
        return Object.freeze({
            pluginName: pluginName,
            config: Object.freeze({...this.kernelContext.config }),
                             logger: this.kernelContext.logger,
                             bus: this.kernelContext.bus,
                             queue: this.kernelContext.queue,
                             storage: this.kernelContext.storage,
                             circuitBreaker: this.kernelContext.circuitBreaker,
                             repository: safeRepository
        });
    }

    /**
     * Fase de Descubrimiento: Escanea directorios dinámicamente.
     */
    async discover() {
        const logger = this.kernelContext.logger;
        if (logger) logger.info('Iniciando carga de plugins...');

        for (const dir of this.pluginDirectories) {
            try {
                // Genera la estructura de directorios de manera segura si no existen
                await fs.mkdir(dir, { recursive: true });
                const entries = await fs.readdir(dir, { withFileTypes: true });

                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const pluginPath = path.join(dir, entry.name, 'index.js');
                        try {
                            await fs.access(pluginPath);
                            await this._loadPlugin(pluginPath, entry.name);
                        } catch (err) {
                            if (logger) logger.warn(`El plugin '${entry.name}' no posee un index.js válido. Omitiendo...`);
                        }
                    }
                }
            } catch (error) {
                if (logger) logger.error(`Error al escanear directorio de plugins en ${dir}`, { error: error.message });
            }
        }
    }

    /**
     * Importación y validación: Carga asíncronamente validando el contrato de la interfaz.
     */
    async _loadPlugin(pluginPath, pluginName) {
        const logger = this.kernelContext.logger;
        try {
            // Importación dinámica nativa de ESM
            const module = await import(`file://${pluginPath}`);
            const PluginClass = module.default;

            if (!PluginClass) {
                throw new Error(`Estructura inválida: Falta el 'export default class' en el plugin ${pluginName}.`);
            }

            const instance = new PluginClass();

            // Validación estricta del contrato (BaseAdapter)
            const requiredMethods = ['init', 'start', 'stop', 'health'];
            for (const method of requiredMethods) {
                if (typeof instance[method]!== 'function') {
                    throw new Error(`El plugin incumple la interfaz requerida: falta el método ${method}()`);
                }
            }

            this.plugins.set(pluginName, instance);
            if (logger) logger.info(`Plugin validado y cargado exitosamente: [${pluginName}]`);

        } catch (error) {
            if (logger) logger.error(`Fallo crítico al cargar el plugin ${pluginName}:`, { error: error.message });
            // Degradación Elegante: Se aísla el error del plugin defectuoso permitiendo que el sistema siga operando
        }
    }

    /**
     * Fase de Inicialización: Inyecta el contexto y los servicios.
     */
    async initAll() {
        for (const [name, plugin] of this.plugins.entries()) {
            try {
                const safeContext = this._createPluginContext(name);
                await plugin.init(safeContext);
                if (this.kernelContext.logger) this.kernelContext.logger.info(`Plugin [${name}] inicializado.`);
            } catch (error) {
                if (this.kernelContext.logger) this.kernelContext.logger.error(`Error inicializando plugin [${name}]:`, { error: error.message });
            }
        }
    }

    /**
     * Fase de Ejecución: Conecta a los proveedores externos y colas.
     */
    async startAll() {
        for (const [name, plugin] of this.plugins.entries()) {
            try {
                await plugin.start();
                if (this.kernelContext.logger) this.kernelContext.logger.info(`Plugin [${name}] en ejecución activa.`);
            } catch (error) {
                if (this.kernelContext.logger) this.kernelContext.logger.error(`Fallo al arrancar el servicio del plugin [${name}]:`, { error: error.message });
            }
        }
    }

    /**
     * Fase de Destrucción: Maneja el Graceful Shutdown (liberación de memoria y WebSockets).
     */
    async stopAll() {
        for (const [name, plugin] of this.plugins.entries()) {
            try {
                await plugin.stop();
                if (this.kernelContext.logger) this.kernelContext.logger.info(`Plugin [${name}] detenido de manera segura.`);
            } catch (error) {
                if (this.kernelContext.logger) this.kernelContext.logger.error(`Error durante el apagado de [${name}]:`, { error: error.message });
            }
        }
    }
}
