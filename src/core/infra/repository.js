import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export default class Repository {
    constructor() {
        this.db = null;
        this.context = null;
    }

    async init(context) {
        this.context = context;
    }

    async connect() {
        try {
            const dataDir = path.resolve('data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            const dbPath = path.join(dataDir, 'core.db');
            this.context.logger.info({ section: 'infra:repo', path: dbPath }, 'Conectando a SQLite local...');

            this.db = new Database(dbPath);
            this.db.pragma('journal_mode = WAL');

            this._initializeSchema();

            this.context.logger.info({ section: 'infra:repo' }, 'Base de datos SQLite conectada y esquema verificado.');
        } catch (error) {
            this.context.logger.error({ section: 'infra:repo', err: error }, 'Fallo crítico conectando a SQLite');
            throw error;
        }
    }

    async disconnect() {
        if (this.db) {
            this.context.logger.info({ section: 'infra:repo' }, 'Cerrando conexión SQLite...');
            this.db.close();
            this.db = null;
        }
    }

    _initializeSchema() {
        this.db.prepare(`
        CREATE TABLE IF NOT EXISTS bridges (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            created_at INTEGER,
            meta JSON
        )
        `).run();

        this.db.prepare(`
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            bridge_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            identifier TEXT NOT NULL,
            config JSON,
            FOREIGN KEY(bridge_id) REFERENCES bridges(id) ON DELETE CASCADE
        )
        `).run();

        this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_channels_bridge ON channels(bridge_id)`).run();
        this.db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_platform ON channels(platform, identifier)`).run();
    }

    getBridgeTopology(bridgeId) {
        const bridge = this.db.prepare('SELECT * FROM bridges WHERE id = ?').get(bridgeId);
        if (!bridge) return null;

        const channels = this.db.prepare('SELECT * FROM channels WHERE bridge_id = ?').all(bridgeId);

        return {
            ...bridge,
            channels: channels.map(c => ({
                ...c,
                config: c.config ? JSON.parse(c.config) : {}
            }))
        };
    }

    getAllActiveBridges() {
        return this.db.prepare("SELECT id FROM bridges WHERE status = 'active'").all();
    }

    findBridgeByChannel(platform, identifier) {
        const channel = this.db.prepare(
            'SELECT bridge_id FROM channels WHERE platform = ? AND identifier = ?'
        ).get(platform, identifier);

        return channel ? channel.bridge_id : null;
    }

    createBridge(id, name) {
        this.db.prepare(
            'INSERT INTO bridges (id, name, status, created_at) VALUES (?, ?, ?, ?)'
        ).run(id, name, 'active', Date.now());
    }

    addChannelToBridge(bridgeId, platform, identifier, config = {}) {
        const id = `${platform}_${identifier}`;
        this.db.prepare(
            'INSERT INTO channels (id, bridge_id, platform, identifier, config) VALUES (?, ?, ?, ?, ?)'
        ).run(id, bridgeId, platform, identifier, JSON.stringify(config));
    }
}
