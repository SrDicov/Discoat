import pg from 'pg';

export default class Repository {
    constructor(config) {
        this.config = config;
        this.pool = new pg.Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false
        });
    }

    async connect() {
        await this.pool.query('SELECT 1');
        await this._initSchema();
    }

    async disconnect() {
        await this.pool.end();
    }

    async _initSchema() {
        await this.pool.query(`
        CREATE TABLE IF NOT EXISTS bridges (
            id TEXT PRIMARY KEY,
            name TEXT,
            status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        `);

        await this.pool.query(`
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            native_id TEXT NOT NULL,
            bridge_id TEXT REFERENCES bridges(id) ON DELETE SET NULL,
                                             config JSONB
        )
        `);

        await this.pool.query('CREATE INDEX IF NOT EXISTS idx_channels_bridge ON channels(bridge_id)');
        await this.pool.query('CREATE INDEX IF NOT EXISTS idx_channels_native ON channels(platform, native_id)');

        await this.pool.query(`
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value JSONB
        )
        `);
    }

    async getBridgeTopology(bridgeId) {
        const { rows } = await this.pool.query(`
        SELECT id, platform, native_id, config
        FROM channels
        WHERE bridge_id = $1
        `, [bridgeId]);

        return rows.map(row => ({
            ...row,
            config: row.config || {}
        }));
    }

    async getChannelLink(platform, nativeId) {
        const id = `${platform}:${nativeId}`;
        const { rows } = await this.pool.query(
            'SELECT bridge_id, config FROM channels WHERE id = $1',
            [id]
        );

        if (rows.length === 0) return null;
        return {
            bridge_id: rows[0].bridge_id,
            config: rows[0].config || {}
        };
    }

    async linkChannelToBridge(bridgeId, platform, nativeId, config = {}) {
        const id = `${platform}:${nativeId}`;
        await this.pool.query(`
        INSERT INTO channels (id, platform, native_id, bridge_id, config)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
        bridge_id = EXCLUDED.bridge_id,
        config = EXCLUDED.config
        `, [id, platform, nativeId, bridgeId, JSON.stringify(config)]);
    }

    async unlinkChannel(platform, nativeId) {
        const id = `${platform}:${nativeId}`;
        await this.pool.query('DELETE FROM channels WHERE id = $1', [id]);
    }

    async createBridge(id, name) {
        await this.pool.query(
            'INSERT INTO bridges (id, name) VALUES ($1, $2)',
                              [id, name]
        );
    }

    async getBridge(id) {
        const { rows } = await this.pool.query(
            'SELECT * FROM bridges WHERE id = $1',
            [id]
        );
        return rows[0] || null;
    }

    async getKV(key) {
        const { rows } = await this.pool.query(
            'SELECT value FROM kv_store WHERE key = $1',
            [key]
        );
        return rows.length ? rows[0].value : null;
    }

    async setKV(key, value) {
        await this.pool.query(`
        INSERT INTO kv_store (key, value) VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [key, JSON.stringify(value)]);
    }
}
