import fs from 'fs/promises';
import path from 'path';

// --- ⚙️ CONFIGURACIÓN ---
const CONFIG = {
    // Archivos permitidos
    allowedExtensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue', '.html', '.css'],
    // Únicas carpetas que ignoramos
    ignoreDirs: ['node_modules', '.git', '.idea', '.vscode', 'dist', 'build'],
    // Archivos de sistema para no tocarse a sí mismo
    systemFiles: ['limpiador_total.js', 'historial_total.json', 'log_total.txt']
};

const C = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", gray: "\x1b[90m" };

// --- LÓGICA DE LIMPIEZA LOCAL (VERSIÓN DEFINITIVA CON CORRECCIÓN DE GLITCHES) ---
function cleanContent(content) {
    let newContent = content;

    // 1. Eliminar etiquetas de IA filtradas
    newContent = newContent.replace(/\[cite: \d+\]/g, '');
    newContent = newContent.replace(/\[cite_start\]/g, '');
    newContent = newContent.replace(/\[cite_end\]/g, '');

    // 2. Corregir el operador || roto en múltiples líneas
    let previousContent;
    do {
        previousContent = newContent;
        newContent = newContent.replace(/\|\s*\n\s*\|/g, ' || ');
    } while (newContent !== previousContent);

    // 3. CORRECCIÓN AUTOMÁTICA DEL "GLITCH" DE ARREGLOS VACÍOS ([])

    // a) Asignaciones de variables vacías (ej. "const attachments = [];")
    newContent = newContent.replace(/=\s*;/g, '= [];');

    // b) Operadores OR incompletos (ej. "trace_path || [];")
    newContent = newContent.replace(/\|\|\s*;/g, '|| [];');

    // c) Propiedades de objetos vacías seguidas de coma (ej. "intents: [],")
    newContent = newContent.replace(/:\s*,/g, ': [],');

    // d) Propiedades de objetos vacías al final de un bloque (ej. "attachments: \n }")
    // El grupo de captura $1 preserva los saltos de línea y la indentación original de la llave
    newContent = newContent.replace(/:\s*(\r?\n\s*\})/g, ': []$1');

    return newContent;
    }

    // --- PROCESAMIENTO ---
    async function processFile(fullPath, rootDir) {
        const relativePath = path.relative(rootDir, fullPath);
        const fileName = path.basename(fullPath);
        const fileExt = path.extname(fullPath).toLowerCase();

        // Filtros de seguridad
        if (CONFIG.systemFiles.includes(fileName)) return;
        if (!CONFIG.allowedExtensions.includes(fileExt)) return;

        try {
            const originalContent = await fs.readFile(fullPath, 'utf-8');

            // Ignorar archivos vacíos
            if (!originalContent.trim()) return;

            const cleanedContent = cleanContent(originalContent);

            // OPTIMIZACIÓN: Solo escribimos en el disco si realmente detectó y borró un error
            if (originalContent !== cleanedContent) {
                await fs.writeFile(fullPath, cleanedContent, 'utf-8');
                console.log(`${C.green}✅ CORREGIDO: ${relativePath}${C.reset}`);
            } else {
                console.log(`${C.gray}➖ Intacto (Sin errores): ${relativePath}${C.reset}`);
            }

        } catch (error) {
            console.log(`${C.yellow}❌ Error en ${relativePath}: ${error.message}${C.reset}`);
        }
    }

    async function traverse(currentDir, rootDir) {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (!CONFIG.ignoreDirs.includes(entry.name)) {
                    await traverse(fullPath, rootDir);
                }
            } else if (entry.isFile()) {
                await processFile(fullPath, rootDir);
            }
        }
    }

    // --- EJECUCIÓN ---
    (async () => {
        console.clear();
        console.log(C.blue + "🚀 INICIANDO LIMPIEZA LOCAL ULTRA-RÁPIDA (CON CORRECCIÓN DE GLITCHES DE ARREGLOS VACÍOS)" + C.reset);

        const rootDir = process.cwd();
        await traverse(rootDir, rootDir);

        console.log(C.green + "\n🏁 PROCESO TERMINADO." + C.reset);
    })();
