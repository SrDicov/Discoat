// src/core/infra/repository.js
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Capa de acceso a datos y persistencia.
 * Gestiona la topología de la red (qué canal está conectado con cuál) usando un modelo
 * centralizado N-a-N (Canales Virtuales) en lugar de acoplamientos rígidos 1-a-1.
 */
export class Repository {
    constructor(configInstance, logger) {
        // CORRECCIÓN: Acceso directo al objeto plano inyectado por el contenedor DI
        this.config = configInstance || {};
        this.logger = logger;
        this.db = null;

        // Se aísla la persistencia en el directorio local data/
        this.dbPath = path.resolve(process.cwd(), 'data', 'topology.db');
    }

    /**
     * Establece la conexión con la base de datos SQLite.
     */
    async connect() {
        if (this.logger) this.logger.info('Inicializando repository..');

        try {
            // Garantizar que el directorio data/ exista en el host
            const dataDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            // Se mantiene better-sqlite3 sobre node:sqlite nativo debido a su
            // superioridad demostrada en operaciones concurrentes y gestión de memoria.
            this.db = new Database(this.dbPath);

            // Optimización Crítica: Habilitar Write-Ahead Logging (WAL)
            // Permite múltiples lectores concurrentes mientras un escritor opera,
            // evitando el bloqueo del Event Loop durante la alta transaccionalidad del enrutador N-a-N.
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('foreign_keys = ON');

            this._initializeSchema();

            if (this.logger) this.logger.info('Repository conectado y esquemas validados en modo WAL.');
        } catch (error) {
            if (this.logger) this.logger.error('Fallo crítico al conectar con la base de datos local:', { error });
            throw error;
        }
    }

    /**
     * Define y asegura la existencia de la estructura de tablas para los "Virtual Channels" (Bridges).
     */
    _initializeSchema() {
        const schema = `
        CREATE TABLE IF NOT EXISTS bridges (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'on' CHECK(status IN ('on', 'off', 'paused')),
                                            created_at INTEGER DEFAULT (cast(strftime('%s','now') as int))
        );

        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            bridge_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            native_id TEXT NOT NULL,
            config JSON DEFAULT '{}',
            added_at INTEGER DEFAULT (cast(strftime('%s','now') as int)),
                                             FOREIGN KEY (bridge_id) REFERENCES bridges(id) ON DELETE CASCADE,
                                             UNIQUE(platform, native_id)
        );

        CREATE INDEX IF NOT EXISTS idx_channels_bridge ON channels(bridge_id);
        `;

        this.db.exec(schema);

        // Pre-compilación de sentencias (Prepared Statements) para máximo rendimiento
        // en la ruta caliente (Hot Path) de evaluación por cada mensaje entrante.
        this.stmtGetLink = this.db.prepare(`
        SELECT c.bridge_id, b.status
        FROM channels c
        JOIN bridges b ON c.bridge_id = b.id
        WHERE c.platform =? AND c.native_id =?
        `);

        this.stmtGetTopology = this.db.prepare(`
        SELECT platform, native_id, config
        FROM channels
        WHERE bridge_id =?
        `);
    }

    /**
     * Consulta si un canal nativo (origen) pertenece a un grupo/puente multiconexión.
     * Retorna el ID del puente y su estado actual.
     *
     * @param {string} platform - Nombre de la red (ej. 'discord', 'whatsapp')
     * @param {string} nativeId - Identificador original del grupo o chat
     */
    getChannelLink(platform, nativeId) {
        try {
            return this.stmtGetLink.get(platform, nativeId);
        } catch (error) {
            if (this.logger) this.logger.error('Error al consultar enlace de canal', { error, platform, nativeId });
            return null;
        }
    }

    /**
     * Obtiene el listado completo de canales de destino adscritos a un mismo puente,
     * permitiendo al enrutador hacer una replicación en abanico (Fan-out).
     *
     * @param {string} bridgeId - UUID del puente
     */
    getBridgeTopology(bridgeId) {
        try {
            const results = this.stmtGetTopology.all(bridgeId);
            // Parsear configuraciones JSON almacenadas como texto
            return results.map(row => ({
                ...row,
                config: row.config ? JSON.parse(row.config) : {}
            }));
        } catch (error) {
            if (this.logger) this.logger.error('Error al consultar topología del puente', { error, bridgeId });
            return;
        }
    }

    /**
     * Crea un nuevo puente de interconexión (Clúster virtual).
     */
    createBridge(name, bridgeId = randomUUID()) {
        try {
            const insertBridge = this.db.prepare(`
            INSERT INTO bridges (id, name, status) VALUES (?,?, 'on')
            ON CONFLICT(id) DO NOTHING
            `);
            insertBridge.run(bridgeId, name);
            if (this.logger) this.logger.info(`Nuevo puente creado: [${name}] con ID: ${bridgeId}`);
            return bridgeId;
        } catch (error) {
            if (this.logger) this.logger.error('Error al crear puente', { error, name });
            throw error;
        }
    }

    /**
     * Conecta un canal de una plataforma externa a un puente existente.
     * Soporta Upsert: Si el canal ya existe, actualiza sus configuraciones o lo migra de puente.
     */
    linkChannelToBridge({ bridgeId, platform, nativeId, config = {} }) {
        try {
            const insertChannel = this.db.prepare(`
            INSERT INTO channels (id, bridge_id, platform, native_id, config)
            VALUES (?,?,?,?,?)
            ON CONFLICT(platform, native_id)
            DO UPDATE SET bridge_id = excluded.bridge_id, config = excluded.config
            `);

            const internalId = randomUUID();
            insertChannel.run(internalId, bridgeId, platform, nativeId, JSON.stringify(config));

            if (this.logger) this.logger.info(`Canal vinculado exitosamente: [${platform}] ${nativeId} -> Bridge: ${bridgeId}`);
            return true;
        } catch (error) {
            if (this.logger) this.logger.error('Error al enlazar canal al puente', { error, platform, nativeId, bridgeId });
            throw error;
        }
    }

    /**
     * Modifica el estado operativo del puente actuando como barrera automatizada (Cortocircuito manual).
     */
    updateBridgeStatus(bridgeId, status) {
        try {
            const update = this.db.prepare(`UPDATE bridges SET status =? WHERE id =?`);
            update.run(status, bridgeId);
            if (this.logger) this.logger.info(`Estado del puente ${bridgeId} modificado a: ${status}`);
            return true;
        } catch (error) {
            if (this.logger) this.logger.error('Error al actualizar estado del puente', { error, bridgeId, status });
            throw error;
        }
    }

    /**
     * Retorna una lista de los puentes globales que están emitiendo tráfico activo.
     */
    getAllActiveBridges() {
        try {
            const stmt = this.db.prepare(`SELECT id, name, status FROM bridges WHERE status = 'on'`);
            return stmt.all();
        } catch (error) {
            if (this.logger) this.logger.error('Error al obtener puentes activos', { error });
            return;
        }
    }

    /**
     * Apagado elegante: Cierra conexiones y purga los descriptores de lectura/escritura (Graceful Shutdown).
     */
    async disconnect() {
        if (this.db) {
            if (this.logger) this.logger.info('Ejecutando Checkpoint WAL y cerrando persistencia SQLite...');
            this.db.close();
            this.db = null;
        }
    }
}
