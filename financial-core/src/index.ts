import { registerAllCircuitBreakers } from './circuit-breakers/registry.js';
import { loadEnv } from './config/env.js';
import { connectDB, disconnectDB } from './db/connection.js';
import { buildApp } from './http/app.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'financial-core booting');

  await connectDB();
  registerAllCircuitBreakers();

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'http server listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    server.close((err) => {
      if (err) logger.error({ err }, 'server.close error');
    });
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal boot error');
  process.exit(1);
});
