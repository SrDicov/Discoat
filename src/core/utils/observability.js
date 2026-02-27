// src/core/utils/observability.js
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const asyncLocalStorage = new AsyncLocalStorage();

export class Logger {
    constructor(configInstance) {
        this.config = configInstance ? configInstance.get() : {};
        const sysConfig = this.config.system || {};

        this.env = sysConfig.env || 'production';
        this.logLevel = sysConfig.logLevel || (this.env === 'production' ? 'info' : 'debug');
        this.nodeId = sysConfig.nodeId || 'core-unknown';

        this.levels = { debug: 10, info: 20, warn: 30, error: 40 };
    }

    withCorrelation(correlationData, fn) {
        let contextData = {};

        if (typeof correlationData === 'string') {
            contextData = { correlationId: correlationData };
        } else if (correlationData && typeof correlationData === 'object') {
            contextData = { ...correlationData };
        }

        if (!contextData.correlationId) {
            contextData.correlationId = randomUUID();
        }

        return asyncLocalStorage.run(contextData, fn);
    }

    getCorrelationId() {
        const store = asyncLocalStorage.getStore();
        return store ? store.correlationId : null;
    }

    _log(level, message, metadata = {}) {
        if (this.levels[level] < this.levels[this.logLevel]) return;

        const store = asyncLocalStorage.getStore() || {};
        const correlationId = store.correlationId || randomUUID();

        const logEntry = {
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            nodeId: this.nodeId,
            correlationId,
            ...store,
            message,
            ...metadata
        };

        if (metadata.error instanceof Error) {
            logEntry.error = {
                message: metadata.error.message,
                name: metadata.error.name,
                stack: metadata.error.stack
            };
        }

        const jsonOutput = JSON.stringify(logEntry);

        if (level === 'error') {
            console.error(jsonOutput);
        } else if (level === 'warn') {
            console.warn(jsonOutput);
        } else {
            console.log(jsonOutput);
        }
    }

    info(message, metadata = {}) {
        this._log('info', message, metadata);
    }

    error(message, metadata = {}) {
        this._log('error', message, metadata);
    }

    warn(message, metadata = {}) {
        this._log('warn', message, metadata);
    }

    debug(message, metadata = {}) {
        this._log('debug', message, metadata);
    }
}
