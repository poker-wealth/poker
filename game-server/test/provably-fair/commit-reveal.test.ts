import { sha256 } from '@noble/hashes/sha256';
import {
  computeFinalSeed,
  computeServerCommit,
  generateServerSeed,
  SEED_BYTES,
  verifyServerCommit,
} from '../../src/provably-fair/commit-reveal';

describe('provably-fair/commit-reveal', () => {
  it('generateServerSeed returns 32 random bytes, different each call', () => {
    const a = generateServerSeed();
    const b = generateServerSeed();
    expect(a).toHaveLength(SEED_BYTES);
    expect(b).toHaveLength(SEED_BYTES);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('computeServerCommit is SHA256(seed) in hex', () => {
    const seed = new Uint8Array(32).fill(7);
    const expected = Buffer.from(sha256(seed)).toString('hex');
    expect(computeServerCommit(seed)).toBe(expected);
  });

  it('verifyServerCommit passes for the right seed, fails for a tampered seed (V1)', () => {
    const seed = generateServerSeed();
    const commit = computeServerCommit(seed);
    expect(verifyServerCommit(seed, commit)).toBe(true);
    expect(verifyServerCommit(seed, commit.toUpperCase())).toBe(true); // case-insensitive
    const tampered = new Uint8Array(seed);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    expect(verifyServerCommit(tampered, commit)).toBe(false);
  });

  it('computeFinalSeed is deterministic for the same inputs', () => {
    const input = {
      serverSeed: new Uint8Array(32).fill(1),
      drandValue: new Uint8Array(32).fill(2),
      cloudRandom: new Uint8Array(32).fill(3),
      roundId: 'round-1',
    };
    expect(computeFinalSeed(input)).toEqual(computeFinalSeed(input));
  });

  it('computeFinalSeed changes if ANY input changes (triple-mix)', () => {
    const base = {
      serverSeed: new Uint8Array(32).fill(1),
      drandValue: new Uint8Array(32).fill(2),
      cloudRandom: new Uint8Array(32).fill(3),
      roundId: 'round-1',
    };
    const baseHex = Buffer.from(computeFinalSeed(base)).toString('hex');

    const diffServer = Buffer.from(
      computeFinalSeed({ ...base, serverSeed: new Uint8Array(32).fill(9) }),
    ).toString('hex');
    const diffDrand = Buffer.from(
      computeFinalSeed({ ...base, drandValue: new Uint8Array(32).fill(9) }),
    ).toString('hex');
    const diffCloud = Buffer.from(
      computeFinalSeed({ ...base, cloudRandom: new Uint8Array(32).fill(9) }),
    ).toString('hex');
    const diffRound = Buffer.from(computeFinalSeed({ ...base, roundId: 'round-2' })).toString('hex');

    expect(diffServer).not.toBe(baseHex);
    expect(diffDrand).not.toBe(baseHex);
    expect(diffCloud).not.toBe(baseHex);
    expect(diffRound).not.toBe(baseHex);
  });

  it('fallback path (drandValue=null) still produces a valid 32-byte seed', () => {
    const seed = computeFinalSeed({
      serverSeed: new Uint8Array(32).fill(1),
      drandValue: null,
      cloudRandom: new Uint8Array(32).fill(3),
      roundId: 'round-1',
    });
    expect(seed).toHaveLength(32);
    // And it differs from the with-drand seed.
    const withDrand = computeFinalSeed({
      serverSeed: new Uint8Array(32).fill(1),
      drandValue: new Uint8Array(32).fill(2),
      cloudRandom: new Uint8Array(32).fill(3),
      roundId: 'round-1',
    });
    expect(Buffer.from(seed).equals(Buffer.from(withDrand))).toBe(false);
  });
});
