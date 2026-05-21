import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { http } = buildServer(env);
  http.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'game-server listening (HTTP + WebSocket)');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown signal received');
    http.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal boot error');
  process.exit(1);
});
