import 'dotenv/config';

export default {
    system: {
        env: process.env.NODE_ENV || "production",
        nodeId: process.env.NODE_ID || "core-01",
        logLevel: process.env.LOG_LEVEL || "INFO"
    },
    bot: {
        prefixes: [".", ",", "!", "#", "/"],
        admins: []
    },
    database: {
        provider: "sqlite",
        path: process.env.DB_PATH || "data/openchat_core.db",
        wal: true
    },
    paths: {
        whatsapp_auth: "data/auth_baileys",
        media_temp: "data/temp_media"
    },
    tokens: {
        discord: process.env.DISCORD_TOKEN,
        telegram: process.env.TELEGRAM_TOKEN,
        stoat: process.env.STOAT_TOKEN,
        signal: {
            phone: process.env.SIGNAL_PHONE,
            mode: "json-rpc"
        },
        openai: process.env.OPENAI_API_KEY
    },
    redis: {
        enabled: true,
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    },
    tuning: {
        max_listeners: 100,
        dedup_ttl: 30000
    }
};
