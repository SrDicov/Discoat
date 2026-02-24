import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import axios from 'axios';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export default class StorageService {
    constructor(context) {
        this.config = context.config;
        this.logger = context.logger;
        this.bucket = process.env.S3_BUCKET;
        this.s3 = new S3Client({
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY,
                secretAccessKey: process.env.S3_SECRET_KEY
            },
            endpoint: process.env.S3_ENDPOINT
        });
    }

    async init() {
        this.logger?.info('Storage', 'Iniciado driver S3');
    }

    async storeFromUrl(url, options = {}) {
        const fileId = randomUUID();

        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            timeout: 20000
        });

        let extension = this._getExtensionFromMime(response.headers['content-type']);
        let contentType = response.headers['content-type'];
        let bodyStream = response.data;

        if (options.type === 'image' || options.type === 'sticker') {
            const transformer = this._createImagePipeline(options);
            if (transformer) {
                bodyStream = response.data.pipe(transformer);
                extension = options.optimizeFor === 'wa' ? 'webp' : 'png';
                contentType = this._getMimeFromExtension(extension);
            }
        }

        const key = `media/${fileId}.${extension}`;

        const upload = new Upload({
            client: this.s3,
            params: {
                Bucket: this.bucket,
                Key: key,
                Body: bodyStream,
                ContentType: contentType
            }
        });

        await upload.done();

        let size = 0;
        try {
            const head = await this.s3.headObject({ Bucket: this.bucket, Key: key });
            size = head.ContentLength;
        } catch (e) {}

        return {
            id: fileId,
            url: `${process.env.CDN_URL || process.env.S3_PUBLIC_URL}/${key}`,
            mime_type: contentType,
            size: size,
            filename: key.split('/').pop()
        };
    }

    async getStream(fileName) {
        const key = `media/${fileName}`;
        try {
            const { Body } = await this.s3.getObject({ Bucket: this.bucket, Key: key });
            return Body instanceof Readable ? Body : Readable.from(Body);
        } catch (e) {
            return null;
        }
    }

    async delete(fileName) {
        const key = `media/${fileName}`;
        try {
            await this.s3.deleteObject({ Bucket: this.bucket, Key: key });
        } catch (e) {}
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
