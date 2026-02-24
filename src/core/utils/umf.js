import { randomUUID } from 'node:crypto';

export const UMF_TYPES = {
    TEXT: 'text/plain',
    HTML: 'text/html',
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    FILE: 'application/octet-stream',
    SYSTEM: 'system/notification'
};

export function createEnvelope({
    type = UMF_TYPES.TEXT,
    source,
    body,
    attachments = [],
    replyTo = null,
    correlationId = null
}) {
    if (!source?.platform || !source?.channelId) {
        throw new Error('[UMF] Invalid Source: platform and channelId are required.');
    }

    const timestamp = Date.now();
    const id = randomUUID();

    return {
        head: {
            id: id,
            correlationId: correlationId || id,
            timestamp: timestamp,
            type: type,
            source: {
                platform: source.platform.toLowerCase(),
                channelId: String(source.channelId),
                userId: String(source.userId || 'guest'),
                username: source.username || 'Unknown',
                avatar: source.avatar || null
            },
            replyTo: replyTo ? {
                parentId: replyTo.id,
                parentText: replyTo.text
            } : null,
            dest: []
        },
        body: {
            text: body.text || '',
            raw: body.raw || body.text,
            attachments: attachments.map(_sanitizeAttachment),
            interactive: body.interactive || null
        }
    };
}

export function createAttachment({
    url,
    type = 'file',
    mime = 'application/octet-stream',
    size = 0,
    name = 'unknown'
}) {
    return {
        url,
        type,
        mime,
        size,
        name
    };
}

export function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return false;
    if (!envelope.head || !envelope.head.id || !envelope.head.source) return false;
    if (!envelope.body) return false;
    const { platform, channelId } = envelope.head.source;
    if (!platform || !channelId) return false;
    return true;
}

function _sanitizeAttachment(att) {
    return {
        url: att.url || '',
        type: att.type || 'file',
        mime: att.mime || 'application/octet-stream',
        size: att.size || 0,
        name: att.name || `file-${Date.now()}.bin`
    };
}