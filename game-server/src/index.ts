import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'game-server booting');

  // Subsequent M2 wiring:
  //   - WebSocket server (Socket.io: game state + chat namespaces)
  //   - RoomManager + active Texas Hold'em tables
  //   - HTTP layer for game lifecycle
  //   - drand client + KMS wired into Commit-Reveal
  //   - FC HTTP client for settlement / insurance

  logger.warn('game-server boot stub — runtime wiring lands in later M2 commits');
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal boot error');
  process.exit(1);
});
