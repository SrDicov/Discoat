import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import util from 'node:util';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import axios from 'axios';

const execPromise = util.promisify(exec);

export default class TranscriberAddon {
    constructor() {
        this.name = 'Transcriber';
        // Palabras clave para invocar el bot
        this.commands = ['!tr', '!tria'];
    }

    async init(ctx) {
        this.ctx = ctx;
        this.tempDir = path.join(process.cwd(), '.temp_audio');
        if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });

        // Instanciar clientes IA (Se recomienda fuertemente mover estas llaves al archivo .env)
        const groqKey = process.env.GROQ_KEY || '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';
        const deepseekKey = process.env.DEEPSEEK_KEY || 'sk-f92aaf84e52b4173b14e4d80bed1e866';

        this.groq = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' });
        this.deepseek = new OpenAI({ apiKey: deepseekKey, baseURL: 'https://api.deepseek.com' });
    }

    async start() {
        this.ctx.bus.on('message.ingress', async (umf) => {
            try {
                await this.handle(umf);
            } catch (error) {
                this.ctx.logger.error(`[Transcriber] Fallo crítico:`, { error: error.message });
            }
        });
    }

    async handle(umf) {
        const text = umf.body.text || '';

        // 1. Validar si el usuario solicitó la transcripción explícitamente (!transcribe)
        const isCommand = this.commands.some(cmd => text.toLowerCase().startsWith(cmd));
        if (!isCommand) return;

        // Tolerancia extrema para buscar adjuntos del mensaje original citado
        const replyAttachments = umf.head?.replyTo?.parentAttachments || umf.replyTo?.parentAttachments || [];
        const currentAttachments = umf.body?.attachments || [];

        const allAttachments = [
            ...replyAttachments,
            ...currentAttachments
        ];

        // 2. Extraer el primer adjunto multimedia que sea de audio o video
        const targetMedia = allAttachments.find(a =>
        a.type === 'audio' || a.type === 'video' ||
        a.mimeType?.includes('audio') || a.mimeType?.includes('video') || a.name?.endsWith('.ogg')
        );

        if (!targetMedia) {
            await this._reply(umf, "❌ No encontré ningún audio adjunto ni en este mensaje ni en el mensaje al que respondiste.");
            return;
        }

        await this._processTranscription(umf, targetMedia);
    }

    async _processTranscription(umf, media) {
        const tempId = randomUUID();
        const inputPath = path.join(this.tempDir, `${tempId}_input`);
        const outputPath = path.join(this.tempDir, `${tempId}.mp3`);

        try {
            // Emular reacción de "cargando" con un mensaje nativo para que soporte todas las redes
            await this._reply(umf, "⏳ Descargando y procesando el audio...");

            // Paso 1: Obtener el archivo crudo
            if (media.localPath && fs.existsSync(media.localPath)) {
                // Si el nuevo "Media Worker" que hicimos antes ya lo descargó
                fs.copyFileSync(media.localPath, inputPath);
            } else if (media.url) {
                // Descarga manual agnóstica (Funciona para CDN de Stoat, Discord y Telegram)
                const response = await axios({ url: media.url, responseType: 'stream' });
                const writer = fs.createWriteStream(inputPath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
            } else {
                throw new Error("No hay ruta local ni URL disponible para el audio.");
            }

            // Paso 2: Conversión Universal a MP3 vía FFmpeg (sin importar si es OGG, MP4 o M4A)
            await execPromise(`ffmpeg -i "${inputPath}" -q:a 0 -map a "${outputPath}" -y`);

            // Paso 3: Transcripción con Groq (Whisper)
            const transcription = await this.groq.audio.transcriptions.create({
                file: fs.createReadStream(outputPath),
                                                                              model: 'whisper-large-v3',
                                                                              response_format: 'text',
                                                                              language: 'es'
            });

            let finalText = `*🎙️ Transcripción:*\n${transcription}`;

            // Paso 4: Lógica de Resumen (Sin cambios de funcionalidad)
            if (transcription.length > 100) {
                await this._reply(umf, "🧠 Texto extenso detectado, generando resumen con DeepSeek...");
                const summary = await this.deepseek.chat.completions.create({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: 'Eres un asistente que corrige ortocroficamente transcripciones mas hechas de audios de manera concisa y clara en español.' },
                        { role: 'user', content: `Corrige esto detalladamente:\n${transcription}` }
                    ]
                });
                finalText += `\n\n*📝 Resumen Ejecutivo:*\n${summary.choices[0].message.content}`;
            }

            // Paso 5: Paginación y Despacho
            const chunks = this._splitMessage(finalText, 1900); // 1900 es el límite seguro general (por Discord)
            for (const chunk of chunks) {
                await this._reply(umf, chunk);
            }

        } catch (error) {
            this.ctx.logger.error(`[Transcriber] Falla en pipeline de audio: ${error.message}`);
            await this._reply(umf, "❌ Error interno procesando el audio.");
        } finally {
            // Limpieza de disco para evitar sobrecarga del servidor
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
    }

    /**
     * Enrutamiento Inverso (Egress dinámico).
     * Devuelve la respuesta a la plataforma EXACTA que invocó el comando.
     */
    async _reply(umf, text) {
        const replyEnvelope = {
            ...umf, // Clonamos propiedades base
            head: {
                ...umf.head,
                id: randomUUID(), // Nuevo ID para la respuesta
                // Intercambiamos origen por destino
                dest: { platform: umf.head.source.platform, channelId: umf.head.source.channelId }
            },
            body: { text: text, attachments: [] }
        };

        // Empujar directo a la cola de salida de la red correspondiente
        const queueName = `queue_${umf.head.source.platform}_out`;
        await this.ctx.queue.add(queueName, replyEnvelope);
    }

    _splitMessage(text, limit) {
        if (text.length <= limit) return [text];
        const chunks = [];
        let str = text;
        while (str.length > 0) {
            if (str.length <= limit) {
                chunks.push(str);
                break;
            }
            let chunkEnd = str.substring(0, limit).lastIndexOf(' ');
            if (chunkEnd === -1) chunkEnd = limit;
            chunks.push(str.substring(0, chunkEnd));
            str = str.substring(chunkEnd).trim();
        }
        return chunks;
    }

    async stop() {}
    async health() { return { status: 'active', dependencies: ['ffmpeg', 'groq', 'deepseek'] }; }
}
