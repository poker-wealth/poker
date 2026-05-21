import { bytesToHex } from '@noble/hashes/utils';
import { logger } from '../lib/logger.js';
import {
  computeFinalSeed,
  computeServerCommit,
  generateServerSeed,
  SEED_BYTES,
} from './commit-reveal.js';
import {
  DrandTimeoutError,
  fetchDrandLatest,
  type DrandClientOptions,
  type DrandResult,
} from './drand.js';
import { type CloudRandomSource } from './kms.js';

/**
 * Per-round randomness orchestrator (spec §6).
 *
 * beginRound() runs at T+0ms. It:
 *   1. Generates server_seed + server_commit (commit PUBLISHED before dealing).
 *   2. Pulls drand (5s race) and cloud (KMS) randomness.
 *   3. Computes final_seed (triple-mix). If drand times out, falls back to
 *      KMS-only and records randomSource='fallback_kms'.
 *
 * The returned RoundSeed carries everything needed to (a) deal the deck and
 * (b) later build the verification receipt.
 */

export type RandomSource = 'drand' | 'fallback_kms';

export interface RoundSeed {
  roundId: string;
  serverSeed: Uint8Array;
  serverSeedHex: string;
  serverCommit: string;
  finalSeed: Uint8Array;
  finalSeedHex: string;
  randomSource: RandomSource;
  /** Present only when randomSource === 'drand'. */
  drand: { round: number; randomnessHex: string; source: string } | null;
  cloudSourceId: string;
  cloudRandomHex: string;
}

export interface BeginRoundDeps {
  drand: DrandClientOptions;
  cloud: CloudRandomSource;
  /** Test seam: inject a fixed server seed for deterministic tests. */
  serverSeedOverride?: Uint8Array;
}

let fallbackCount = 0;

export async function beginRound(roundId: string, deps: BeginRoundDeps): Promise<RoundSeed> {
  if (!roundId) throw new Error('beginRound: roundId required');

  // 1. Server seed + commit (the commit is what gets published pre-deal).
  const serverSeed = deps.serverSeedOverride ?? generateServerSeed();
  if (serverSeed.length !== SEED_BYTES) throw new Error(`beginRound: serverSeed must be ${SEED_BYTES} bytes`);
  const serverCommit = computeServerCommit(serverSeed);

  // 2. Cloud randomness (always available — local CSPRNG or KMS).
  const cloudRandom = await deps.cloud.generate(SEED_BYTES);

  // 3. drand with hard timeout → fallback to KMS-only.
  let drandResult: DrandResult | null = null;
  let randomSource: RandomSource = 'drand';
  try {
    drandResult = await fetchDrandLatest(deps.drand);
  } catch (err) {
    if (err instanceof DrandTimeoutError) {
      randomSource = 'fallback_kms';
      fallbackCount++;
      logger.warn({ roundId, fallbackCount }, 'drand timeout — using KMS-only fallback');
      if (fallbackCount >= 3) {
        logger.error({ fallbackCount }, 'drand unavailable 3+ times — manual decision required');
      }
    } else {
      // Non-timeout failure (bad response, all endpoints errored): also fall back.
      randomSource = 'fallback_kms';
      fallbackCount++;
      logger.warn({ roundId, err: (err as Error).message }, 'drand error — using KMS-only fallback');
    }
  }

  const finalSeed = computeFinalSeed({
    serverSeed,
    drandValue: drandResult?.randomness ?? null,
    cloudRandom,
    roundId,
  });

  return {
    roundId,
    serverSeed,
    serverSeedHex: bytesToHex(serverSeed),
    serverCommit,
    finalSeed,
    finalSeedHex: bytesToHex(finalSeed),
    randomSource,
    drand: drandResult
      ? { round: drandResult.round, randomnessHex: drandResult.randomnessHex, source: drandResult.source }
      : null,
    cloudSourceId: deps.cloud.id,
    cloudRandomHex: bytesToHex(cloudRandom),
  };
}

/** Test helper — reset the module-level fallback counter. */
export function __resetFallbackCount(): void {
  fallbackCount = 0;
}
