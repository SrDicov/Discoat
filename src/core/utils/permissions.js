// src/core/utils/permissions.js
import fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Gestor Central de Permisos y Roles (ACL).
 * Implementa seguridad criptográfica, inmutabilidad de estado y recarga en caliente (Hot-Reload).
 * Resuelve el acceso de los usuarios en O(1) tiempo.
 */
export class PermissionManager {
    constructor(configInstance, logger) {
        // Inyección de dependencias
        this.config = configInstance? configInstance.get() : {};
        this.logger = logger;

        // Ruta estricta al archivo de permisos estático
        this.permissionsPath = path.resolve(process.cwd(), 'config', 'permissions.json');

        // Caché en RAM (completamente inmutable)
        this.permCache = null;

        // Hashes de Sudo Global extraídos directamente del entorno para mayor seguridad (No van a BD)
        const sudoEnv = process.env.GLOBAL_SUDO  ||  '';
        this.sudoHashes = sudoEnv.split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0)
        .map(id => this._hashId(id));

        this.DEFAULT_PERMS = Object.freeze({
            owner: [],
            admin: [],
            mod: []
        });
    }

    /**
     * Fase de Inicialización: Carga inicial y enganche del watcher de Hot-Reload.
     */
    async init() {
        if (this.logger) this.logger.info('Inicializando PermissionManager (ACL Criptográfico)...');
        await this._loadPermissions();
        this._setupHotReload();
    }

    /**
     * Helper para ofuscar IDs sensibles antes de la comparación.
     */
    _hashId(userId) {
        return crypto.createHash('sha256').update(String(userId)).digest('hex');
    }

    /**
     * Asegura la inmutabilidad absoluta de la caché (Previene contaminación cruzada de plugins).
     */
    _deepFreeze(obj) {
        Object.keys(obj).forEach(prop => {
            if (typeof obj[prop] === 'object' && obj[prop]!== null &&!Object.isFrozen(obj[prop])) {
                this._deepFreeze(obj[prop]);
            }
        });
        return Object.freeze(obj);
    }

    /**
     * Carga asíncrona de los permisos en el sistema de archivos.
     */
    async _loadPermissions() {
        try {
            const data = await fs.readFile(this.permissionsPath, 'utf-8');
            const parsed = JSON.parse(data);
            this.permCache = this._deepFreeze({...this.DEFAULT_PERMS,...parsed });
            if (this.logger) this.logger.debug('Lista de control de acceso (ACL) actualizada en RAM.');
        } catch (error) {
            if (this.logger) this.logger.warn(`No se encontró o es inválido permissions.json. Aislando a DEFAULT_PERMS.`, { error: error.message });
            this.permCache = this.DEFAULT_PERMS;
        }
    }

    /**
     * Monitor de sistema de archivos (FS). Si un administrador edita permissions.json,
     * el sistema recarga las reglas dinámicamente sin reiniciar los procesos.
     */
    _setupHotReload() {
        watchFile(this.permissionsPath, { interval: 2000 }, async (curr, prev) => {
            if (curr.mtime!== prev.mtime) {
                if (this.logger) this.logger.info('Cambio detectado en permissions.json. Ejecutando Hot-Reload en memoria...');
                await this._loadPermissions();
            }
        });
    }

    /**
     * Normaliza los formatos dispares de cada red.
     * Ejemplo: Strip de dominios `@s.whatsapp.net` o prefijos `+` en WhatsApp.
     */
    _normalizeUserId(platform, userId) {
        let normalized = String(userId).trim();
        if (platform === 'whatsapp'  ||  platform === 'wa') {
            normalized = normalized.replace(/@.*$/, '').replace(/^\+/, '');
            }
            return normalized;
    }

    /**
     * Nivel 4 (Máximo): Validación criptográfica de Sudo Global en tiempo constante
     * para mitigar ataques de tiempo (Timing Attacks).
     */
    isGlobalSuperUser(userId) {
        if (this.sudoHashes.length === 0) return false;

        const inputHashStr = this._hashId(userId);
        const inputBuffer = Buffer.from(inputHashStr, 'hex');

        return this.sudoHashes.some(storedHashStr => {
            const storedBuffer = Buffer.from(storedHashStr, 'hex');
            // Validar longitud antes de comparar para evitar fallos del motor C++ de Node.js
            if (inputBuffer.length!== storedBuffer.length) return false;
            return crypto.timingSafeEqual(inputBuffer, storedBuffer);
        });
    }

    /**
     * Resuelve los privilegios del usuario de forma estructurada.
     *
     * Retorna un entero representando el nivel jerárquico:
     * 4: Global Sudo
     * 3: Owner
     * 2: Admin
     * 1: Mod
     * 0: Regular
     */
    getRole(platform, userId) {
        // Patrón Lazy-Load en caso de llamadas previas al inicio total del kernel
        if (!this.permCache) {
            this.permCache = this.DEFAULT_PERMS;
        }

        const normalizedId = this._normalizeUserId(platform, userId);

        if (this.isGlobalSuperUser(normalizedId)) return 4;

        // Evaluación de ruta rápida (Short-Circuit con.some)
        const checkRole = (roleArray) => {
            if (!Array.isArray(roleArray)) return false;
            return roleArray.some(entry => {
                const matchPlatform = entry.platform === '*'  ||  entry.platform === platform;
                const matchUser = String(entry.id) === normalizedId;
                return matchPlatform && matchUser;
            });
        };

        if (checkRole(this.permCache.owner)) return 3;
        if (checkRole(this.permCache.admin)) return 2;
        if (checkRole(this.permCache.mod)) return 1;

        return 0; // Default: Regular
    }

    /**
     * Apagado elegante (Graceful Shutdown)
     */
    async disconnect() {
        unwatchFile(this.permissionsPath);
        this.permCache = null;
        if (this.logger) this.logger.info('PermissionManager detenido. Watchers liberados.');
    }
}
