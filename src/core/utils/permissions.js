import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Logger from './observability.js';

const PERM_FILE = path.resolve('config/permissions.json');

let permCache = Object.freeze({ roles: { owner: [], admin: [], mod: [] } });

loadPermissions();

fs.watchFile(PERM_FILE, { interval: 5000 }, (curr, prev) => {
    if (curr.mtime > prev.mtime) {
        Logger.info('ACL', 'Detectado cambio en permisos. Recargando...');
        loadPermissions();
    }
});

function loadPermissions() {
    try {
        if (!fs.existsSync(PERM_FILE)) {
            Logger.warn('ACL', 'Archivo de permisos no encontrado. Usando defaults.');
            return;
        }
        const data = fs.readFileSync(PERM_FILE, 'utf8');
        const json = JSON.parse(data);
        permCache = Object.freeze(json);
        Logger.info('ACL', 'Base de datos de permisos actualizada.');
    } catch (error) {
        Logger.error('ACL', 'Error cargando permisos', { error });
    }
}

function normalizeId(platform, userId) {
    if (!userId) return '';
    const pid = String(userId).trim();

    switch (platform) {
        case 'wa':
            return pid.split('@')[0].replace(/\+/g, '');
        case 'mx':
            return pid.toLowerCase();
        default:
            return pid;
    }
}

export function getRole(platform, userId) {
    if (!userId) return 0;

    const cleanId = normalizeId(platform, userId);
    const p = platform.toLowerCase();

    const check = (list) => list?.some(u =>
    String(u.id) === cleanId && (u.platform === '*' || u.platform === p)
    );

    if (check(permCache.roles.owner)) return 3;
    if (check(permCache.roles.admin)) return 2;
    if (check(permCache.roles.mod)) return 1;

    return 0;
}

export function isOwner(platform, userId) {
    return getRole(platform, userId) >= 3;
}

export function isAdmin(platform, userId) {
    return getRole(platform, userId) >= 2;
}

export default { getRole, isOwner, isAdmin };