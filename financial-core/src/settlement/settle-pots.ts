import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';
import { Ledger, type LedgerDoc } from '../wallet/ledger.model.js';
import { IdempotentReplay, applyTransfer } from '../wallet/transfer.js';
import { settlementEvents } from './events.js';
import { computeJackpot, type JackpotSplit } from './settlement-engine.js';
import { getPlayerWalletScope, getRakeDestination, type TableType } from './settlement-domain.js';

/**
 * Multi-winner settlement (spec §3.5, extended for split / side pots).
 *
 * The single-winner `settleRound` can't express poker hands where the pot is
 * split (tie) or layered into side pots with different winners. This path
 * settles from per-player NET deltas instead:
 *
 *   - netDeltas sum to 0 (the game engine conserves chips; it takes no rake).
 *   - Winners (net > 0) collectively receive what losers (net < 0) forfeit.
 *   - WIN_PAYOUT entries are produced by greedily matching losers to winners.
 *   - Rake + jackpot (0.5% of total winner profit) are then taken from the
 *     PRIMARY winner (largest net). The house receives the exact correct
 *     total; for the uncommon split-pot case the inter-winner split of the
 *     house's cut is approximate (the biggest winner absorbs it). Documented
 *     simplification — revisit if exact per-winner rake apportionment matters.
 *
 * Same atomic-transaction + idempotency guarantees as settleRound. The
 * single-winner case routes through here identically (one winner, N losers).
 */

const TX_DURATION_WARN_MS = 50;

export interface NetDelta {
  ownerId: string;
  /** Net chips this hand BEFORE rake/jackpot. Winners > 0, losers < 0. */
  net: bigint;
  /** Defaults to the table's wallet scope. */
  walletScope?: string;
}

export interface SettlePotsInput {
  roundId: string;
  tableId: string;
  tableType: TableType;
  leagueId?: string;
  rakeAmount: bigint;
  netDeltas: NetDelta[];
}

export interface SettlePotsReceipt {
  roundId: string;
  tableId: string;
  tableType: TableType;
  leagueId: string | null;
  winners: string[];
  amounts: {
    rake: bigint;
    jackpot: JackpotSplit;
    /** Gross WIN_PAYOUT routed loser → winner (before rake/jackpot). */
    grossPayoutTotal: bigint;
  };
  ledgerEntryIds: string[];
  hash: string;
  durationMs: number;
  replayed: boolean;
}

function validate(input: SettlePotsInput): void {
  if (!input.roundId) throw new Error('settlePots: roundId required');
  if (!input.tableId) throw new Error('settlePots: tableId required');
  if (input.tableType === 'LEAGUE' && !input.leagueId) {
    throw new Error('settlePots: leagueId required for LEAGUE table');
  }
  if (input.rakeAmount < 0n) throw new Error('settlePots: rakeAmount must be >= 0');
  if (!input.netDeltas || input.netDeltas.length < 2) {
    throw new Error('settlePots: at least two players required');
  }
  const sum = input.netDeltas.reduce((s, d) => s + d.net, 0n);
  if (sum !== 0n) throw new Error(`settlePots: net deltas must sum to 0, got ${sum}`);
  const seen = new Set<string>();
  for (const d of input.netDeltas) {
    if (!d.ownerId) throw new Error('settlePots: ownerId required');
    if (seen.has(d.ownerId)) throw new Error(`settlePots: duplicate owner ${d.ownerId}`);
    seen.add(d.ownerId);
  }
}

function payoutKey(roundId: string, from: string, to: string): string {
  return `${roundId}:payout:${from}->${to}`;
}
function jackpotKey(roundId: string, tier: string): string {
  return `${roundId}:jackpot:${tier}`;
}
function rakeKey(roundId: string): string {
  return `${roundId}:rake`;
}

