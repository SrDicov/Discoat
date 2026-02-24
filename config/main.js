import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
                           NODE_ID: z.string().default('core-01'),
                           DATABASE_URL: z.string().url({ message: "Postgres URL requerida" }),
                           REDIS_URL: z.string().url({ message: "Redis URL requerida" }),
                           S3_BUCKET: z.string(),
                           S3_REGION: z.string().default('us-east-1'),
                           S3_ACCESS_KEY: z.string(),
                           S3_SECRET_KEY: z.string(),
                           S3_ENDPOINT: z.string().optional(),
                           CDN_URL: z.string().url(),
                           DISCORD_TOKEN: z.string().optional(),
                           TELEGRAM_TOKEN: z.string().optional(),
                           OPENAI_API_KEY: z.string().optional(),
});

const env = envSchema.parse(process.env);

export default {
    system: {
        env: env.NODE_ENV,
        nodeId: env.NODE_ID,
        logLevel: env.NODE_ENV === 'production' ? 'info' : 'debug'
    },
    database: {
        url: env.DATABASE_URL,
        ssl: env.NODE_ENV === 'production'
    },
    redis: {
        url: env.REDIS_URL
    },
    storage: {
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        credentials: {
            accessKeyId: env.S3_ACCESS_KEY,
            secretAccessKey: env.S3_SECRET_KEY
        },
        endpoint: env.S3_ENDPOINT,
        cdnUrl: env.CDN_URL
    },
    tokens: {
        discord: env.DISCORD_TOKEN,
        telegram: env.TELEGRAM_TOKEN,
        openai: env.OPENAI_API_KEY
    },
    bot: {
        prefixes: [".", "/"]
    }
};
