/**
 * Per-table Jackpot trigger + winner-selection logic (spec §5).
 *
 * Division of responsibility:
 *   - Financial Core injects 0.5% of each winner's profit into the 4 pools
 *     (handled by settle-round — already built in M1).
 *   - THIS engine decides, each hand, whether a tier should pay out, and if
 *     so, computes the payout amount and selects the winning player.
 *
 * Trigger decisions are derived from the round's provably-fair seed (not
 * Math.random), so a trigger is verifiable after the fact and cannot be
 * manipulated by the operator.
 *
 * Tiers (spec §5 table):
 *   Mini  — every 25–35 rounds   — 5%  of pool — min $10
 *   Minor — every 80–120 rounds  — 15% of pool — min $50
 *   Major — once per day         — 40% of pool — min $200
 *   Grand — Saturday 18–23 UTC+8 — 70% of pool — min $1,000
 *
 * Below threshold → skip; the round counter keeps accumulating. No subsidy,
 * no deferred payout.
 */

export const JACKPOT_TIERS = ['MINI', 'MINOR', 'MAJOR', 'GRAND'] as const;
export type JackpotTier = (typeof JACKPOT_TIERS)[number];

/** Minimum pool balance for a tier to be allowed to trigger (cents). */
export const MIN_THRESHOLD_CENTS: Readonly<Record<JackpotTier, bigint>> = Object.freeze({
  MINI: 1_000n, // $10
  MINOR: 5_000n, // $50
  MAJOR: 20_000n, // $200
  GRAND: 100_000n, // $1,000
});

/** Payout as a percentage of the pool when a tier triggers. */
export const PAYOUT_PCT: Readonly<Record<JackpotTier, bigint>> = Object.freeze({
  MINI: 5n,
  MINOR: 15n,
  MAJOR: 40n,
  GRAND: 70n,
});

/** Round-count trigger ranges for the frequency-based tiers [min, max] inclusive. */
export const FREQUENCY_RANGE: Readonly<Record<'MINI' | 'MINOR', readonly [number, number]>> =
  Object.freeze({
    MINI: [25, 35],
    MINOR: [80, 120],
  });

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

export function payoutAmount(tier: JackpotTier, poolCents: bigint): bigint {
  if (poolCents < 0n) throw new Error('payoutAmount: poolCents must be >= 0');
  return (poolCents * PAYOUT_PCT[tier]) / 100n;
}

export function meetsThreshold(tier: JackpotTier, poolCents: bigint): boolean {
  return poolCents >= MIN_THRESHOLD_CENTS[tier];
}

/**
 * Pick the random round-count target for a Mini/Minor cycle, deterministically
 * from a [0,1) value (derived from the round seed). e.g. Mini → 25..35.
 */
export function pickRoundTarget(tier: 'MINI' | 'MINOR', rng01: number): number {
  if (rng01 < 0 || rng01 >= 1) throw new Error('pickRoundTarget: rng01 must be in [0,1)');
  const [lo, hi] = FREQUENCY_RANGE[tier];
  return lo + Math.floor(rng01 * (hi - lo + 1));
}

/** Is `now` inside the Grand window: Saturday 18:00–23:00 UTC+8? */
export function isGrandWindow(now: Date): boolean {
  const shifted = new Date(now.getTime() + UTC8_OFFSET_MS);
  const day = shifted.getUTCDay(); // 6 = Saturday
  const hour = shifted.getUTCHours();
  return day === 6 && hour >= 18 && hour < 23;
}

export interface TriggerDecision {
  triggered: boolean;
  tier: JackpotTier;
  payoutCents: bigint;
  /** Human-readable reason (esp. when NOT triggered). */
  reason: string;
}

/** Evaluate a frequency-based tier (Mini/Minor). */
export function evaluateFrequencyTrigger(input: {
  tier: 'MINI' | 'MINOR';
  roundsSinceLastTrigger: number;
  roundTarget: number;
  poolCents: bigint;
}): TriggerDecision {
  const { tier, roundsSinceLastTrigger, roundTarget, poolCents } = input;
  if (roundsSinceLastTrigger < roundTarget) {
    return { triggered: false, tier, payoutCents: 0n, reason: `round ${roundsSinceLastTrigger}/${roundTarget}` };
  }
  if (!meetsThreshold(tier, poolCents)) {
    return {
      triggered: false,
      tier,
      payoutCents: 0n,
      reason: `pool ${poolCents} below threshold ${MIN_THRESHOLD_CENTS[tier]} — skip, counter continues`,
    };
  }
  return { triggered: true, tier, payoutCents: payoutAmount(tier, poolCents), reason: 'frequency reached' };
}

