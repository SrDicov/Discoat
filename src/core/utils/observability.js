import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const contextStorage = new AsyncLocalStorage();

const LEVELS = {
    ERROR: { val: 50, color: '\x1b[31m' },
    WARN:  { val: 40, color: '\x1b[33m' },
    INFO:  { val: 30, color: '\x1b[36m' },
    DEBUG: { val: 20, color: '\x1b[35m' },
    TRACE: { val: 10, color: '\x1b[90m' }
};

const RESET_COLOR = '\x1b[0m';
const GRAY_COLOR = '\x1b[90m';

class Observability {
    constructor() {
        this.logDir = path.resolve('data/logs');
        this.logFile = path.join(this.logDir, 'app.jsonl');
        this.stream = null;
        this._init();
    }

    _init() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
        process.on('exit', () => this.stream.end());
    }

    withCorrelation(context, callback) {
        const store = {
            correlationId: context.correlationId || randomUUID(),
            source: context.source || 'system',
            startTime: Date.now(),
            ...context
        };

        return contextStorage.run(store, callback);
    }

    getCorrelationId() {
        const store = contextStorage.getStore();
        return store?.correlationId || randomUUID();
    }

    info(section, message, meta = {}) { this._log('INFO', section, message, meta); }
    warn(section, message, meta = {}) { this._log('WARN', section, message, meta); }
    error(section, message, meta = {}) { this._log('ERROR', section, message, meta); }
    debug(section, message, meta = {}) { this._log('DEBUG', section, message, meta); }

    _log(levelName, section, message, meta) {
        const timestamp = new Date().toISOString();
        const store = contextStorage.getStore() || {};

        const logData = {
            ts: timestamp,
            lvl: levelName,
            sec: section,
            cid: store.correlationId || meta.correlationId || null,
            src: store.source || 'core',
            msg: message,
            ...meta
        };

        if (logData.error instanceof Error) {
            logData.error = {
                message: logData.error.message,
                stack: logData.error.stack,
                name: logData.error.name,
                code: logData.error.code
            };
        }

        if (this.stream && this.stream.writable) {
            this.stream.write(JSON.stringify(logData) + '\n');
        }

        if (process.env.NODE_ENV !== 'production') {
            this._printConsole(levelName, section, message, logData);
        }
    }

    _printConsole(levelName, section, message, logData) {
        const config = LEVELS[levelName];
        const timeShort = new Date().toLocaleTimeString();
        const cidShort = logData.cid ? logData.cid.slice(0, 8) : '--------';

        let line = `${GRAY_COLOR}[${timeShort}]${RESET_COLOR} `;
        line += `${config.color}${levelName.padEnd(5)}${RESET_COLOR} `;
        line += `${GRAY_COLOR}[${section}]${RESET_COLOR} `;
        line += `${GRAY_COLOR}<${cidShort}>${RESET_COLOR} `;
        line += message;

        const { ts, lvl, sec, cid, src, msg, ...rest } = logData;
        if (Object.keys(rest).length > 0) {
            line += `\n${GRAY_COLOR}${util.inspect(rest, { colors: true, depth: null, breakLength: Infinity })}${RESET_COLOR}`;
        }
    }
}

const loggerInstance = new Observability();
export default loggerInstance;