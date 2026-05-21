import { FcClient, FcError, type FetchFn } from '../../src/fc-client/fc-client';
import {
  MultiWinnerSettlementError,
  buildSettlePotsRequest,
  buildSettleRoundRequest,
} from '../../src/fc-client/settlement-adapter';
import type { HandResult } from '../../src/games/texas/texas-holdem';

/** Records calls and returns scripted responses. */
function mockFetch(
  handler: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    ok: boolean;
    status: number;
    body: unknown;
  },
): { fetchFn: FetchFn; calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
    const r = handler(url, init);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { fetchFn, calls };
}

describe('fc-client/FcClient', () => {
  it('health hits /api/v1/health without the internal token', async () => {
    const { fetchFn, calls } = mockFetch(() => ({ ok: true, status: 200, body: { status: 'ok', mongo: 'connected' } }));
    const client = new FcClient({ baseUrl: 'http://fc:3000', internalToken: 'tok', fetchFn });
    const r = await client.health();
    expect(r).toEqual({ status: 'ok', mongo: 'connected' });
    expect(calls[0]!.url).toBe('http://fc:3000/api/v1/health');
    expect(calls[0]!.headers['X-Internal-Token']).toBeUndefined();
  });

  it('settleRound sends the internal token + idempotency key', async () => {
    const { fetchFn, calls } = mockFetch(() => ({ ok: true, status: 200, body: { round_id: 'r1', replayed: false } }));
    const client = new FcClient({ baseUrl: 'http://fc:3000', internalToken: 'sekret', fetchFn });
    await client.settleRound(
      {
        round_id: 'r1',
        table_id: 't1',
        table_type: 'PLATFORM',
        winner_owner_id: 'alice',
        winner_profit: '5000',
        rake_amount: '250',
        losers: [{ owner_id: 'bob', contribution: '5000' }],
      },
      'settle:r1',
    );
    expect(calls[0]!.url).toBe('http://fc:3000/api/v1/internal/settle-round');
    expect(calls[0]!.headers['X-Internal-Token']).toBe('sekret');
    expect(calls[0]!.headers['Idempotency-Key']).toBe('settle:r1');
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.winner_owner_id).toBe('alice');
  });

  it('throws FcError with code on non-2xx', async () => {
    const { fetchFn } = mockFetch(() => ({
      ok: false,
      status: 422,
      body: { code: 'ILLEGAL_FUND_FLOW', detail: 'PLAYER -> REINSURANCE' },
    }));
    const client = new FcClient({ baseUrl: 'http://fc:3000', internalToken: 'tok', fetchFn });
    await expect(
      client.transfer(
        { from: { type: 'PLAYER', owner_id: 'p' }, to: { type: 'REINSURANCE', owner_id: 'PLATFORM' }, amount: '1', ledger_type: 'BET' },
        'k1',
      ),
    ).rejects.toMatchObject({ name: 'FcError', status: 422, code: 'ILLEGAL_FUND_FLOW' });
  });

  it('FcError carries the parsed body', async () => {
    const { fetchFn } = mockFetch(() => ({ ok: false, status: 409, body: { code: 'INSUFFICIENT_BALANCE' } }));
    const client = new FcClient({ baseUrl: 'http://fc:3000', internalToken: 'tok', fetchFn });
    try {
      await client.creditDeposit({
        player_id: 'p',
        amount: '100',
        tx_hash: 'tx',
        contract_address: 'C',
        confirmations: 20,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FcError);
      expect((e as FcError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });
});

describe('fc-client/settlement-adapter', () => {
  function singleWinnerResult(): HandResult {
    return {
      roundId: 'r1',
      tableId: 't1',
      board: [],
      winners: ['alice'],
      potAwards: [{ amount: 200n, winners: ['alice'] }],
      potTotal: 200n,
      players: [
        { playerId: 'alice', startStack: 10_000n, endStack: 10_100n, net: 100n, committed: 100n, folded: false },
        { playerId: 'bob', startStack: 10_000n, endStack: 9_900n, net: -100n, committed: 100n, folded: false },
      ],
    };
  }

  it('builds a settle-round request for a single-winner hand', () => {
    const req = buildSettleRoundRequest(singleWinnerResult(), { tableType: 'PLATFORM', rakeCents: 10n });
    expect(req.winner_owner_id).toBe('alice');
    expect(req.winner_profit).toBe('100');
    expect(req.rake_amount).toBe('10');
    expect(req.losers).toEqual([{ owner_id: 'bob', contribution: '100' }]);
    expect(req.table_type).toBe('PLATFORM');
  });

  it('routes LEAGUE tables with the leagueId', () => {
    const req = buildSettleRoundRequest(singleWinnerResult(), {
      tableType: 'LEAGUE',
      leagueId: 'league-7',
      rakeCents: 0n,
    });
    expect(req.table_type).toBe('LEAGUE');
    expect(req.league_id).toBe('league-7');
  });

  it('throws MultiWinnerSettlementError for split/side-pot hands (single-winner adapter)', () => {
    const split: HandResult = {
      ...singleWinnerResult(),
      winners: ['alice', 'bob'],
    };
    expect(() => buildSettleRoundRequest(split, { tableType: 'PLATFORM', rakeCents: 0n })).toThrow(
      MultiWinnerSettlementError,
    );
  });

  it('buildSettlePotsRequest maps engine net deltas (any winner count)', () => {
    const split: HandResult = {
      ...singleWinnerResult(),
      winners: ['alice', 'bob'],
      players: [
        { playerId: 'alice', startStack: 10_000n, endStack: 10_100n, net: 100n, committed: 100n, folded: false },
        { playerId: 'bob', startStack: 10_000n, endStack: 10_100n, net: 100n, committed: 100n, folded: false },
        { playerId: 'carol', startStack: 10_000n, endStack: 9_800n, net: -200n, committed: 200n, folded: false },
      ],
    };
    const req = buildSettlePotsRequest(split, { tableType: 'PLATFORM', rakeCents: 5n });
    expect(req.rake_amount).toBe('5');
    expect(req.net_deltas).toEqual([
      { owner_id: 'alice', net: '100' },
      { owner_id: 'bob', net: '100' },
      { owner_id: 'carol', net: '-200' },
    ]);
    // Net deltas must sum to zero (chip conservation).
    const sum = req.net_deltas.reduce((s, d) => s + BigInt(d.net), 0n);
    expect(sum).toBe(0n);
  });

  it('settlePots client method posts to /internal/settle-pots', async () => {
    const { fetchFn, calls } = mockFetch(() => ({ ok: true, status: 200, body: { winners: ['a'], replayed: false } }));
    const client = new FcClient({ baseUrl: 'http://fc:3000', internalToken: 'tok', fetchFn });
    await client.settlePots(
      {
        round_id: 'r1',
        table_id: 't1',
        table_type: 'PLATFORM',
        rake_amount: '0',
        net_deltas: [
          { owner_id: 'a', net: '100' },
          { owner_id: 'b', net: '-100' },
        ],
      },
      'settle:r1',
    );
    expect(calls[0]!.url).toBe('http://fc:3000/api/v1/internal/settle-pots');
    expect(calls[0]!.headers['Idempotency-Key']).toBe('settle:r1');
  });
});
