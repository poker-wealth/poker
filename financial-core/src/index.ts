import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'financial-core booting');

  // Subsequent W1 wiring (added in following tasks):
  //   - MongoDB Replica Set connection (Mongoose)
  //   - Express HTTP layer (/api/v1/health, /api/v1/transfer, etc.)
  //   - dataScopeMiddleware
  //   - Settlement Engine workers (Phase 2)
  //   - TRC20 deposit listener
  //   - 7 circuit breakers

  logger.warn('boot complete — handlers and DB connection are pending W1 Day 1+ tasks');
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal boot error');
  process.exit(1);
});
