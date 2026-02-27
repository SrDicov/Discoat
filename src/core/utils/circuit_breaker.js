// src/core/utils/circuit_breaker.js
import { EventEmitter } from 'node:events';

/**
 * Implementación individual del patrón Circuit Breaker.
 * Protege el sistema de fallos en cascada aislando temporalmente las llamadas
 * a APIs externas (ej. Discord, Telegram) si detecta inestabilidad continua.
 */
export class CircuitBreaker extends EventEmitter {
    constructor(serviceName, options = {}, logger = null) {
        super();
        this.serviceName = serviceName;
        this.logger = logger;

        // Configuración de tolerancia
        this.failureThreshold = options.failureThreshold  ||  5;     // Fallos antes de abrir el circuito
        this.resetTimeout = options.resetTimeout  ||  30000;         // Tiempo en estado OPEN (ms) antes de probar (HALF_OPEN)
        this.requestTimeout = options.requestTimeout  ||  5000;      // Tiempo máximo de espera por petición (ms)

        // Estado inicial
        this.state = 'CLOSED'; // 'CLOSED' (Normal), 'OPEN' (Bloqueado), 'HALF_OPEN' (Prueba)
        this.failureCount = 0;
        this.nextAttempt = 0;

        // Telemetría y métricas
        this.metrics = {
            total: 0,
            success: 0,
            failed: 0,
            rejected: 0
        };
    }

    /**
     * Envuelve y ejecuta la llamada asíncrona a la API externa.
     *
     * @param {Function} command - Promesa o función asíncrona a ejecutar.
     * @param {Function} fallback - Función opcional de degradación elegante a ejecutar si falla.
     */
    async fire(command, fallback = null) {
        this.metrics.total++;

        // Bloqueo inmediato si el circuito está abierto
        if (this.state === 'OPEN') {
            if (Date.now() >= this.nextAttempt) {
                // El tiempo de espera expiró, permitimos una petición de prueba
                this._transition('HALF_OPEN');
            } else {
                // Circuito abierto: Rechazar petición para proteger el origen y destino
                this.metrics.rejected++;
                const error = new Error(`CircuitBreaker [${this.serviceName}] is OPEN. Operación bloqueada preventivamente.`);

                if (fallback) return fallback(error);
                throw error;
            }
        }

        try {
            // Ejecución de la solicitud con límite de tiempo estricto
            const result = await this._executeWithTimeout(command);
            this._onSuccess();
            return result;
        } catch (error) {
            this._onFailure(error);
            if (fallback) return fallback(error);
            throw error;
        }
    }

    /**
     * Impone un límite temporal a la ejecución para prevenir bloqueos de Event Loop
     * o fugas de memoria por conexiones colgadas.
     */
    _executeWithTimeout(command) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`TIMEOUT: La operación en [${this.serviceName}] excedió los ${this.requestTimeout}ms`));
            }, this.requestTimeout);

            // Aseguramos que command sea tratado como Promesa
            Promise.resolve(command())
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timer));
        });
    }

    /**
     * Manejador interno de éxito. Restablece el contador de anomalías.
     */
    _onSuccess() {
        this.metrics.success++;
        this.failureCount = 0;

        // Si estábamos en prueba y funcionó, restauramos el circuito
        if (this.state === 'HALF_OPEN') {
            this._transition('CLOSED');
        }
    }

    /**
     * Manejador interno de error. Incrementa anomalías y evalúa la apertura del circuito.
     */
    _onFailure(error) {
        this.metrics.failed++;
        this.failureCount++;

        // Si falla durante la prueba (HALF_OPEN) o alcanza el umbral, abrimos el circuito
        if (this.state === 'HALF_OPEN'  ||  this.failureCount >= this.failureThreshold) {
            this._transition('OPEN', error);
            }
    }

    /**
     * Realiza la transición de estado y emite telemetría.
     */
    _transition(newState, error = null) {
        const oldState = this.state;
        this.state = newState;

        if (newState === 'OPEN') {
            // Calcular cuándo se permitirá la próxima prueba de reconexión (Backoff)
            this.nextAttempt = Date.now() + this.resetTimeout;
        }

        if (this.logger && oldState!== newState) {
            this.logger.warn(`CircuitBreaker [${this.serviceName}] cambió de estado: ${oldState} -> ${newState}`, {
                service: this.serviceName,
                metrics: this.metrics,
                error: error?.message
            });
        }

        this.emit(newState.toLowerCase(), { service: this.serviceName, nextAttempt: this.nextAttempt });
    }

    /**
     * Genera una instantánea de la salud de este servicio específico.
     */
    getSnapshot() {
        return {
            serviceName: this.serviceName,
            state: this.state,
            failureCount: this.failureCount,
            metrics: {...this.metrics }
        };
    }
}

/**
 * Registro central de cortocircuitos.
 * Inyectado por el Kernel para que todos los plugins (Adaptadores/Addons)
 * puedan solicitar o compartir su propio protector de peticiones.
 */
export class CircuitBreakerRegistry {
    constructor(configInstance, logger) {
        // Acceso inmutable a las configuraciones
        this.config = configInstance? configInstance.get() : {};
        this.logger = logger;

        // Mapa contenedor de instancias de CircuitBreaker activas
        this.breakers = new Map();

        if (this.logger) this.logger.info('Inicializando CircuitBreakerRegistry (Prevención de Fallos en Cascada)...');
    }

    /**
     * Obtiene una instancia existente de Circuit Breaker para un servicio dado,
     * o la crea al vuelo si no existe.
     *
     * @param {string} serviceName - Identificador del proveedor destino (ej. 'discord_api', 'telegram_webhook')
     * @param {Object} options - Opciones de configuración (failureThreshold, resetTimeout, requestTimeout)
     */
    get(serviceName, options = {}) {
        if (!this.breakers.has(serviceName)) {
            const breaker = new CircuitBreaker(serviceName, options, this.logger);
            this.breakers.set(serviceName, breaker);

            if (this.logger) {
                this.logger.debug(`CircuitBreaker instanciado para el servicio: [${serviceName}]`);
            }
        }
        return this.breakers.get(serviceName);
    }

    /**
     * Obtiene una instantánea global de la salud de todos los servicios registrados.
     */
    getGlobalHealth() {
        const health = {};
        for (const [name, breaker] of this.breakers.entries()) {
            health[name] = breaker.getSnapshot();
        }
        return health;
    }
}
