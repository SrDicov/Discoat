// src/core/infra/storage.js
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';

/**
 * Gestor avanzado de almacenamiento y caché multimedia.
 * Abstrae la persistencia hacia la nube (S3/MinIO) para arquitecturas sin estado (Stateless),
 * y provee tuberías (pipelines) de transformación de imágenes de alto rendimiento.
 */
export class StorageService {
    constructor(configInstance, logger) {
        this.config = configInstance? configInstance.get() : {};
        this.logger = logger;
        this.s3Client = null;

        // Directorio efímero local para procesamiento transitorio y Worker Threads
        this.tempDir = path.resolve(process.cwd(), 'data', 'temp');

        const storageConf = this.config.storage  ||  {};
        this.bucket = storageConf.bucket  ||  'openchat-core';
        this.cdnUrl = storageConf.cdnUrl;
    }

    /**
     * Inicializa el directorio temporal local y el cliente de MinIO/S3 para almacenamiento distribuido.
     */
    async connect() {
        if (this.logger) this.logger.info('Inicializando StorageService (S3/MinIO y Tuberías de Transformación)...');

        try {
            await fs.mkdir(this.tempDir, { recursive: true });

            const s3Conf = this.config.storage;
            if (s3Conf && s3Conf.credentials?.accessKeyId) {
                this.s3Client = new S3Client({
                    region: s3Conf.region,
                    endpoint: s3Conf.endpoint,
                    credentials: s3Conf.credentials,
                    // forcePathStyle es vital para compatibilidad con MinIO auto-alojado
                    forcePathStyle: true
                });
                if (this.logger) this.logger.info('Conexión al clúster S3/MinIO establecida exitosamente.');
            } else {
                if (this.logger) this.logger.warn('Modo Degradado: No hay credenciales S3 configuradas. La persistencia distribuida fallará.');
            }
        } catch (error) {
            if (this.logger) this.logger.error('Fallo al inicializar la capa de almacenamiento', { error });
            throw error;
        }
    }

    /**
     * ========================================================================
     * SECCIÓN 1: PERSISTENCIA DISTRIBUIDA DE SESIONES (WA BAILEYS AUTH STATE)
     * ========================================================================
     * Evita la evaporación de claves criptográficas en entornos de contenedores
     * escalables (Kubernetes/Docker), permitiendo la reconexión de WhatsApp.
     */

    async saveSessionData(sessionId, fileName, dataString) {
        if (!this.s3Client) return;
        const key = `sessions/${sessionId}/${fileName}`;
        try {
            await this.s3Client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: dataString,
                ContentType: 'application/json'
            }));
        } catch (error) {
            if (this.logger) this.logger.error(`Error guardando estado de sesión [${key}] en S3`, { error });
        }
    }

    async readSessionData(sessionId, fileName) {
        if (!this.s3Client) return null;
        const key = `sessions/${sessionId}/${fileName}`;
        try {
            const response = await this.s3Client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: key
            }));
            return await response.Body.transformToString();
        } catch (error) {
            // Ignorar errores 404 (NoSuchKey) ya que Baileys los espera si el archivo no existe aún
            if (error.name!== 'NoSuchKey') {
                if (this.logger) this.logger.error(`Error leyendo estado de sesión [${key}] desde S3`, { error });
            }
            return null;
        }
    }

    async deleteSessionData(sessionId, fileName) {
        if (!this.s3Client) return;
        const key = `sessions/${sessionId}/${fileName}`;
        try {
            await this.s3Client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: key
            }));
        } catch (error) {
            if (this.logger) this.logger.error(`Error borrando estado de sesión [${key}] en S3`, { error });
        }
    }

    /**
     * ========================================================================
     * SECCIÓN 2: TUBERÍAS DE TRANSCODIFICACIÓN Y MANEJO MULTIMEDIA
     * ========================================================================
     */

    /**
     * Sube un archivo mediante un flujo de datos (Stream) a S3.
     * Soporta degradación a almacenamiento local si S3 no está disponible.
     */
    async uploadMedia(stream, meta) {
        const fileId = randomUUID();
        const extension = this._getExtensionFromMime(meta.mimeType);
        const fileName = `${fileId}.${extension}`;
        const key = `media/${fileName}`;

        if (this.s3Client) {
            // Subida a nube
            await this.s3Client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: stream,
                ContentType: meta.mimeType
            }));

            return {
                id: fileId,
                url: this.cdnUrl? `${this.cdnUrl}/${key}` : await this.getSignedUrl(key),
                mimeType: meta.mimeType
            };
        } else {
            // Fallback a almacenamiento temporal local
            const localPath = path.join(this.tempDir, fileName);
            const writeStream = createWriteStream(localPath);
            await pipeline(stream, writeStream);

            return {
                id: fileId,
                url: `file://${localPath}`, // Uso interno para adaptadores en desarrollo
                mimeType: meta.mimeType,
                localPath
            };
        }
    }

    /**
     * Genera una URL firmada de corta duración para descargar de forma segura un adjunto.
     */
    async getSignedUrl(key, expiresIn = 3600) {
        if (!this.s3Client) return null;
        const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
        return getSignedUrl(this.s3Client, command, { expiresIn });
    }

    /**
     * Descarga de red, optimiza al vuelo en memoria y transcodifica para puentes restringidos.
     * Utiliza Node.js 24 nativo (fetch) eliminando dependencias antiguas (axios).
     */
    async fetchAndProcessMedia(url, options = {}) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error(`Fallo HTTP ${response.status} al descargar medio`);

            const mimeType = response.headers.get('content-type')  ||  'application/octet-stream';
            let mediaStream = response.body;

            // Transcodificación estricta mediante Sharp sin escribir en disco (Memoria a Memoria)
            if (options.type === 'sticker' && options.optimizeFor === 'wa') {
                // Mandato Draconiano de WhatsApp: WebP, 512x512 exacto, Fit Contain transparente
                const transformStream = sharp({ animated: true })
                .resize(512, 512, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .webp({ quality: 50, lossless: false });

                // NOTA: Para stickers dinámicos (TGS/Lottie JSON) se requiere inyección de metadatos EXIF
                // o pasarlo a un Worker Thread con binarios C++ antes de este paso.

                mediaStream = mediaStream.pipeThrough(transformStream);
                meta.mimeType = 'image/webp';
            } else if (options.type === 'image') {
                // Optimización general para reducir consumo de red (Max 1920px)
                const transformStream = sharp({ animated: true })
                .rotate() // Auto-rotar basado en EXIF
                .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true });
                mediaStream = mediaStream.pipeThrough(transformStream);
            }

            return await this.uploadMedia(mediaStream, { mimeType });

        } catch (error) {
            if (this.logger) this.logger.error(`Error procesando media desde ${url}`, { error });
            throw error;
        }
    }

    /**
     * Helper interno para resolución rápida de extensiones sin paquetes externos.
     */
    _getExtensionFromMime(mime) {
        const mimeMap = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'video/mp4': 'mp4',
            'audio/ogg': 'ogg',
            'application/pdf': 'pdf'
        };
        return mimeMap[mime]  ||  'bin';
    }

    /**
     * Apagado elegante.
     */
    async disconnect() {
        if (this.s3Client) {
            if (this.logger) this.logger.info('Cerrando conexiones S3/MinIO...');
            this.s3Client.destroy();
            this.s3Client = null;
        }
    }
}
