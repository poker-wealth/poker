/**
 * Texas Hold'em betting math — pots, side pots, and award resolution.
 *
 * This is the fiddly heart of poker: when players go all-in for different
 * amounts, the pot splits into a main pot + side pots, each with its own set
 * of eligible winners. Pure functions, exhaustively tested.
 *
 * All chip amounts are BigInt cents.
 */

export interface PlayerChips {
  playerId: string;
  /** Total chips this player put into the pot this hand (across all streets). */
  committed: bigint;
  /** Folded players' chips stay in the pot but they can't win it. */
  folded: boolean;
}

export interface Pot {
  amount: bigint;
  /** Players eligible to win this pot (contributed to it AND not folded). */
  eligible: string[];
}

/**
 * Split total contributions into a main pot + side pots by all-in layers.
 *
 * Algorithm (standard layered side-pots):
 *   While anyone still has un-allocated contribution:
 *     - take the smallest remaining contribution level `L`
 *     - every still-contributing player owes `L` into this layer
 *     - layer amount = L × (number of contributors at this layer)
 *     - eligible = contributors at this layer who have NOT folded
 *     - subtract L from each contributor's remaining
 *   Adjacent layers with identical eligible sets are merged.
 *
 * Folded players' chips ARE counted in pot amounts (their money is in the
 * pot) but they are never eligible to win.
 */
export function computePots(players: PlayerChips[]): Pot[] {
  const contributors = players
    .filter((p) => p.committed > 0n)
    .map((p) => ({ playerId: p.playerId, remaining: p.committed, folded: p.folded }));

  if (contributors.length === 0) return [];

  const pots: Pot[] = [];

  while (contributors.some((c) => c.remaining > 0n)) {
    const active = contributors.filter((c) => c.remaining > 0n);
    const level = active.reduce((min, c) => (c.remaining < min ? c.remaining : min), active[0]!.remaining);

    let amount = 0n;
    for (const c of active) {
      c.remaining -= level;
      amount += level;
    }
    const eligible = active.filter((c) => !c.folded).map((c) => c.playerId);

    // Skip a layer with no eligible winners only if it's degenerate (all
    // contributors at this layer folded). Their chips roll into the next
    // layer's amount by being re-counted? No — they're already counted here.
    // If eligible is empty, fold this amount into the previous pot if any,
    // else keep it as an uneligible pot (resolved by caller's last-man rule).
    if (eligible.length === 0) {
      if (pots.length > 0) {
        pots[pots.length - 1]!.amount += amount;
      } else {
        pots.push({ amount, eligible: [] });
      }
      continue;
    }

    // Merge with the previous pot if the eligible set is identical.
    const prev = pots[pots.length - 1];
    if (prev && sameSet(prev.eligible, eligible)) {
      prev.amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
  }

  return pots;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

export interface AwardResult {
  /** playerId → chips won (cents). Players not present won nothing. */
  payouts: Map<string, bigint>;
  /** Per-pot breakdown for the settlement receipt. */
  potAwards: Array<{ amount: bigint; winners: string[]; perWinner: bigint; oddChip: bigint }>;
}

/**
 * Award each pot to the highest-ranked eligible hand. Ties split evenly; the
 * odd chip (when a pot doesn't divide evenly) goes to the first winner in the
 * provided `seatOrder` — the standard "odd chip to the earliest seat" rule.
 *
 * `strengths` maps playerId → hand rank (higher wins). Players who reached
 * showdown must have an entry; folded/ineligible players need not.
 */
export function awardPots(
  pots: Pot[],
  strengths: ReadonlyMap<string, number>,
  seatOrder: readonly string[],
): AwardResult {
  const payouts = new Map<string, bigint>();
  const potAwards: AwardResult['potAwards'] = [];

  for (const pot of pots) {
    if (pot.amount === 0n) continue;
    const ranked = pot.eligible.filter((p) => strengths.has(p));
    if (ranked.length === 0) {
      // No eligible ranked player (degenerate). Skip — caller handles
      // last-man-standing before showdown so this shouldn't occur.
      continue;
    }
    const maxRank = ranked.reduce((m, p) => Math.max(m, strengths.get(p)!), -1);
    const winners = ranked.filter((p) => strengths.get(p) === maxRank);
    // Order winners by seatOrder for deterministic odd-chip assignment.
    winners.sort((a, b) => seatOrder.indexOf(a) - seatOrder.indexOf(b));

    const perWinner = pot.amount / BigInt(winners.length);
    const oddChip = pot.amount - perWinner * BigInt(winners.length);

    winners.forEach((w, i) => {
      const share = perWinner + (i === 0 ? oddChip : 0n);
      payouts.set(w, (payouts.get(w) ?? 0n) + share);
    });

    potAwards.push({ amount: pot.amount, winners, perWinner, oddChip });
  }

  return { payouts, potAwards };
}

/** Sum of all pot amounts — used to assert chip conservation. */
export function totalPot(pots: Pot[]): bigint {
  return pots.reduce((sum, p) => sum + p.amount, 0n);
}
