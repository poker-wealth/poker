import type { HandResult } from '../games/texas/texas-holdem.js';
import type { SettleRoundRequest } from './fc-client.js';

/**
 * Translates a Texas HandResult into the Financial Core settle-round request.
 *
 * KNOWN LIMITATION (flagged for the M1 settle-round amendment):
 * The M1 `/internal/settle-round` endpoint accepts a SINGLE winner. Poker
 * hands with split pots or side pots can have MULTIPLE winners. This adapter
 * handles the single-winner case (the large majority of hands) and throws
 * MultiWinnerSettlementError for the rest, so multi-winner settlement is an
 * explicit, visible gap — not a silent miscalculation.
 *
 * Resolving it requires extending FC settle-round to accept a winners[] with
 * per-winner amounts (a focused M1 amendment), tracked separately.
 */

export class MultiWinnerSettlementError extends Error {
  constructor(public readonly winners: string[]) {
    super(
      `MultiWinnerSettlement: hand has ${winners.length} winners (split/side pot). ` +
        `FC settle-round currently accepts one winner — needs the multi-winner amendment.`,
    );
    this.name = 'MultiWinnerSettlementError';
  }
}

export interface SettlementPolicy {
  tableType: 'PLATFORM' | 'LEAGUE';
  leagueId?: string;
  /** Rake taken from the pot, in cents (caller computes per house rules + caps). */
  rakeCents: bigint;
}

/**
 * Build the settle-round request for a SINGLE-winner hand.
 *
 * - winnerProfit = winner.net (their gain) + rake the engine didn't take.
 *   The engine produced net deltas with NO rake. FC will deduct `rakeCents`
 *   from the winner and route it; jackpot (0.5% of winnerProfit) is computed
 *   inside FC. So winnerProfit here is the winner's gross profit BEFORE rake.
 * - losers = every contributor who isn't the winner, with their committed amount.
 */
export function buildSettleRoundRequest(
  result: HandResult,
  policy: SettlementPolicy,
): SettleRoundRequest {
  if (result.winners.length !== 1) {
    throw new MultiWinnerSettlementError(result.winners);
  }
  const winnerId = result.winners[0]!;

  const losers = result.players
    .filter((p) => p.playerId !== winnerId && p.committed > 0n)
    .map((p) => ({ owner_id: p.playerId, contribution: p.committed.toString() }));

  // Winner's gross profit = total contributed by everyone else (what they won
  // beyond their own stake). The engine's `net` already reflects winnings
  // minus their own commit, so winnerProfit = winner.net.
  const winner = result.players.find((p) => p.playerId === winnerId);
  if (!winner) throw new Error('buildSettleRoundRequest: winner not found in players');
  const winnerProfit = winner.net > 0n ? winner.net : 0n;

  return {
    round_id: result.roundId,
    table_id: result.tableId,
    table_type: policy.tableType,
    league_id: policy.leagueId ?? null,
    winner_owner_id: winnerId,
    winner_profit: winnerProfit.toString(),
    rake_amount: policy.rakeCents.toString(),
    losers,
  };
}
