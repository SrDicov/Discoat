import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import sharp from 'sharp';

export default class StorageService {
    constructor(context) {
        this.config = context.config;
        this.logger = context.logger;
        this.storagePath = path.resolve('data/storage');
        this.publicBaseUrl = this.config.public_url || 'http://localhost:3000/files';
    }

    async init() {
        if (!fs.existsSync(this.storagePath)) {
            fs.mkdirSync(this.storagePath, { recursive: true });
        }
    }

    async storeFromUrl(url, options = {}) {
        const fileId = randomUUID();
        const traceId = this.logger.getCorrelationId();

        try {
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                timeout: 20000
            });

            let extension = this._getExtensionFromMime(response.headers['content-type']);
            let transformStream = null;

            if (options.type === 'image' || options.type === 'sticker') {
                transformStream = this._createImagePipeline(options);
                if (transformStream) extension = options.optimizeFor === 'wa' ? 'webp' : 'png';
            }

            const fileName = `${fileId}.${extension}`;
            const filePath = path.join(this.storagePath, fileName);
            const writeStream = createWriteStream(filePath);

            const streams = [response.data];
            if (transformStream) streams.push(transformStream);
            streams.push(writeStream);

            await pipeline(...streams);

            const stat = await fs.promises.stat(filePath);

            return {
                id: fileId,
                url: `${this.publicBaseUrl}/${fileName}`,
                localPath: filePath,
                mime_type: this._getMimeFromExtension(extension),
                size: stat.size,
                filename: fileName
            };

        } catch (error) {
            throw error;
        }
    }

    getStream(fileName) {
        const filePath = path.join(this.storagePath, fileName);
        if (!fs.existsSync(filePath)) return null;
        return createReadStream(filePath);
    }

    async delete(fileName) {
        try {
            await fs.promises.unlink(path.join(this.storagePath, fileName));
        } catch (e) {
        }
    }

    _createImagePipeline(options) {
        const pipeline = sharp({ animated: true, limitInputPixels: false });

        if (options.type === 'sticker' && options.optimizeFor === 'wa') {
            return pipeline
            .resize(512, 512, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
            .webp({ quality: 50 });
        }

        return pipeline
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .rotate();
    }

    _getExtensionFromMime(mime) {
        const map = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'video/mp4': 'mp4',
            'application/pdf': 'pdf',
            'audio/ogg': 'ogg',
            'audio/mpeg': 'mp3'
        };
        return map[mime] || 'bin';
    }

    _getMimeFromExtension(ext) {
        const map = {
            'jpg': 'image/jpeg',
            'png': 'image/png',
            'webp': 'image/webp',
            'gif': 'image/gif',
            'mp4': 'video/mp4'
        };
        return map[ext] || 'application/octet-stream';
    }
}