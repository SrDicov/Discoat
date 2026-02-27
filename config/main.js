import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
                           NODE_ID: z.string().default('core-01'),
                           PORT: z.string().transform(Number).default('3000'),
                           PUBLIC_URL: z.string().url().default('http://localhost:3000'),
                           DATABASE_URL: z.string().url({ message: "Postgres URL requerida" }),
                           REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
                           S3_BUCKET: z.string(),
                           S3_REGION: z.string().default('us-east-1'),
                           S3_ACCESS_KEY: z.string(),
                           S3_SECRET_KEY: z.string(),
                           S3_ENDPOINT: z.string().optional(),
                           CDN_URL: z.string().url(),
                           DISCORD_TOKEN: z.string().optional(),
                           TELEGRAM_TOKEN: z.string().optional(),
                           STOAT_TOKEN: z.string().optional(),
                           OPENAI_API_KEY: z.string().optional(),
                           SIGNAL_PHONE: z.string().optional()
});

export class Config {
    constructor() {
        this.settings = null;
    }

    async load() {
        const parsed = envSchema.safeParse(process.env);

        if (!parsed.success) {
            console.error('Error crítico: Variables de entorno inválidas o faltantes.', parsed.error.format());
            process.exit(1);
        }

        const env = parsed.data;

        this.settings = Object.freeze({
            system: Object.freeze({
                env: env.NODE_ENV,
                nodeId: env.NODE_ID,
                logLevel: env.NODE_ENV === 'production'? 'info' : 'debug'
            }),
            network: Object.freeze({
                port: env.PORT,
                public_url: env.PUBLIC_URL
            }),
            database: Object.freeze({
                url: env.DATABASE_URL,
                ssl: env.NODE_ENV === 'production'
            }),
            redis: Object.freeze({
                url: env.REDIS_URL
            }),
            storage: Object.freeze({
                bucket: env.S3_BUCKET,
                region: env.S3_REGION,
                credentials: Object.freeze({
                    accessKeyId: env.S3_ACCESS_KEY,
                    secretAccessKey: env.S3_SECRET_KEY
                }),
                endpoint: env.S3_ENDPOINT,
                cdnUrl: env.CDN_URL
            }),
            integrations: Object.freeze({
                discord: env.DISCORD_TOKEN,
                telegram: env.TELEGRAM_TOKEN,
                stoat: env.STOAT_TOKEN,
                openai: env.OPENAI_API_KEY,
                signal: Object.freeze({
                    phone: env.SIGNAL_PHONE,
                    mode: 'json-rpc'
                })
            }),
            bot: Object.freeze({
                prefixes: Object.freeze(['.', '/'])
            })
        });
    }

    get() {
        return this.settings;
    }
}