/** Evaluate the Major tier (once per day, random — gated by date + threshold). */
export function evaluateMajorTrigger(input: {
  poolCents: bigint;
  now: Date;
  lastTriggerDate: Date | null;
  /** Deterministic [0,1) from the round seed; the daily trigger fires when this clears `dailyChance`. */
  rng01: number;
  /** Probability a given hand triggers Major (so it lands ~once across a day's hands). */
  dailyChance: number;
}): TriggerDecision {
  const { poolCents, now, lastTriggerDate, rng01, dailyChance } = input;
  if (lastTriggerDate && sameUtc8Day(lastTriggerDate, now)) {
    return { triggered: false, tier: 'MAJOR', payoutCents: 0n, reason: 'already triggered today' };
  }
  if (!meetsThreshold('MAJOR', poolCents)) {
    return { triggered: false, tier: 'MAJOR', payoutCents: 0n, reason: 'below threshold — skip' };
  }
  if (rng01 >= dailyChance) {
    return { triggered: false, tier: 'MAJOR', payoutCents: 0n, reason: 'random gate not cleared this hand' };
  }
  return { triggered: true, tier: 'MAJOR', payoutCents: payoutAmount('MAJOR', poolCents), reason: 'daily random trigger' };
}

/** Evaluate the Grand tier (Saturday 18–23 UTC+8 window, random within). */
export function evaluateGrandTrigger(input: {
  poolCents: bigint;
  now: Date;
  triggeredThisWindow: boolean;
  rng01: number;
  windowChance: number;
}): TriggerDecision {
  const { poolCents, now, triggeredThisWindow, rng01, windowChance } = input;
  if (!isGrandWindow(now)) {
    return { triggered: false, tier: 'GRAND', payoutCents: 0n, reason: 'outside Saturday 18–23 UTC+8 window' };
  }
  if (triggeredThisWindow) {
    return { triggered: false, tier: 'GRAND', payoutCents: 0n, reason: 'already triggered this window' };
  }
  if (!meetsThreshold('GRAND', poolCents)) {
    return { triggered: false, tier: 'GRAND', payoutCents: 0n, reason: 'below threshold — skip' };
  }
  if (rng01 >= windowChance) {
    return { triggered: false, tier: 'GRAND', payoutCents: 0n, reason: 'random gate not cleared this hand' };
  }
  return { triggered: true, tier: 'GRAND', payoutCents: payoutAmount('GRAND', poolCents), reason: 'window random trigger' };
}

function sameUtc8Day(a: Date, b: Date): boolean {
  const sa = new Date(a.getTime() + UTC8_OFFSET_MS);
  const sb = new Date(b.getTime() + UTC8_OFFSET_MS);
  return (
    sa.getUTCFullYear() === sb.getUTCFullYear() &&
    sa.getUTCMonth() === sb.getUTCMonth() &&
    sa.getUTCDate() === sb.getUTCDate()
  );
}

// ── Winner weighting (spec §5 + §6 Day 28) ─────────────────────────

export type BehaviorFactor = 1.0 | 0.5 | 0.0; // normal / flagged / confirmed collusion
export type NonCollusionFactor = 1.0 | 0.3; // unassociated / IP-device-GPS associated

export interface WeightInput {
  baseWeight: number;
  behaviorFactor: BehaviorFactor;
  nonCollusionFactor: NonCollusionFactor;
  /** VIP jackpot weight bonus: V4 → +0.10, V5 → +0.25, else 0. */
  vipBonus?: number;
}

export function computeWeight(input: WeightInput): number {
  const { baseWeight, behaviorFactor, nonCollusionFactor, vipBonus = 0 } = input;
  if (baseWeight < 0) throw new Error('computeWeight: baseWeight must be >= 0');
  return baseWeight * behaviorFactor * nonCollusionFactor * (1 + vipBonus);
}

export interface WeightedPlayer {
  playerId: string;
  weight: number;
}

/**
 * Weighted-random winner selection from a deterministic [0,1) value.
 * Confirmed-collusion players (weight 0) can never win. Returns null if no
 * player has positive weight.
 */
export function selectJackpotWinner(players: WeightedPlayer[], rng01: number): string | null {
  if (rng01 < 0 || rng01 >= 1) throw new Error('selectJackpotWinner: rng01 must be in [0,1)');
  const total = players.reduce((s, p) => s + Math.max(0, p.weight), 0);
  if (total <= 0) return null;
  let cursor = rng01 * total;
  for (const p of players) {
    const w = Math.max(0, p.weight);
    if (cursor < w) return p.playerId;
    cursor -= w;
  }
  // Floating-point edge — return the last positive-weight player.
  for (let i = players.length - 1; i >= 0; i--) {
    if ((players[i]?.weight ?? 0) > 0) return players[i]!.playerId;
  }
  return null;
}
