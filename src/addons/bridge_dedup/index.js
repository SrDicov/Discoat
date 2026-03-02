// src/addons/bridge_dedup/index.js
import { createHash } from 'node:crypto';

export default class BridgeDedup {
    async init(ctx) {
        this.ctx = ctx;
        // Requerimos que el inyector de dependencias provea el cliente Redis
        if (!this.ctx.redis) throw new Error('Dependencia Redis no inyectada en el Microkernel');
    }

    async start() {
        this.ctx.bus.on('message.ingress', async (umf) => {
            // Generar huella digital inmutable
            const hash = createHash('sha256')
                .update(`${umf.body.text}:${umf.head.source.userId}:${umf.head.source.channelId}`)
                .digest('hex');

            const redisKey = `dedup:${hash}`;

            // Bloqueo Atómico: SETNX asigna el valor solo si NO existe.
            // Asignamos un TTL de 60 segundos transitorios.
            const isNew = await this.ctx.redis.set(redisKey, '1', 'NX', 'EX', 60);

            if (!isNew) {
                this.ctx.logger.warn(`[BridgeDedup] Colisión detectada: Descartando evento duplicado ${hash}`);
                umf._isDuplicate = true;
                return;
            }
        });
    }

    async stop() {
        // Ya no hay setInterval que limpiar
    }

    async health() {
        return { status: 'active', mode: 'distributed-redis' };
    }
}