export async function settlePots(input: SettlePotsInput): Promise<SettlePotsReceipt> {
  validate(input);

  const scope =
    input.tableType === 'PLATFORM'
      ? getPlayerWalletScope('PLATFORM')
      : getPlayerWalletScope('LEAGUE', input.leagueId!);
  const rakeDest =
    input.tableType === 'PLATFORM'
      ? getRakeDestination('PLATFORM')
      : getRakeDestination('LEAGUE', input.leagueId!);

  const winners = input.netDeltas.filter((d) => d.net > 0n).sort((a, b) => (b.net > a.net ? 1 : -1));
  const losers = input.netDeltas.filter((d) => d.net < 0n);
  const totalWinnerProfit = winners.reduce((s, w) => s + w.net, 0n);
  const jackpot = computeJackpot(totalWinnerProfit);

  if (input.rakeAmount + jackpot.total > totalWinnerProfit) {
    throw new Error('settlePots: rake + jackpot exceeds total winner profit');
  }

  // Fast-path replay detection.
  const probeKey = winners.length > 0 && losers.length > 0
    ? payoutKey(input.roundId, losers[0]!.ownerId, winners[0]!.ownerId)
    : rakeKey(input.roundId);
  const probe = await Ledger.findOne({ idempotency_key: probeKey }).lean<LedgerDoc>();
  if (probe) {
    const receipt = await loadExistingReceipt(input, jackpot);
    settlementEvents.emit('replayed', { roundId: input.roundId } as never);
    return receipt;
  }

  const session = await mongoose.startSession();
  const started = Date.now();
  const ledgerEntryIds: string[] = [];
  let grossPayoutTotal = 0n;

  try {
    await session.withTransaction(async () => {
      // Greedy loser → winner matching for WIN_PAYOUT.
      const loserRem = losers.map((l) => ({ ownerId: l.ownerId, scope: l.walletScope ?? scope, rem: -l.net }));
      const winnerRem = winners.map((w) => ({ ownerId: w.ownerId, scope: w.walletScope ?? scope, rem: w.net }));
      let li = 0;
      let wi = 0;
      while (li < loserRem.length && wi < winnerRem.length) {
        const l = loserRem[li]!;
        const w = winnerRem[wi]!;
        const amt = l.rem < w.rem ? l.rem : w.rem;
        if (amt > 0n) {
          const r = await applyTransfer(
            {
              from: { type: 'PLAYER', ownerId: l.ownerId, walletScope: l.scope },
              to: { type: 'PLAYER', ownerId: w.ownerId, walletScope: w.scope },
              amount: amt,
              ledgerType: 'WIN_PAYOUT',
              idempotencyKey: payoutKey(input.roundId, l.ownerId, w.ownerId),
              metadata: { round_id: input.roundId, table_id: input.tableId },
            },
            session,
          );
          ledgerEntryIds.push(r.ledgerEntry._id);
          grossPayoutTotal += amt;
        }
        l.rem -= amt;
        w.rem -= amt;
        if (l.rem === 0n) li++;
        if (w.rem === 0n) wi++;
      }

      // Primary winner (largest net) covers rake + jackpot.
      const primary = winners[0];
      if (primary) {
        const primaryScope = primary.walletScope ?? scope;

        // Jackpot: 4 pools (skip zero tiers).
        const tiers: Array<['JACKPOT_MINI' | 'JACKPOT_MINOR' | 'JACKPOT_MAJOR' | 'JACKPOT_GRAND', bigint, string]> = [
          ['JACKPOT_MINI', jackpot.mini, 'mini'],
          ['JACKPOT_MINOR', jackpot.minor, 'minor'],
          ['JACKPOT_MAJOR', jackpot.major, 'major'],
          ['JACKPOT_GRAND', jackpot.grand, 'grand'],
        ];
        for (const [type, amount, tier] of tiers) {
          if (amount === 0n) continue;
          const r = await applyTransfer(
            {
              from: { type: 'PLAYER', ownerId: primary.ownerId, walletScope: primaryScope },
              to: { type, ownerId: input.tableId },
              amount,
              ledgerType: 'JACKPOT_INJECT',
              idempotencyKey: jackpotKey(input.roundId, tier),
              metadata: { round_id: input.roundId, table_id: input.tableId, tier },
            },
            session,
          );
          ledgerEntryIds.push(r.ledgerEntry._id);
        }

        // Rake.
        if (input.rakeAmount > 0n) {
          const r = await applyTransfer(
            {
              from: { type: 'PLAYER', ownerId: primary.ownerId, walletScope: primaryScope },
              to: { type: rakeDest.account_type, ownerId: rakeDest.owner_id },
              amount: input.rakeAmount,
              ledgerType: 'RAKE',
              idempotencyKey: rakeKey(input.roundId),
              metadata: { round_id: input.roundId, table_id: input.tableId },
            },
            session,
          );
          ledgerEntryIds.push(r.ledgerEntry._id);
        }
      }
    });
  } catch (err) {
    if (err instanceof IdempotentReplay) {
      const receipt = await loadExistingReceipt(input, jackpot);
      settlementEvents.emit('replayed', { roundId: input.roundId } as never);
      return receipt;
    }
    throw err;
  } finally {
    await session.endSession();
  }

  const durationMs = Date.now() - started;
  if (durationMs > TX_DURATION_WARN_MS) {
    logger.warn({ roundId: input.roundId, durationMs, transfers: ledgerEntryIds.length }, 'settlePots exceeded 50ms');
  }

  const base = {
    roundId: input.roundId,
    tableId: input.tableId,
    tableType: input.tableType,
    leagueId: input.leagueId ?? null,
    winners: winners.map((w) => w.ownerId),
    amounts: { rake: input.rakeAmount, jackpot, grossPayoutTotal: grossPayoutTotal },
    ledgerEntryIds,
  };
  const receipt: SettlePotsReceipt = {
    ...base,
    hash: hashReceipt(base),
    durationMs,
    replayed: false,
  };
  settlementEvents.emit('settled', { roundId: input.roundId } as never);
  return receipt;
}

function hashReceipt(base: Omit<SettlePotsReceipt, 'hash' | 'durationMs' | 'replayed'>): string {
  const payload = JSON.stringify({
    roundId: base.roundId,
    tableId: base.tableId,
    tableType: base.tableType,
    leagueId: base.leagueId,
    winners: base.winners,
    rake: base.amounts.rake.toString(),
    jackpotTotal: base.amounts.jackpot.total.toString(),
    gross: base.amounts.grossPayoutTotal.toString(),
    ledgerEntryIds: base.ledgerEntryIds,
  });
  return createHash('sha256').update(payload).digest('hex');
}

async function loadExistingReceipt(
  input: SettlePotsInput,
  jackpot: JackpotSplit,
): Promise<SettlePotsReceipt> {
  const entries = await Ledger.find({ 'metadata.round_id': input.roundId })
    .sort({ created_at: 1 })
    .lean<LedgerDoc[]>();
  const ledgerEntryIds = entries.map((e) => e._id);
  let gross = 0n;
  for (const e of entries) if (e.type === 'WIN_PAYOUT') gross += e.amount;
  const winners = input.netDeltas.filter((d) => d.net > 0n).map((d) => d.ownerId);
  const base = {
    roundId: input.roundId,
    tableId: input.tableId,
    tableType: input.tableType,
    leagueId: input.leagueId ?? null,
    winners,
    amounts: { rake: input.rakeAmount, jackpot, grossPayoutTotal: gross },
    ledgerEntryIds,
  };
  return { ...base, hash: hashReceipt(base), durationMs: 0, replayed: true };
}
