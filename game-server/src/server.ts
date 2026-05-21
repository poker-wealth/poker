import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { FcClient } from './fc-client/fc-client.js';
import { buildGameApp } from './http/app.js';
import { localCsprng, awsKmsSource, type CloudRandomSource } from './provably-fair/kms.js';
import type { DrandClientOptions } from './provably-fair/drand.js';
import { GameService, type RakePolicy } from './runtime/game-service.js';
import { attachGameGateway } from './ws/game-gateway.js';
import type { Env } from './config/env.js';

/**
 * Wires HTTP (Express) + WebSocket (Socket.io) + GameService into one server.
 * Pure factory — no listen() — so tests can drive it on an ephemeral port.
 */

export interface BuiltServer {
  http: HttpServer;
  io: SocketServer;
  gameService: GameService;
}

/** Default rake: 5% of the pot, capped at $3 (300 cents). */
export const defaultRakePolicy: RakePolicy = (pot) => {
  const r = (pot * 5n) / 100n;
  return r > 300n ? 300n : r;
};

export interface BuildServerOverrides {
  rakePolicy?: RakePolicy;
  cloud?: CloudRandomSource;
  /** Inject a mock FcClient (tests). */
  fcClient?: FcClient;
  /** Inject drand options (tests use a failing fetch → KMS fallback). */
  drand?: DrandClientOptions;
  /** Spectator delay override for the WS gateway (tests use 0). */
  spectatorDelayMs?: number;
}

export function buildServer(env: Env, overrides: BuildServerOverrides = {}): BuiltServer {
  const fcClient =
    overrides.fcClient ??
    new FcClient({ baseUrl: env.FC_BASE_URL, internalToken: env.FC_INTERNAL_TOKEN ?? '' });

  const drand: DrandClientOptions = overrides.drand ?? {
    urls: env.DRAND_URLS.split(',').map((s) => s.trim()).filter(Boolean),
    timeoutMs: env.DRAND_TIMEOUT_MS,
    fetchFn: (url, init) =>
      fetch(url, init?.signal ? { signal: init.signal } : {}).then((r) => ({
        ok: r.ok,
        status: r.status,
        json: () => r.json(),
      })),
  };

  const cloud = overrides.cloud ?? (env.KMS_KEY_ID ? awsKmsSource(env.KMS_KEY_ID) : localCsprng);

  const gameService = new GameService({
    fcClient,
    drand,
    cloud,
    rakePolicy: overrides.rakePolicy ?? defaultRakePolicy,
  });

  const app = buildGameApp(gameService);
  const http = createServer(app);
  const io = new SocketServer(http, { cors: { origin: '*' } });
  attachGameGateway(io, {
    gameService,
    ...(overrides.spectatorDelayMs !== undefined && { spectatorDelayMs: overrides.spectatorDelayMs }),
  });

  return { http, io, gameService };
}
