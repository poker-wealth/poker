import { FcClient, type FetchFn } from '../../src/fc-client/fc-client';
import { localCsprng } from '../../src/provably-fair/kms';
import type { DrandClientOptions } from '../../src/provably-fair/drand';
import { GameService } from '../../src/runtime/game-service';
import type { TexasConfig } from '../../src/games/texas/texas-holdem';

/** drand fetch that always fails → forces the offline KMS fallback path. */
const failingDrandFetch: DrandClientOptions['fetchFn'] = async () => {
  throw new Error('offline');
};
const drandOpts: DrandClientOptions = {
  urls: ['https://example.invalid'],
  timeoutMs: 50,
  fetchFn: failingDrandFetch,
};

/** Mock FC fetch capturing settle-pots calls. */
function mockFc(): { fetchFn: FetchFn; settleCalls: unknown[] } {
  const settleCalls: unknown[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    if (url.endsWith('/settle-pots')) settleCalls.push(JSON.parse(init.body!));
    return {
      ok: true,
      status: 200,
      json: async () => ({ winners: [], replayed: false }),
      text: async () => JSON.stringify({ winners: [], replayed: false }),
    };
  };
  return { fetchFn, settleCalls };
}

function makeService(settleCalls: unknown[], fetchFn: FetchFn): GameService {
  const fcClient = new FcClient({ baseUrl: 'http://fc:3000', internalToken: 'tok-tok-tok-tok-tok', fetchFn });
  return new GameService({
    fcClient,
    drand: drandOpts,
    cloud: localCsprng,
    // 5% rake, capped at $3.
    rakePolicy: (pot) => {
      const r = (pot * 5n) / 100n;
      return r > 300n ? 300n : r;
    },
  });
  void settleCalls;
}

const config: TexasConfig = {
  tableId: 't1',
  tableType: 'PLATFORM',
  minPlayers: 2,
  maxPlayers: 6,
  smallBlind: 50n,
  bigBlind: 100n,
};

describe('runtime/GameService', () => {
  it('runs a full hand: provably-fair start → fold → settle with FC', async () => {
    const { fetchFn, settleCalls } = mockFc();
    const svc = makeService(settleCalls, fetchFn);
    svc.createTexasTable(config);
    svc.join('t1', 'alice', 0);
    svc.join('t1', 'bob', 1);
    svc.buyIn('t1', 'alice', 10_000n);
    svc.buyIn('t1', 'bob', 10_000n);

    const { roundId, serverCommit } = await svc.startHand('t1', 'round-1');
    expect(roundId).toBe('round-1');
    expect(serverCommit).toMatch(/^[0-9a-f]{64}$/); // commit published

    // Heads-up: actor (SB/button) folds → hand settles.
    const pub = svc.roomManager.getRoom('t1').getPublicState() as { actor: string };
    const res = svc.applyAction('t1', pub.actor, { type: 'fold' });
    expect(res.ok).toBe(true);

    const outcome = await svc.settleIfComplete('t1');
    expect(outcome).not.toBeNull();
    expect(outcome!.winners).toHaveLength(1);
    expect(settleCalls).toHaveLength(1);
    const sent = settleCalls[0] as { net_deltas: Array<{ owner_id: string; net: string }>; rake_amount: string };
    // net deltas conserve (sum 0).
    expect(sent.net_deltas.reduce((s, d) => s + BigInt(d.net), 0n)).toBe(0n);
  });

  it('enforces single-account-one-table at the service level', () => {
    const { fetchFn, settleCalls } = mockFc();
    const svc = makeService(settleCalls, fetchFn);
    svc.createTexasTable({ ...config, tableId: 't1' });
    svc.createTexasTable({ ...config, tableId: 't2' });
    svc.join('t1', 'alice', 0);
    expect(() => svc.join('t2', 'alice', 0)).toThrow(/already at table/);
  });

  it('settleIfComplete is idempotent (no double FC call)', async () => {
    const { fetchFn, settleCalls } = mockFc();
    const svc = makeService(settleCalls, fetchFn);
    svc.createTexasTable(config);
    svc.join('t1', 'alice', 0);
    svc.join('t1', 'bob', 1);
    svc.buyIn('t1', 'alice', 10_000n);
    svc.buyIn('t1', 'bob', 10_000n);
    await svc.startHand('t1', 'round-1');
    const pub = svc.roomManager.getRoom('t1').getPublicState() as { actor: string };
    svc.applyAction('t1', pub.actor, { type: 'fold' });

    await svc.settleIfComplete('t1');
    const second = await svc.settleIfComplete('t1');
    expect(second).toBeNull(); // already settled
    expect(settleCalls).toHaveLength(1);
  });

  it('returns null when there is no settled hand to process', async () => {
    const { fetchFn, settleCalls } = mockFc();
    const svc = makeService(settleCalls, fetchFn);
    svc.createTexasTable(config);
    svc.join('t1', 'alice', 0);
    svc.join('t1', 'bob', 1);
    svc.buyIn('t1', 'alice', 10_000n);
    svc.buyIn('t1', 'bob', 10_000n);
    await svc.startHand('t1', 'round-1');
    // Hand still in progress.
    expect(await svc.settleIfComplete('t1')).toBeNull();
  });

  it('reconciles the house cut: winner table stack drops by rake + jackpot', async () => {
    const { fetchFn, settleCalls } = mockFc();
    const svc = makeService(settleCalls, fetchFn);
    const game = svc.createTexasTable(config);
    svc.join('t1', 'alice', 0);
    svc.join('t1', 'bob', 1);
    svc.buyIn('t1', 'alice', 10_000n);
    svc.buyIn('t1', 'bob', 10_000n);
    await svc.startHand('t1', 'round-hc');

    // SB folds → BB wins the small blind only (tiny pot). Settle.
    const pub = svc.roomManager.getRoom('t1').getPublicState() as { actor: string };
    const folder = pub.actor;
    svc.applyAction('t1', folder, { type: 'fold' });
    const outcome = await svc.settleIfComplete('t1');
    expect(outcome).not.toBeNull();

    // Total chips across the table must equal 20,000 minus the house cut.
    const total = game.stackOf('alice') + game.stackOf('bob');
    const winnerProfit = 50n; // BB won the 50 SB
    const jackpot = (winnerProfit * 5n) / 1000n; // 0 (rounds to 0)
    const rake = (50n * 5n) / 100n; // 5% of pot... pot here is just blinds
    void rake;
    expect(total).toBeLessThanOrEqual(20_000n);
    expect(total + outcome!.rakeCents + jackpot).toBe(20_000n);
  });
});
