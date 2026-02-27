// src/core/utils/umf.js
import { randomUUID } from 'node:crypto';

/**
 * Tipos MIME abstractos para la estandarización transversal de adjuntos.
 * Estos tipos permiten que los adaptadores manejen contenido multimedia de manera uniforme,
 * independientemente de la plataforma de origen.
 */
export const UMF_TYPES = {
    TEXT: 'text/plain',
    HTML: 'text/html',
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    FILE: 'application/octet-stream',
    STICKER: 'image/webp', // Crítico para conversiones Lottie/TGS -> WhatsApp
    SYSTEM: 'system/notification'
};

/**
 * Crea un Envoltorio UMF (Universal Message Format).
 * Estandariza la carga útil para que fluya agnósticamente a través del Bus de Eventos.
 *
 * @param {Object} params - Propiedades del mensaje nativo abstraído.
 * @param {string} [params.type=UMF_TYPES.TEXT] - Tipo principal del mensaje.
 * @param {Object} params.source - Información de origen (plataforma, canal, usuario).
 * @param {Object} params.body - Cuerpo del mensaje (texto, adjuntos, etc.).
 * @param {Array} [params.attachments=[]] - Lista de adjuntos normalizados.
 * @param {Object|null} [params.replyTo=null] - Referencia a mensaje padre.
 * @param {string} [params.correlationId] - ID de correlación para trazabilidad.
 * @returns {Object} Envoltorio UMF listo para ser encolado o enrutado.
 * @throws {Error} Si falta source.platform o source.channelId.
 */
export function createEnvelope({ type = UMF_TYPES.TEXT, source, body, attachments = [], replyTo = null, correlationId }) {
    if (!source || !source.platform || !source.channelId) {
        throw new Error('[UMF] Fallo de validación: source.platform y source.channelId son obligatorios.');
    }

    const id = randomUUID();
    const platform = source.platform.toLowerCase();

    return {
        head: {
            id,
            correlationId: correlationId || id,
            timestamp: Date.now(),
            type,
            source: {
                platform: platform,
                channelId: source.channelId,
                userId: source.userId || 'guest',
                username: source.username || 'Unknown',
                avatar: source.avatar || null
            },
            replyTo: replyTo ? { parentId: replyTo.parentId, parentText: replyTo.parentText } : null,
            // Matriz topológica (Trace Path): Implementación de Horizonte Dividido (Split Horizon)
            // Registra la plataforma origen para prevenir Tormentas de Difusión y Bucles de Enrutamiento.
            trace_path: [platform]
        },
        body: {
            text: body?.text || '',
            raw: body?.raw || body?.text || '',
            rich: body?.rich || null, // Para Embeds complejos (ej. Discord)
            attachments: attachments.map(_sanitizeAttachment)
        }
    };
}

/**
 * Garantiza que todo adjunto cumpla con el contrato de datos universal,
 * eludiendo el uso de buffers binarios puros en el bus a favor de URLs/Paths.
 *
 * @param {Object} att - Adjunto nativo sin normalizar.
 * @returns {Object} Adjunto normalizado con campos consistentes.
 * @private
 */
function _sanitizeAttachment(att) {
    return {
        id: att.id || randomUUID(),
        url: att.url || '',
        type: att.type || UMF_TYPES.FILE,
        mimeType: att.mimeType || 'application/octet-stream',
        size: att.size || 0,
        name: att.name || `media-${Date.now()}.bin`,
        localPath: att.localPath || null
    };
}

/**
 * Validador estricto de esquema JSON para mensajes en tránsito.
 * El Enrutador y los Adaptadores Egress lo utilizan para rechazar cargas corruptas.
 *
 * @param {Object} envelope - Envoltorio UMF a validar.
 * @returns {boolean} True si el envelope cumple con el esquema mínimo.
 */
export function validateEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return false;
    if (!envelope.head || !envelope.head.id || !envelope.head.source) return false;
    if (!envelope.head.source.platform || !envelope.head.source.channelId) return false;
    if (!envelope.body) return false;

    // Validar existencia de protección contra bucles
    if (!Array.isArray(envelope.head.trace_path)) return false;

    return true;
}

/**
 * Mapeador Descendente (Fallback Mapper / Graceful Degradation).
 * Traduce objetos UMF complejos (con Embeds o menús) hacia texto plano enriquecido
 * para plataformas restrictivas como WhatsApp estándar o SMS.
 *
 * @param {Object} envelope - Envoltorio UMF a degradar.
 * @returns {string} Representación textual del mensaje, apta para canales limitados.
 */
export function degradeToText(envelope) {
    let text = envelope.body.text || '';

    // Aplanar estructuras de "Embed" ricas en texto secuencial
    if (envelope.body.rich) {
        if (envelope.body.rich.title) {
            text += `\n\n*${envelope.body.rich.title}*`;
        }
        if (envelope.body.rich.description) {
            text += `\n${envelope.body.rich.description}`;
        }
        if (envelope.body.rich.url) {
            text += `\nEnlace: ${envelope.body.rich.url}`;
        }
    }

    // Aplanar adjuntos como hipervínculos si la plataforma destino no soporta subida multimedia
    if (envelope.body.attachments && envelope.body.attachments.length > 0) {
        text += '\n\n[Contenido Adjunto]:';
        envelope.body.attachments.forEach(att => {
            const link = att.url || att.localPath || 'Enlace no disponible';
            text += `\n📎 ${att.name}: ${link}`;
        });
    }

    return text.trim();
}
