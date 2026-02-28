// index.js
import { Kernel } from './src/core/kernel.js';
// Este archivo funciona como un punto de entrada agnóstico.
const kernel = new Kernel();

async function bootstrap() {
    try {
        await kernel.init();
        await kernel.start();
        console.log('Global Bridge iniciado correctamente.');
    } catch (error) {
        console.error('Error crítico en el arranque:', error);
        process.exit(1);
    }
}

async function gracefulShutdown(signal) {
    console.log(`\nRecibida señal ${signal}. Ejecutando Graceful Shutdown...`);
    try {
        await kernel.stop();
        console.log('Todos los servicios, workers y plugins han sido detenidos exitosamente.');
        process.exit(0);
    } catch (error) {
        console.error('Error durante el cierre seguro:', error);
        process.exit(1);
    }
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
    console.error('Excepción no capturada:', error);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    console.error('Promesa rechazada no manejada:', reason);
    gracefulShutdown('unhandledRejection');
});

bootstrap();
