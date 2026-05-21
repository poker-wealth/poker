import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { FcClient, type FetchFn } from '../src/fc-client/fc-client';
import { localCsprng } from '../src/provably-fair/kms';
import type { DrandClientOptions } from '../src/provably-fair/drand';
import { buildServer, type BuiltServer } from '../src/server';
import { loadEnv } from '../src/config/env';

// Offline drand → KMS fallback.
const drand: DrandClientOptions = {
  urls: ['https://drand.invalid'],
  timeoutMs: 50,
  fetchFn: async () => {
    throw new Error('offline');
  },
};

function mockFcClient(settleCalls: unknown[]): FcClient {
  const fetchFn: FetchFn = async (url, init) => {
    if (url.endsWith('/settle-pots')) settleCalls.push(JSON.parse(init.body!));
    return {
      ok: true,
      status: 200,
      json: async () => ({ winners: [], replayed: false }),
      text: async () => JSON.stringify({ winners: [], replayed: false }),
    };
  };
  return new FcClient({ baseUrl: 'http://fc.invalid', internalToken: 'x'.repeat(16), fetchFn });
}

describe('server — HTTP + WebSocket integration', () => {
  let server: BuiltServer;
  let baseUrl: string;
  let port: number;
  const settleCalls: unknown[] = [];

  beforeAll(async () => {
    const env = loadEnv();
    server = buildServer(env, {
      fcClient: mockFcClient(settleCalls),
      drand,
      cloud: localCsprng,
      spectatorDelayMs: 0, // no delay in tests
    });
    await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
    port = (server.http.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.io.close();
    await new Promise<void>((resolve) => server.http.close(() => resolve()));
  });

  it('GET /api/v1/health', async () => {
    const r = await request(baseUrl).get('/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('full HTTP table lifecycle: create → join → buyin → start → fold → settle', async () => {
    // Create table.
    const create = await request(baseUrl)
      .post('/api/v1/tables')
      .send({ table_id: 'demo', table_type: 'PLATFORM', small_blind: 50, big_blind: 100 });
    expect(create.status).toBe(201);
    expect(create.body.table_id).toBe('demo');

    // Join two players.
    const j1 = await request(baseUrl).post('/api/v1/tables/demo/join').set('x-player-id', 'alice').send({ seat: 0 });
    expect(j1.status).toBe(201);
    await request(baseUrl).post('/api/v1/tables/demo/join').set('x-player-id', 'bob').send({ seat: 1 });

    // Buy in.
    await request(baseUrl).post('/api/v1/tables/demo/buyin').set('x-player-id', 'alice').send({ amount: '10000' });
    await request(baseUrl).post('/api/v1/tables/demo/buyin').set('x-player-id', 'bob').send({ amount: '10000' });

    // Start a hand.
    const start = await request(baseUrl).post('/api/v1/tables/demo/start').send({ round_id: 'round-1' });
    expect(start.status).toBe(200);
    expect(start.body.server_commit).toMatch(/^[0-9a-f]{64}$/);

    // Private view: actor sees their hole cards.
    const state = await request(baseUrl).get('/api/v1/tables/demo');
    const actor = state.body.actor as string;
    const me = await request(baseUrl).get('/api/v1/tables/demo/me').set('x-player-id', actor);
    expect(me.body.holeCards).toHaveLength(2);

    // Actor folds → hand settles.
    const action = await request(baseUrl).post('/api/v1/tables/demo/action').set('x-player-id', actor).send({ type: 'fold' });
    expect(action.status).toBe(200);
    expect(action.body.settled).toBe(true);
    expect(settleCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('single-account-one-table enforced (409 ALREADY_SEATED)', async () => {
    await request(baseUrl).post('/api/v1/tables').send({ table_id: 'tA', table_type: 'PLATFORM', small_blind: 50, big_blind: 100 });
    await request(baseUrl).post('/api/v1/tables').send({ table_id: 'tB', table_type: 'PLATFORM', small_blind: 50, big_blind: 100 });
    await request(baseUrl).post('/api/v1/tables/tA/join').set('x-player-id', 'carol').send({});
    const dup = await request(baseUrl).post('/api/v1/tables/tB/join').set('x-player-id', 'carol').send({});
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ALREADY_SEATED');
  });

  it('404 for unknown table', async () => {
    const r = await request(baseUrl).get('/api/v1/tables/nope');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('TABLE_NOT_FOUND');
  });

  it('action requires x-player-id', async () => {
    const r = await request(baseUrl).post('/api/v1/tables/demo/action').send({ type: 'fold' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('MISSING_PLAYER_ID');
  });

  // ── WebSocket ──────────────────────────────────────────────────
  it('WS /game pushes initial state to a connected player', async () => {
    await request(baseUrl).post('/api/v1/tables').send({ table_id: 'ws1', table_type: 'PLATFORM', small_blind: 50, big_blind: 100 });
    await request(baseUrl).post('/api/v1/tables/ws1/join').set('x-player-id', 'dave').send({ seat: 0 });

    const state = await new Promise<unknown>((resolve, reject) => {
      const sock: ClientSocket = ioClient(`${baseUrl}/game`, {
        query: { tableId: 'ws1', playerId: 'dave' },
        transports: ['websocket'],
        forceNew: true,
      });
      const timer = setTimeout(() => {
        sock.close();
        reject(new Error('no state received'));
      }, 4000);
      sock.on('state', (s: unknown) => {
        clearTimeout(timer);
        sock.close();
        resolve(s);
      });
      sock.on('connect_error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    expect((state as { tableId: string }).tableId).toBe('ws1');
  });

  it('WS rejects connection to an unknown table', async () => {
    const errored = await new Promise<boolean>((resolve) => {
      const sock: ClientSocket = ioClient(`${baseUrl}/game`, {
        query: { tableId: 'ghost', playerId: 'x' },
        transports: ['websocket'],
        forceNew: true,
      });
      sock.on('error_event', (e: { code: string }) => {
        sock.close();
        resolve(e.code === 'TABLE_NOT_FOUND');
      });
      sock.on('disconnect', () => resolve(true));
      setTimeout(() => {
        sock.close();
        resolve(false);
      }, 4000);
    });
    expect(errored).toBe(true);
  });
});
