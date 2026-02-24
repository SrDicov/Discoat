// src/core/infra/repository.js
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export default class Repository {
    constructor(config) {
        this.config = config;
        this.dbPath = path.resolve('data/core.db');
        this.sqlite = null;
        this.context = null;
    }

    async init(context) {
        this.context = context;
    }

    async connect() {
        const dataDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        this.sqlite = new Database(this.dbPath);
        this.sqlite.pragma('journal_mode = WAL');
        this._initSchema();
    }

    async disconnect() {
        if (this.sqlite) {
            this.sqlite.close();
            this.sqlite = null;
        }
    }

    close() { this.disconnect(); }

    _initSchema() {
        this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS bridges (
            id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active'
        )
        `);
        this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY, platform TEXT, native_id TEXT, bridge_id TEXT, config TEXT
        )
        `);
        this.sqlite.exec(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`);
    }

    getChannelLink(platform, nativeId) {
        if (!this.sqlite) throw new Error('DB no conectada');
        const stmt = this.sqlite.prepare('SELECT bridge_id, config FROM channels WHERE id = ?');
        const row = stmt.get(`${platform}:${nativeId}`);
        return row ? { bridge_id: row.bridge_id, config: JSON.parse(row.config || '{}') } : null;
    }

    getBridgeTopology(bridgeId) {
        const stmt = this.sqlite.prepare('SELECT * FROM channels WHERE bridge_id = ?');
        return stmt.all(bridgeId).map(r => ({ ...r, config: JSON.parse(r.config || '{}') }));
    }

    getKV(key) {
        const row = this.sqlite.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : null;
    }

    setKV(key, value) {
        const stmt = this.sqlite.prepare(`
        INSERT INTO kv_store (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        stmt.run(key, JSON.stringify(value));
    }

    createBridge(id, name) {
        this.sqlite.prepare('INSERT INTO bridges (id, name) VALUES (?, ?)').run(id, name);
    }

    linkChannelToBridge(bridgeId, platform, nativeId, config = {}) {
        const id = `${platform}:${nativeId}`;
        const stmt = this.sqlite.prepare(`
        INSERT INTO channels (id, platform, native_id, bridge_id, config)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET bridge_id = excluded.bridge_id
        `);
        stmt.run(id, platform, nativeId, bridgeId, JSON.stringify(config));
    }
}
