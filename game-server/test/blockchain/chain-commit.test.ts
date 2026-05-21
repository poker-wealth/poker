import {
  ChainHealthMonitor,
  ExternalChainCommitter,
  ResilientCommitter,
  Rfc3161Notary,
  explorerLink,
  type ChainSubmitFn,
  type CommitInput,
} from '../../src/blockchain/chain-commit';

const input: CommitInput = { roundId: 'r1', hash: 'abc123', payload: { table: 't1' } };

function okSubmit(chain: string, confirmMs = 1000): ChainSubmitFn {
  return async () => ({ reference: `${chain}-tx-deadbeef`, confirmMs });
}
const failSubmit: ChainSubmitFn = async () => {
  throw new Error('chain down');
};

describe('blockchain/Rfc3161Notary', () => {
  it('commits and verifies a timestamp token', async () => {
    const notary = new Rfc3161Notary('secret');
    const r = await notary.commit(input);
    expect(r.chainUsed).toBe('rfc3161');
    expect(notary.verify(input, r.reference)).toBe(true);
  });

  it('rejects a tampered token', async () => {
    const notary = new Rfc3161Notary('secret');
    const r = await notary.commit(input);
    expect(notary.verify({ ...input, hash: 'tampered' }, r.reference)).toBe(false);
  });
});

describe('blockchain/ChainHealthMonitor', () => {
  it('healthy with no data (optimistic)', () => {
    const m = new ChainHealthMonitor();
    expect(m.isHealthy('solana')).toBe(true);
  });

  it('unhealthy when failure rate exceeds 5%', () => {
    const m = new ChainHealthMonitor({ windowSize: 20, maxFailureRate: 0.05 });
    for (let i = 0; i < 19; i++) m.record('solana', { ok: true, confirmMs: 500 });
    m.record('solana', { ok: false, confirmMs: 0 });
    // 1/20 = 5% exactly → still healthy.
    expect(m.isHealthy('solana')).toBe(true);
    m.record('solana', { ok: false, confirmMs: 0 });
    // window slides; 2 failures in 20 = 10% → unhealthy.
    expect(m.isHealthy('solana')).toBe(false);
  });

  it('unhealthy when avg confirm time exceeds 30s', () => {
    const m = new ChainHealthMonitor({ maxConfirmMs: 30_000 });
    m.record('solana', { ok: true, confirmMs: 40_000 });
    expect(m.isHealthy('solana')).toBe(false);
  });
});

describe('blockchain/ResilientCommitter — 3-layer fallback', () => {
  function build(solanaFn: ChainSubmitFn, polygonFn: ChainSubmitFn, monitor = new ChainHealthMonitor()): ResilientCommitter {
    return new ResilientCommitter({
      solana: new ExternalChainCommitter('solana', solanaFn),
      polygon: new ExternalChainCommitter('polygon', polygonFn),
      rfc3161: new Rfc3161Notary('secret'),
      monitor,
    });
  }

  it('Layer 1: uses Solana when healthy', async () => {
    const r = await build(okSubmit('solana'), okSubmit('polygon')).commit(input);
    expect(r.chainUsed).toBe('solana');
  });

  it('Layer 2: falls back to Polygon when Solana submission fails', async () => {
    const r = await build(failSubmit, okSubmit('polygon')).commit(input);
    expect(r.chainUsed).toBe('polygon');
  });

  it('Layer 3: falls back to RFC 3161 when both chains fail', async () => {
    const r = await build(failSubmit, failSubmit).commit(input);
    expect(r.chainUsed).toBe('rfc3161');
  });

  it('skips Solana when the monitor marks it unhealthy', async () => {
    const monitor = new ChainHealthMonitor({ maxConfirmMs: 30_000 });
    // Pre-load Solana as congested.
    for (let i = 0; i < 5; i++) monitor.record('solana', { ok: true, confirmMs: 45_000 });
    const r = await build(okSubmit('solana'), okSubmit('polygon'), monitor).commit(input);
    expect(r.chainUsed).toBe('polygon');
  });

  it('records health samples as it commits', async () => {
    const monitor = new ChainHealthMonitor();
    await build(okSubmit('solana', 800), okSubmit('polygon'), monitor).commit(input);
    expect(monitor.isHealthy('solana')).toBe(true);
  });
});

describe('blockchain/explorerLink', () => {
  it('maps each chain to its explorer', () => {
    expect(explorerLink({ chainUsed: 'solana', reference: 'sig', committedAt: 0, confirmMs: 0 })).toMatch(
      /explorer\.solana\.com\/tx\/sig/,
    );
    expect(explorerLink({ chainUsed: 'polygon', reference: 'tx', committedAt: 0, confirmMs: 0 })).toMatch(
      /polygonscan\.com\/tx\/tx/,
    );
    expect(explorerLink({ chainUsed: 'rfc3161', reference: 'tok', committedAt: 0, confirmMs: 0 })).toMatch(
      /rfc3161-token:tok/,
    );
  });
});
