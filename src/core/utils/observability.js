import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const asyncLocalStorage = new AsyncLocalStorage();

const transport = pino.transport({
    target: 'pino-pretty',
    options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
    }
});

const baseLogger = pino({ level: process.env.LOG_LEVEL || 'info' }, transport);

const logger = {
    info: (section, msg, data) => log('info', section, msg, data),
    error: (section, msg, data) => log('error', section, msg, data),
    warn: (section, msg, data) => log('warn', section, msg, data),
    debug: (section, msg, data) => log('debug', section, msg, data),

    withCorrelation: (context, fn) => {
        const store = {
            correlationId: context.correlationId || randomUUID(),
            source: context.source || 'system'
        };
        return asyncLocalStorage.run(store, fn);
    }
};

function log(level, section, msg, data = {}) {
    const store = asyncLocalStorage.getStore();
    const logData = {
        section,
        cid: store?.correlationId || null,
        src: store?.source || 'core',
        ...data
    };

    if (data.error instanceof Error) {
        logData.stack = data.error.stack;
        logData.error = data.error.message;
    }

    baseLogger[level](logData, msg);
}

export default logger;
