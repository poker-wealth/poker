import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Underwriting Engine — 5-step insurance capacity check + quote (spec §4).
 *
 * Texas Hold'em MVP. Offered to an all-in player to protect against a bad
 * beat. The pipeline assesses capacity FIRST and generates the quote LAST.
 *
 * Iron rules (spec §4):
 *   - Max single payout = reserve × 5% (hardcoded, NOT admin-configurable).
 *   - Max daily payout  = reserve × 15% (tracked via the risk-budget lock).
 *   - Auto-disable when reserve < threshold (Platform $10k / League $1k).
 *   - The quote exposes the displayed odds ONLY. RiskFactor never appears in
 *     any output — it's an internal multiplier, HMAC-protected at rest.
 *
 * Pure decision function. The Redis pre-calc cache (<10ms All-in reads) and
 * the 30s TTL budget reservation are runtime concerns layered on top.
 */

export type InsuranceSystem = 'PLATFORM' | 'LEAGUE';

/** Reserve health thresholds in cents. Below this, insurance is disabled. */
export const RESERVE_THRESHOLD_CENTS: Readonly<Record<InsuranceSystem, bigint>> = Object.freeze({
  PLATFORM: 1_000_000n, // $10,000
  LEAGUE: 100_000n, // $1,000
});

/** Max single payout = reserve × 5%. */
export const MAX_SINGLE_PAYOUT_PCT = 5n;
/** Max daily payout (and daily risk budget) = reserve × 15%. */
export const MAX_DAILY_PAYOUT_PCT = 15n;

export interface UnderwritingRequest {
  system: InsuranceSystem;
  /** Insurance pool reserve, cents. */
  reserveCents: bigint;
  /** Payout the player wants covered if the insured event (their loss) happens, cents. */
  requestedPayoutCents: bigint;
  /** Sum of payouts already reserved against today's budget, cents. */
  reservedExposureCents: bigint;
  /** Probability the insured event happens (the player loses the all-in), 0..1. */
  lossProbability: number;
  /**
   * Internal house risk multiplier (≥1 adds margin). NEVER returned to the
   * client. In production this is read with HMAC validation — see
   * validateRiskFactor().
   */
  riskFactor: number;
}

export interface InsuranceQuote {
  premiumCents: bigint;
  payoutCents: bigint;
  /** Odds shown to the player: payout per unit premium, 2 decimals. ONLY this is surfaced. */
  displayedOdds: number;
  /** Risk-budget reservation the caller locks in Redis (TTL=30s). */
  budgetReservation: { amountCents: bigint; ttlMs: number };
}

export type UnderwritingResult =
  | { approved: true; quote: InsuranceQuote }
  | { approved: false; step: 1 | 2 | 3 | 4; reason: string };

const BUDGET_RESERVATION_TTL_MS = 30_000;

function dailyBudget(reserveCents: bigint): bigint {
  return (reserveCents * MAX_DAILY_PAYOUT_PCT) / 100n;
}
function maxSinglePayout(reserveCents: bigint): bigint {
  return (reserveCents * MAX_SINGLE_PAYOUT_PCT) / 100n;
}

export function underwrite(req: UnderwritingRequest): UnderwritingResult {
  if (req.lossProbability < 0 || req.lossProbability > 1) {
    throw new Error('underwrite: lossProbability must be in [0,1]');
  }
  if (req.riskFactor <= 0) throw new Error('underwrite: riskFactor must be > 0');
  if (req.requestedPayoutCents <= 0n) throw new Error('underwrite: requestedPayoutCents must be > 0');

  // Step 1 — Reserve health.
  const threshold = RESERVE_THRESHOLD_CENTS[req.system];
  if (req.reserveCents < threshold) {
    return { approved: false, step: 1, reason: `reserve ${req.reserveCents} below threshold ${threshold}` };
  }

  // Step 2 — Exposure (daily risk budget lock).
  const budget = dailyBudget(req.reserveCents);
  const available = budget - req.reservedExposureCents;
  if (available <= 0n) {
    return { approved: false, step: 2, reason: 'daily risk budget exhausted' };
  }

  // Step 3 — Single payout cap (reserve × 5%).
  const singleCap = maxSinglePayout(req.reserveCents);
  if (req.requestedPayoutCents > singleCap) {
    return {
      approved: false,
      step: 3,
      reason: `payout ${req.requestedPayoutCents} exceeds single cap ${singleCap}`,
    };
  }

  // Step 4 — Max coverage (also bounded by remaining daily budget).
  if (req.requestedPayoutCents > available) {
    return {
      approved: false,
      step: 4,
      reason: `payout ${req.requestedPayoutCents} exceeds remaining daily budget ${available}`,
    };
  }

  // Step 5 — Quote (last). premium = payout × p × riskFactor, rounded up
  // (house favor). The 1e-6 epsilon strips IEEE-754 dust (e.g. 0.2×1.1 =
  // 0.22000000000000003) so a clean value isn't bumped a spurious cent.
  const fair = Number(req.requestedPayoutCents) * req.lossProbability * req.riskFactor;
  const premiumCents = BigInt(Math.max(1, Math.ceil(fair - 1e-6)));
  const displayedOdds = round2(Number(req.requestedPayoutCents) / Number(premiumCents));

  return {
    approved: true,
    quote: {
      premiumCents,
      payoutCents: req.requestedPayoutCents,
      displayedOdds,
      budgetReservation: { amountCents: req.requestedPayoutCents, ttlMs: BUDGET_RESERVATION_TTL_MS },
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── RiskFactor HMAC protection (spec §4) ───────────────────────────

/**
 * RiskFactor is stored with an HMAC so ops can't silently tamper with it.
 * On read, validate the signature; on mismatch, reset to 1.0 and signal an
 * alert (the caller fires the actual TG/ops alert).
 */
export function signRiskFactor(value: number, secret: string): string {
  return createHmac('sha256', secret).update(value.toFixed(6)).digest('hex');
}

export function validateRiskFactor(
  value: number,
  signature: string,
  secret: string,
): { value: number; valid: boolean } {
  const expected = signRiskFactor(value, secret);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const valid = a.length === b.length && timingSafeEqual(a, b);
  // Mismatch → fail safe to 1.0 (no house margin, no advantage from tampering).
  return valid ? { value, valid: true } : { value: 1.0, valid: false };
}
