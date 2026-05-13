#!/usr/bin/env tsx
// FairPlay — `npm run dev:memory`
//
// Boots an in-process MongoDB Replica Set + the FC HTTP server, all in one
// process. Zero infrastructure required: no Docker, no native Mongo install.
//
// Trade-offs vs `npm run dev` (Docker-backed):
//   + zero install, runs anywhere Node 20 runs
//   + perfect for demoing the M1 dashboard to a client
//   - data resets on every restart (in-memory only)
//   - not production-parity (real prod uses 3-node MongoDB Replica Set)
//
// Visit http://localhost:3000 once you see "http server listening".
// Sign in as alice/demo (player), ops/demo (ops), or admin/demo.

import './_smoke-env.js';

import type { Server } from 'node:http';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { registerAllCircuitBreakers } from '../src/circuit-breakers/registry.js';
import { loadEnv } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/db/connection.js';
import { buildApp } from '../src/http/app.js';
import { logger } from '../src/lib/logger.js';
import { Account } from '../src/wallet/account.model.js';
import { Ledger } from '../src/wallet/ledger.model.js';
import { Withdrawal } from '../src/withdrawal/withdrawal.model.js';

let server: Server | null = null;
let rs: MongoMemoryReplSet | null = null;

async function main(): Promise<void> {
  const env = loadEnv();

  console.warn('[dev:memory] booting in-process MongoDB Replica Set …');
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = rs.getUri();
  console.warn(`[dev:memory] mongo ready at ${uri}`);

  await connectDB(uri);
  await Account.syncIndexes();
  await Ledger.syncIndexes();
  await Withdrawal.syncIndexes();
  registerAllCircuitBreakers();

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(env.PORT, () => {
      logger.info({ port: env.PORT }, 'http server listening');
      console.warn('');
      console.warn('  ┌─────────────────────────────────────────────────┐');
      console.warn(`  │  Demo UI: http://localhost:${env.PORT}/                  │`);
      console.warn('  │  Login:    alice / demo  (player)                │');
      console.warn('  │            ops   / demo  (ops)                   │');
      console.warn('  │            admin / demo  (admin)                 │');
      console.warn('  │  Stop:     Ctrl+C                                │');
      console.warn('  └─────────────────────────────────────────────────┘');
      console.warn('');
      console.warn('[dev:memory] data resets on restart (in-memory only)');
      resolve();
    });
  });
}

async function shutdown(signal: string): Promise<void> {
  console.warn(`\n[dev:memory] ${signal} received — shutting down …`);
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (rs) {
    await disconnectDB();
    await rs.stop();
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[dev:memory] fatal:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
