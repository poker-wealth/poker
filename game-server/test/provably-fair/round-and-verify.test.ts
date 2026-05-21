import { bytesToHex } from '@noble/hashes/utils';
import { cardId } from '../../src/cards/card';
import { freshDeck, shuffleDeck } from '../../src/cards/deck';
import { type CloudRandomSource, localCsprng } from '../../src/provably-fair/kms';
import {
  __resetFallbackCount,
  beginRound,
  type BeginRoundDeps,
} from '../../src/provably-fair/round-randomness';
import { verifyReveal, type RevealReceipt } from '../../src/provably-fair/verification';
import type { FetchFn } from '../../src/provably-fair/drand';

const DRAND_HEX = 'b'.repeat(64);

function drandOk(): FetchFn {
  return async () => ({ ok: true, status: 200, json: async () => ({ round: 42, randomness: DRAND_HEX }) });
}
function drandTimeout(): FetchFn {
  return (_url, init) =>
    new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
}

function deps(fetchFn: FetchFn, cloud: CloudRandomSource = localCsprng): BeginRoundDeps {
  return {
    drand: { urls: ['https://drand.example'], timeoutMs: 100, fetchFn },
    cloud,
  };
}

/** Build the receipt a server would publish + the deck it dealt. */
function buildReceipt(seed: Awaited<ReturnType<typeof beginRound>>): RevealReceipt {
  const dealtDeck = shuffleDeck(freshDeck(), seed.finalSeed).map(cardId);
  return {
    roundId: seed.roundId,
    serverSeedHex: seed.serverSeedHex,
    serverCommit: seed.serverCommit,
    finalSeedHex: seed.finalSeedHex,
    randomSource: seed.randomSource,
    cloudRandomHex: seed.cloudRandomHex,
    drand: seed.drand,
    dealtDeck,
  };
}

describe('provably-fair/round + verification (end-to-end)', () => {
  beforeEach(() => __resetFallbackCount());

  it('happy path: drand available → randomSource=drand, all checks pass', async () => {
    const seed = await beginRound('round-1', deps(drandOk()));
    expect(seed.randomSource).toBe('drand');
    expect(seed.drand?.round).toBe(42);
    expect(seed.serverCommit).toHaveLength(64);
    expect(seed.finalSeed).toHaveLength(32);

    const receipt = buildReceipt(seed);
    const result = verifyReveal(receipt, DRAND_HEX); // verifier supplies external drand value
    expect(result.ok).toBe(true);
    expect(result.checks.v1_commit).toBe('pass');
    expect(result.checks.v2_drand).toBe('pass');
    expect(result.checks.v3_shuffle).toBe('pass');
    expect(result.checks.v4_onchain).toBe('skipped');
    expect(result.checks.v5_probability_table).toBe('skipped');
  });

  it('drand timeout → randomSource=fallback_kms, V2 skipped, V1+V3 still pass', async () => {
    const seed = await beginRound('round-2', deps(drandTimeout()));
    expect(seed.randomSource).toBe('fallback_kms');
    expect(seed.drand).toBeNull();

    const receipt = buildReceipt(seed);
    const result = verifyReveal(receipt);
    expect(result.ok).toBe(true);
    expect(result.checks.v1_commit).toBe('pass');
    expect(result.checks.v2_drand).toBe('skipped');
    expect(result.checks.v3_shuffle).toBe('pass');
  });

  it('V1 fails if the revealed server seed does not match the commit', async () => {
    const seed = await beginRound('round-3', deps(drandOk()));
    const receipt = buildReceipt(seed);
    // Tamper: swap the commit to something else.
    receipt.serverCommit = 'f'.repeat(64);
    const result = verifyReveal(receipt, DRAND_HEX);
    expect(result.ok).toBe(false);
    expect(result.checks.v1_commit).toBe('fail');
  });

  it('V2 fails if the external drand value differs from the receipt', async () => {
    const seed = await beginRound('round-4', deps(drandOk()));
    const receipt = buildReceipt(seed);
    const result = verifyReveal(receipt, 'c'.repeat(64)); // wrong external value
    expect(result.ok).toBe(false);
    expect(result.checks.v2_drand).toBe('fail');
  });

  it('V3 fails if the dealt deck was tampered (does not match the seed)', async () => {
    const seed = await beginRound('round-5', deps(drandOk()));
    const receipt = buildReceipt(seed);
    // Swap two cards in the dealt deck.
    const tmp = receipt.dealtDeck[0]!;
    receipt.dealtDeck[0] = receipt.dealtDeck[1]!;
    receipt.dealtDeck[1] = tmp;
    const result = verifyReveal(receipt, DRAND_HEX);
    expect(result.ok).toBe(false);
    expect(result.checks.v3_shuffle).toBe('fail');
  });

  it('deterministic: same server seed + same drand → identical final seed and deck', async () => {
    const fixedSeed = new Uint8Array(32).fill(5);
    const d: BeginRoundDeps = {
      drand: { urls: ['https://drand.example'], timeoutMs: 100, fetchFn: drandOk() },
      cloud: { id: 'fixed', generate: async () => new Uint8Array(32).fill(9) },
      serverSeedOverride: fixedSeed,
    };
    const a = await beginRound('round-fixed', d);
    const b = await beginRound('round-fixed', d);
    expect(a.finalSeedHex).toBe(b.finalSeedHex);
    expect(bytesToHex(a.finalSeed)).toBe(bytesToHex(b.finalSeed));
  });
});
