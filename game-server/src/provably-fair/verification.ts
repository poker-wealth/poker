import { hexToBytes } from '@noble/hashes/utils';
import { type Card, cardId } from '../cards/card.js';
import { freshDeck, shuffleDeck } from '../cards/deck.js';
import { computeFinalSeed, computeServerCommit, verifyServerCommit } from './commit-reveal.js';

/**
 * 5-step verification (spec §6.3). Anyone — including untrusted clients —
 * can run this against a published reveal to confirm a hand was honest.
 *
 *   V1: SHA256(server_seed) === server_commit       (seed wasn't swapped)
 *   V2: drand randomness matches the external beacon (verifiable randomness)
 *   V3: recompute final_seed → Fisher-Yates → matches the dealt card order
 *   V4: Solana tx timestamp precedes game start       (DEFERRED — M2 on-chain)
 *   V5: probability_table_hash matches public config   (N/A for Texas; M3+ games)
 *
 * This module implements V1–V3 (fully checkable offline). V4/V5 are reported
 * as 'skipped' until the on-chain + probability-table infrastructure lands.
 */

export interface RevealReceipt {
  roundId: string;
  serverSeedHex: string;
  serverCommit: string;
  finalSeedHex: string;
  randomSource: 'drand' | 'fallback_kms';
  cloudRandomHex: string;
  drand: { round: number; randomnessHex: string; source: string } | null;
  /** The card order that was actually dealt (full 52-card deck, CardId strings). */
  dealtDeck: string[];
}

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface VerificationResult {
  ok: boolean; // true iff all non-skipped checks pass
  checks: {
    v1_commit: CheckStatus;
    v2_drand: CheckStatus;
    v3_shuffle: CheckStatus;
    v4_onchain: CheckStatus;
    v5_probability_table: CheckStatus;
  };
  notes: string[];
}

/**
 * Verify a revealed receipt. `externalDrandRandomnessHex`, when provided,
 * is the value the verifier independently fetched from the drand network for
 * the same round — V2 checks the receipt matches it.
 */
export function verifyReveal(
  receipt: RevealReceipt,
  externalDrandRandomnessHex?: string,
): VerificationResult {
  const notes: string[] = [];
  const checks: VerificationResult['checks'] = {
    v1_commit: 'fail',
    v2_drand: 'skipped',
    v3_shuffle: 'fail',
    v4_onchain: 'skipped',
    v5_probability_table: 'skipped',
  };

  // V1 — commit integrity.
  const serverSeed = hexToBytes(receipt.serverSeedHex);
  checks.v1_commit = verifyServerCommit(serverSeed, receipt.serverCommit) ? 'pass' : 'fail';
  if (checks.v1_commit === 'fail') {
    notes.push(`V1 failed: SHA256(server_seed)=${computeServerCommit(serverSeed)} != commit=${receipt.serverCommit}`);
  }

  // V2 — drand external match (only when randomSource was drand AND the
  // verifier supplied the independently-fetched value).
  if (receipt.randomSource === 'drand' && receipt.drand) {
    if (externalDrandRandomnessHex !== undefined) {
      checks.v2_drand =
        externalDrandRandomnessHex.toLowerCase() === receipt.drand.randomnessHex.toLowerCase()
          ? 'pass'
          : 'fail';
      if (checks.v2_drand === 'fail') {
        notes.push(`V2 failed: external drand ${externalDrandRandomnessHex} != receipt ${receipt.drand.randomnessHex}`);
      }
    } else {
      notes.push('V2 skipped: no external drand value supplied to compare');
    }
  } else {
    checks.v2_drand = 'skipped';
    notes.push('V2 skipped: round used KMS-only fallback (no drand to verify)');
  }

  // V3 — recompute final_seed → reshuffle → must match dealt deck.
  const recomputedFinal = computeFinalSeed({
    serverSeed,
    drandValue: receipt.drand ? hexToBytes(receipt.drand.randomnessHex) : null,
    cloudRandom: hexToBytes(receipt.cloudRandomHex),
    roundId: receipt.roundId,
  });
  const recomputedHex = bytesToHexLocal(recomputedFinal);
  if (recomputedHex !== receipt.finalSeedHex.toLowerCase()) {
    checks.v3_shuffle = 'fail';
    notes.push(`V3 failed: recomputed final_seed ${recomputedHex} != receipt ${receipt.finalSeedHex}`);
  } else {
    const reshuffled: Card[] = shuffleDeck(freshDeck(), recomputedFinal);
    const reshuffledIds = reshuffled.map(cardId);
    const matches =
      reshuffledIds.length === receipt.dealtDeck.length &&
      reshuffledIds.every((id, i) => id === receipt.dealtDeck[i]);
    checks.v3_shuffle = matches ? 'pass' : 'fail';
    if (!matches) notes.push('V3 failed: reshuffled deck does not match dealt deck');
  }

  // V4 / V5 — deferred infrastructure.
  notes.push('V4 skipped: Solana on-chain timestamp check lands with M2 blockchain integration');
  notes.push('V5 skipped: probability-table hash N/A for Texas Hold\'em (applies to M3+ games)');

  const ok =
    checks.v1_commit === 'pass' &&
    checks.v3_shuffle === 'pass' &&
    checks.v2_drand !== 'fail'; // skipped is acceptable; fail is not

  return { ok, checks, notes };
}

// Local hex encoder to avoid importing the whole utils surface twice.
function bytesToHexLocal(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
