import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export default class Repository {
    constructor(config) {
        this.config = config;
        this.dbPath = path.resolve('data/openchat_core.db');
        this.db = null;
    }

    async connect() {
        const dataDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.db = new Database(this.dbPath);

        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        this._initSchema();
    }

    async disconnect() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    _initSchema() {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS bridges (
            id TEXT PRIMARY KEY,
            name TEXT,
            status TEXT DEFAULT 'active',
            created_at INTEGER DEFAULT (unixepoch())
        )
        `);

        this.db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            native_id TEXT NOT NULL,
            bridge_id TEXT,
            config TEXT,
            FOREIGN KEY(bridge_id) REFERENCES bridges(id) ON DELETE SET NULL
        )
        `);

        this.db.exec('CREATE INDEX IF NOT EXISTS idx_channels_bridge ON channels(bridge_id)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_channels_native ON channels(platform, native_id)');

        this.db.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        `);
    }

    getBridgeTopology(bridgeId) {
        const stmt = this.db.prepare(`
        SELECT id, platform, native_id, config
        FROM channels
        WHERE bridge_id = ?
        `);
        const rows = stmt.all(bridgeId);

        return rows.map(row => ({
            ...row,
            config: row.config ? JSON.parse(row.config) : {}
        }));
    }

    getChannelLink(platform, nativeId) {
        const id = `${platform}:${nativeId}`;
        const stmt = this.db.prepare('SELECT bridge_id, config FROM channels WHERE id = ?');
        const row = stmt.get(id);

        if (!row) return null;
        return {
            bridge_id: row.bridge_id,
            config: row.config ? JSON.parse(row.config) : {}
        };
    }

    linkChannelToBridge(bridgeId, platform, nativeId, config = {}) {
        const id = `${platform}:${nativeId}`;

        const stmt = this.db.prepare(`
        INSERT INTO channels (id, platform, native_id, bridge_id, config)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
        bridge_id = excluded.bridge_id,
        config = excluded.config
        `);

        stmt.run(id, platform, nativeId, bridgeId, JSON.stringify(config));
    }

    unlinkChannel(platform, nativeId) {
        const id = `${platform}:${nativeId}`;
        const stmt = this.db.prepare('DELETE FROM channels WHERE id = ?');
        stmt.run(id);
    }

    createBridge(id, name) {
        const stmt = this.db.prepare('INSERT INTO bridges (id, name) VALUES (?, ?)');
        stmt.run(id, name);
    }

    getBridge(id) {
        const stmt = this.db.prepare('SELECT * FROM bridges WHERE id = ?');
        return stmt.get(id);
    }

    getKV(key) {
        const stmt = this.db.prepare('SELECT value FROM kv_store WHERE key = ?');
        const row = stmt.get(key);
        return row ? JSON.parse(row.value) : null;
    }

    setKV(key, value) {
        const stmt = this.db.prepare(`
        INSERT INTO kv_store (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        stmt.run(key, JSON.stringify(value));
    }
}