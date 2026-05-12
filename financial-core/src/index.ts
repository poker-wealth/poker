import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectDB, disconnectDB } from './db/connection.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'financial-core booting');

  await connectDB();

  // Subsequent W1 wiring (added in following tasks):
  //   - Express HTTP layer (/api/v1/health, /api/v1/transfer, etc.)
  //   - dataScopeMiddleware
  //   - Settlement Engine workers (Phase 2)
  //   - TRC20 deposit listener
  //   - 7 circuit breakers

  logger.warn('boot complete — HTTP, workers, and listeners pending W1 Day 1+ tasks');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
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
