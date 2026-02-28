// src/core/kernel.js
import config from '../../config/main.js';  // Importación por defecto del objeto de configuración
import { Logger } from './utils/observability.js';
import { MessageBus } from './infra/message_bus.js';
import { Repository } from './infra/repository.js';
import { StorageService } from './infra/storage.js';
import { QueueManager } from './infra/queue.js';
import { CircuitBreakerRegistry } from './utils/circuit_breaker.js';
import { PluginLoader } from './plugin_loader.js';

/**
 * Kernel principal del sistema.
 * Orquesta el ciclo de vida completo y gestiona el contenedor de Inyección de Dependencias (DI).
 */
export class Kernel {
    constructor() {
        this.startTime = Date.now();
        this.isShuttingDown = false;

        // Contenedor estricto de Inyección de Dependencias (DI Container)
        this.context = {
            config: null,
            logger: null,
            bus: null,
            repository: null,
            storage: null,
            queue: null,
            circuitBreaker: null,
            pluginLoader: null
        };
    }

    /**
     * Fase 1: Inicialización de la infraestructura base de forma secuencial.
     * Ningún plugin externo es cargado en esta etapa.
     */
    async init() {
        try {
            // 1. Configuración (se asigna directamente el objeto importado)
            this.context.config = config;

            // 2. Observabilidad (Logger estructurado + Soporte AsyncContextFrame de Node 24)
            this.context.logger = new Logger(this.context.config);
            this.context.logger.info('Iniciando secuencia de arranque de infraestructura del Microkernel...');

            // 3. Bus de Mensajes (Event-Driven: EventEmitter local o Redis Pub/Sub)
            this.context.bus = new MessageBus(this.context.config, this.context.logger);
            await this.context.bus.connect();

            // 4. Repositorio (Persistencia relacional/caché para topologías - better-sqlite3 WAL)
            this.context.repository = new Repository(this.context.config, this.context.logger);
            await this.context.repository.connect();

            // 5. Almacenamiento (Manejo de archivos multimedia S3/MinIO para claves de WhatsApp)
            this.context.storage = new StorageService(this.context.config, this.context.logger);
            await this.context.storage.connect();

            // 6. Colas Distribuidas (BullMQ para Rate Limiting y Egress)
            this.context.queue = new QueueManager(this.context.config, this.context.logger);
            await this.context.queue.connect();

            // 7. Registro de Circuit Breaker (Prevención de fallos en cascada contra APIs externas)
            this.context.circuitBreaker = new CircuitBreakerRegistry(this.context.config, this.context.logger);

            // 8. Gestor de Plugins (Aislamiento y carga dinámica ESM)
            this.context.pluginLoader = new PluginLoader(this.context);
            await this.context.pluginLoader.discover();

        } catch (error) {
            console.error('Fallo crítico y aborto durante la inicialización del Kernel:', error);
            throw error;
        }
    }

    /**
     * Fase 2: Arranque e inyección de contexto hacia Adaptadores y Addons N-a-N.
     */
    async start() {
        if (this.isShuttingDown) return;
        this.context.logger.info('Arrancando sistema y cargando módulos de integración...');

        try {
            // Inyectar el Proxy del DI Container restringido a cada plugin validado
            await this.context.pluginLoader.initAll();

            // Ejecutar los procesos de escucha y conexión de cada plugin (Login a Discord, WSS a Baileys, Webhooks Telegram)
            await this.context.pluginLoader.startAll();

            // Notificar al clúster/bus local que el nodo actual está completamente operativo
            this.context.bus.emit('system.ready', {
                uptime: Date.now() - this.startTime,
                                  timestamp: Date.now()
            });

            this.context.logger.info(`Microkernel operativo y enrutando. Tiempo total de arranque: ${Date.now() - this.startTime}ms`);
        } catch (error) {
            this.context.logger.error('Error catastrófico durante el arranque de los plugins', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Fase 3: Apagado Elegante (Graceful Shutdown) disparado por SIGTERM/SIGINT.
     * Asegura la liberación de puertos, vaciado de colas y desconexiones limpias.
     */
    async stop() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        const log = this.context.logger ? this.context.logger.info.bind(this.context.logger) : console.log;
        const logError = this.context.logger ? this.context.logger.error.bind(this.context.logger) : console.error;

        log('Iniciando secuencias de Graceful Shutdown del Microkernel...');

        try {
            // 1. Notificar al sistema para rechazar nuevas peticiones entrantes
            if (this.context.bus) {
                this.context.bus.emit('system.shutdown', { timestamp: Date.now() });
            }

            // 2. Detener adaptadores (Desconectar WebSockets y cerrar listeners nativos)
            if (this.context.pluginLoader) {
                log('Deteniendo ciclo de vida de los plugins...');
                await this.context.pluginLoader.stopAll();
            }

            // 3. Pausar y drenar colas de BullMQ activas
            if (this.context.queue) {
                log('Cerrando conexiones y workers de colas de salida...');
                await this.context.queue.disconnect();
            }

            // 4. Cerrar conexiones activas al clúster de Base de Datos
            if (this.context.repository) {
                log('Cerrando accesos a la persistencia relacional...');
                await this.context.repository.disconnect();
            }

            // 5. Finalizar enlaces de almacenamiento S3
            if (this.context.storage) {
                await this.context.storage.disconnect();
            }

            // 6. Cerrar el sistema nervioso principal
            if (this.context.bus) {
                log('Desconectando Bus de Eventos...');
                await this.context.bus.disconnect();
            }

            log('Microkernel detenido. Todas las dependencias han sido liberadas exitosamente.');
        } catch (error) {
            logError('Fallo detectado durante el proceso de apagado del Kernel', { error: error.message, stack: error.stack });
            throw error;
        }
    }
}
