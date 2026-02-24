import { Kernel } from './src/core/kernel.js';

process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL UNCAUGHT EXCEPTION:', err);
    console.error(err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
});

(async () => {
    try {
        const kernel = new Kernel();
        await kernel.start();
    } catch (error) {
        console.error('🔥 FATAL BOOTSTRAP ERROR:', error);
        process.exit(1);
    }
})();
