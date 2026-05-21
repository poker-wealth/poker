import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';

/**
 * Commit-Reveal core (spec §6) — pure crypto, no I/O.
 *
 * Flow:
 *   T+0ms: generateServerSeed() → 32 random bytes
 *          computeServerCommit(seed) → SHA256(seed) hex      ← PUBLISHED before dealing
 *          DEAL CARDS using final_seed (computed below)
 *   later: reveal server_seed. Anyone verifies SHA256(server_seed) == commit.
 *
 * final_seed = SHA256(server_seed || drand || cloud_random || round_id)
 *
 * Triple-mix property: an attacker must compromise the server seed AND drand
 * AND the cloud (KMS) source to predict a card. Any one alone is useless.
 */

export const SEED_BYTES = 32;

export function generateServerSeed(): Uint8Array {
  return new Uint8Array(randomBytes(SEED_BYTES));
}

export function computeServerCommit(serverSeed: Uint8Array): string {
  return bytesToHex(sha256(serverSeed));
}

/** V1 of verification: does the revealed seed hash to the published commit? */
export function verifyServerCommit(serverSeed: Uint8Array, commitHex: string): boolean {
  return computeServerCommit(serverSeed) === commitHex.toLowerCase();
}

export interface FinalSeedInput {
  serverSeed: Uint8Array;
  /** drand randomness bytes, or null in the KMS-only fallback path. */
  drandValue: Uint8Array | null;
  /** AWS KMS (or local crypto) random bytes. */
  cloudRandom: Uint8Array;
  roundId: string;
}

/**
 * final_seed = SHA256(server_seed || drand || cloud_random || round_id).
 * In the fallback path (drand unavailable), drandValue is null and omitted
 * from the concatenation — the randomSource field on the receipt records this.
 */
export function computeFinalSeed(input: FinalSeedInput): Uint8Array {
  const roundBytes = new TextEncoder().encode(input.roundId);
  const drandBytes = input.drandValue ?? new Uint8Array(0);
  return sha256(concatBytes(input.serverSeed, drandBytes, input.cloudRandom, roundBytes));
}

export { bytesToHex };
