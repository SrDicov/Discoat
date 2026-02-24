import { EventEmitter } from 'node:events';

export default class CircuitBreaker extends EventEmitter {
    constructor(serviceName, options = {}) {
        super();
        this.serviceName = serviceName;

        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeout = options.resetTimeout || 30000;
        this.requestTimeout = options.requestTimeout || 5000;

        this.state = 'CLOSED';
        this.failureCount = 0;
        this.nextAttempt = Date.now();

        this.metrics = {
            total: 0,
            success: 0,
            failed: 0,
            rejected: 0
        };
    }

    async fire(command, fallback = null) {
        this.metrics.total++;

        if (this.state === 'OPEN') {
            if (Date.now() > this.nextAttempt) {
                this._transition('HALF_OPEN');
            } else {
                this.metrics.rejected++;
                if (fallback) return fallback();
                throw new Error(`CircuitBreaker [${this.serviceName}] is OPEN`);
            }
        }

        try {
            const result = await this._executeWithTimeout(command);

            this._onSuccess();
            return result;

        } catch (error) {
            this._onFailure(error);
            if (fallback) return fallback(error);
            throw error;
        }
    }

    async _executeWithTimeout(command) {
        let timeoutHandle;

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error(`Operation timed out after ${this.requestTimeout}ms`));
            }, this.requestTimeout);
        });

        try {
            const result = await Promise.race([command(), timeoutPromise]);
            return result;
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    _onSuccess() {
        this.metrics.success++;
        this.failureCount = 0;

        if (this.state === 'HALF_OPEN') {
            this._transition('CLOSED');
        }
    }

    _onFailure(error) {
        this.metrics.failed++;
        this.failureCount++;

        if (this.state === 'HALF_OPEN') {
            this._transition('OPEN');
        } else if (this.failureCount >= this.failureThreshold) {
            this._transition('OPEN');
        }
    }

    _transition(newState) {
        this.state = newState;

        if (newState === 'OPEN') {
            this.nextAttempt = Date.now() + this.resetTimeout;
            this.emit('open', { service: this.serviceName, nextRetry: this.nextAttempt });
        } else if (newState === 'CLOSED') {
            this.emit('close', { service: this.serviceName });
        } else if (newState === 'HALF_OPEN') {
            this.emit('half_open', { service: this.serviceName });
        }
    }

    getSnapshot() {
        return {
            name: this.serviceName,
            state: this.state,
            failures: this.failureCount,
            metrics: this.metrics
        };
    }
}