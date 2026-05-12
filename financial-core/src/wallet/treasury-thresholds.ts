/**
 * Treasury hot/warm/cold threshold policy (spec §3.4 + §3.7).
 *
 * Three-tier on-chain treasury:
 *   - Hot   ($50,000 cap, HSM signature, auto withdrawal)
 *   - Warm  ($500,000 cap, 2/3 multi-sig, medium/large)
 *   - Cold  (70%+ platform funds, 3/5 multi-sig, offline)
 *
 * Rebalancing rules:
 *   - Hot > $50,000   → auto-aggregate to Warm.
 *   - Warm > $500,000 → human approval required to transfer to Cold.
 *   - Cold < 70% of total → human approval required to top up from Warm.
 *
 * Money values are BigInt cents. $50,000 = 5_000_000 cents.
 */

export const HOT_CAP_CENTS = 5_000_000n; // $50,000
export const WARM_CAP_CENTS = 50_000_000n; // $500,000
/** Cold must hold ≥70% of total platform funds. Expressed as numerator/denominator
 * to keep BigInt math integer-safe. */
export const COLD_FLOOR_NUM = 70n;
export const COLD_FLOOR_DEN = 100n;

export interface TreasuryAllocation {
  /** Cents currently held in the hot address. */
  hot: bigint;
  /** Cents in the warm address. */
  warm: bigint;
  /** Cents in the cold address. */
  cold: bigint;
}

export type RecommendationKind =
  | 'HOT_OVER_CAP_AUTO_AGGREGATE'
  | 'WARM_OVER_CAP_HUMAN_APPROVE'
  | 'COLD_UNDER_FLOOR_HUMAN_APPROVE'
  | 'OK';

export interface Recommendation {
  kind: RecommendationKind;
  /** Suggested amount (cents) to move; undefined for OK. */
  amount?: bigint;
  /** Source tier of the recommended move (e.g. 'hot'). */
  from?: 'hot' | 'warm' | 'cold';
  /** Destination tier. */
  to?: 'hot' | 'warm' | 'cold';
  /** Human-readable detail. */
  detail: string;
  /** Does this rebalancing require human/multi-sig approval? */
  requiresHumanApproval: boolean;
}

export interface EvaluationResult {
  total: bigint;
  ratios: { hot: number; warm: number; cold: number };
  recommendations: Recommendation[];
}

/**
 * Pure threshold evaluation. Returns a list of recommendations in priority
 * order (most urgent first). Callers decide whether to execute them.
 */
export function evaluateTreasuryAllocation(alloc: TreasuryAllocation): EvaluationResult {
  if (alloc.hot < 0n || alloc.warm < 0n || alloc.cold < 0n) {
    throw new Error('evaluateTreasuryAllocation: balances must be non-negative');
  }
  const total = alloc.hot + alloc.warm + alloc.cold;
  const recommendations: Recommendation[] = [];

  // Hot over cap → auto-aggregate excess to Warm.
  if (alloc.hot > HOT_CAP_CENTS) {
    const excess = alloc.hot - HOT_CAP_CENTS;
    recommendations.push({
      kind: 'HOT_OVER_CAP_AUTO_AGGREGATE',
      amount: excess,
      from: 'hot',
      to: 'warm',
      detail: `hot balance ${alloc.hot} > cap ${HOT_CAP_CENTS}; aggregate ${excess} to warm`,
      requiresHumanApproval: false,
    });
  }

  // Warm over cap → human approval to move excess to Cold.
  if (alloc.warm > WARM_CAP_CENTS) {
    const excess = alloc.warm - WARM_CAP_CENTS;
    recommendations.push({
      kind: 'WARM_OVER_CAP_HUMAN_APPROVE',
      amount: excess,
      from: 'warm',
      to: 'cold',
      detail: `warm balance ${alloc.warm} > cap ${WARM_CAP_CENTS}; move ${excess} to cold (2/3 → 3/5 multi-sig)`,
      requiresHumanApproval: true,
    });
  }

  // Cold under floor → human approval to top up from Warm.
  // Floor satisfied when: cold * den >= total * num  (avoids BigInt division).
  if (total > 0n && alloc.cold * COLD_FLOOR_DEN < total * COLD_FLOOR_NUM) {
    const required = (total * COLD_FLOOR_NUM) / COLD_FLOOR_DEN;
    const deficit = required - alloc.cold;
    recommendations.push({
      kind: 'COLD_UNDER_FLOOR_HUMAN_APPROVE',
      amount: deficit,
      from: 'warm',
      to: 'cold',
      detail: `cold ${alloc.cold} < ${COLD_FLOOR_NUM}% of total ${total}; top up cold by ${deficit}`,
      requiresHumanApproval: true,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      kind: 'OK',
      detail: 'all tiers within policy',
      requiresHumanApproval: false,
    });
  }

  // Ratios: floor-friendly approximations for human display (not used in policy).
  const ratios =
    total === 0n
      ? { hot: 0, warm: 0, cold: 0 }
      : {
          hot: Number((alloc.hot * 10000n) / total) / 100,
          warm: Number((alloc.warm * 10000n) / total) / 100,
          cold: Number((alloc.cold * 10000n) / total) / 100,
        };

  return { total, ratios, recommendations };
}

/** Helper: does this allocation need any action? */
export function needsRebalance(alloc: TreasuryAllocation): boolean {
  return evaluateTreasuryAllocation(alloc).recommendations.some((r) => r.kind !== 'OK');
}
