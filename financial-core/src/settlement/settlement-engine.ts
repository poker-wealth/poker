import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { logger } from '../lib/logger.js';
import { Ledger, type LedgerDoc } from '../wallet/ledger.model.js';
import { IdempotentReplay, applyTransfer } from '../wallet/transfer.js';
import { settlementEvents } from './events.js';
import { getPlayerWalletScope, getRakeDestination, type TableType } from './settlement-domain.js';

/**
 * Settlement Engine — Phase 1 (strong consistency).
 *
 * Spec §3.5: ALL transfer() calls within a single settlement MUST run in the
 * same MongoDB transaction so the round either commits whole or rolls back
 * whole. Local transaction time hard limit: ≤50ms.
 *
 * Pattern (per spec §3.9 fund flow):
 *   Phase A — each loser → winner   (WIN_PAYOUT × N)
 *   Phase B — winner → JACKPOT × 4  (JACKPOT_INJECT, 0.5% of winnerProfit
 *                                    split 20/30/25/25 across MINI/MINOR/MAJOR/GRAND)
 *   Phase C — winner → rake dest    (RAKE) — TREASURY for PLATFORM tables,
 *                                    LEAGUE_INVENTORY for LEAGUE tables.
 *
 * The receipt's `hash` is content-addressed (SHA-256 of the canonical JSON),
 * suitable for Solana commitment in Phase 2 (async).
 */

const JACKPOT_RATE_NUM = 5n; //  0.5%
const JACKPOT_RATE_DEN = 1000n;
const SPLIT_MINI = 20n;
const SPLIT_MINOR = 30n;
const SPLIT_MAJOR = 25n;
// SPLIT_GRAND = 25n, but we compute it as a remainder to absorb rounding cents.

const TX_DURATION_WARN_MS = 50;

export interface SettleRoundLoser {
  ownerId: string;
  /** Total chips this loser forfeits this round (cents). > 0. */
  contribution: bigint;
}

export interface SettleRoundInput {
  /** Unique round identifier — used for idempotency keys. */
  roundId: string;
  /** Table this round was played at — scopes per-table JACKPOT pools. */
  tableId: string;
  tableType: TableType;
  /** Required when tableType = 'LEAGUE'. */
  leagueId?: string;
  /** The single hand winner's ownerId. (Split-pot extension is future work.) */
  winnerOwnerId: string;
  /**
   * Winner's net profit in cents (winnings - bet_invested).
   * Drives the 0.5% jackpot injection.
   */
  winnerProfit: bigint;
  /** Total rake amount for the round in cents. May be 0. */
  rakeAmount: bigint;
  /** Each loser and their forfeit. Sum should ≥ jackpot total + rake amount. */
  losers: SettleRoundLoser[];
}

export interface JackpotSplit {
  mini: bigint;
  minor: bigint;
  major: bigint;
  grand: bigint;
  total: bigint;
}

export interface SettleRoundReceipt {
  roundId: string;
  tableId: string;
  tableType: TableType;
  leagueId: string | null;
  sequence: string[];
  amounts: {
    payouts: bigint[];
    rake: bigint;
    jackpot: JackpotSplit;
  };
  accounts: {
    winner: string;
    losers: string[];
    rake_dest: string | null;
    jackpot_mini: string | null;
    jackpot_minor: string | null;
    jackpot_major: string | null;
    jackpot_grand: string | null;
  };
  ledgerEntryIds: string[];
  /** SHA-256 of canonical JSON (sans hash field). */
  hash: string;
  durationMs: number;
  replayed: boolean;
}

/** Pure helper: compute the 4-tier jackpot split from winner profit. */
export function computeJackpot(winnerProfit: bigint): JackpotSplit {
  if (winnerProfit < 0n) throw new Error('computeJackpot: winnerProfit must be >= 0');
  const total = (winnerProfit * JACKPOT_RATE_NUM) / JACKPOT_RATE_DEN;
  const mini = (total * SPLIT_MINI) / 100n;
  const minor = (total * SPLIT_MINOR) / 100n;
  const major = (total * SPLIT_MAJOR) / 100n;
  // Grand absorbs rounding so MINI + MINOR + MAJOR + GRAND === total exactly.
  const grand = total - mini - minor - major;
  return { mini, minor, major, grand, total };
}

function validate(input: SettleRoundInput): void {
  if (!input.roundId) throw new Error('settleRound: roundId required');
  if (!input.tableId) throw new Error('settleRound: tableId required');
  if (!input.winnerOwnerId) throw new Error('settleRound: winnerOwnerId required');
  if (input.tableType === 'LEAGUE' && !input.leagueId) {
    throw new Error('settleRound: leagueId required for LEAGUE table');
  }
  if (input.winnerProfit < 0n) throw new Error('settleRound: winnerProfit must be >= 0');
  if (input.rakeAmount < 0n) throw new Error('settleRound: rakeAmount must be >= 0');
  if (!input.losers || input.losers.length === 0) {
    throw new Error('settleRound: at least one loser required');
  }
  for (const l of input.losers) {
    if (!l.ownerId) throw new Error('settleRound: loser.ownerId required');
    if (l.contribution <= 0n) throw new Error('settleRound: loser.contribution must be > 0');
  }
  if (input.losers.some((l) => l.ownerId === input.winnerOwnerId)) {
    throw new Error('settleRound: winner cannot also appear as a loser');
  }
}

function computeReceiptHash(r: Omit<SettleRoundReceipt, 'hash' | 'durationMs' | 'replayed'>): string {
  const payload = JSON.stringify({
    roundId: r.roundId,
    tableId: r.tableId,
    tableType: r.tableType,
    leagueId: r.leagueId,
    sequence: r.sequence,
    payouts: r.amounts.payouts.map(String),
    rake: String(r.amounts.rake),
    jackpot: {
      mini: String(r.amounts.jackpot.mini),
      minor: String(r.amounts.jackpot.minor),
      major: String(r.amounts.jackpot.major),
      grand: String(r.amounts.jackpot.grand),
      total: String(r.amounts.jackpot.total),
    },
    accounts: r.accounts,
    ledgerEntryIds: r.ledgerEntryIds,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function payoutKey(roundId: string, loserOwnerId: string): string {
  return `${roundId}:payout:${loserOwnerId}`;
}
function jackpotKey(roundId: string, tier: 'mini' | 'minor' | 'major' | 'grand'): string {
  return `${roundId}:jackpot:${tier}`;
}
function rakeKey(roundId: string): string {
  return `${roundId}:rake`;
}

export async function settleRound(input: SettleRoundInput): Promise<SettleRoundReceipt> {
  validate(input);

  const jackpot = computeJackpot(input.winnerProfit);
  const walletScope =
    input.tableType === 'PLATFORM'
      ? getPlayerWalletScope('PLATFORM')
      : getPlayerWalletScope('LEAGUE', input.leagueId!);
  const rakeDest =
    input.tableType === 'PLATFORM'
      ? getRakeDestination('PLATFORM')
      : getRakeDestination('LEAGUE', input.leagueId!);

  // Fast-path replay detection: if any of this round's idempotency keys
  // already exist in ledger, the round was settled previously. Reconstruct
  // the receipt from the existing entries.
  const replayProbe = await Ledger.findOne({
    idempotency_key: payoutKey(input.roundId, input.losers[0]!.ownerId),
  }).lean<LedgerDoc>();
  if (replayProbe) {
    const receipt = await loadExistingReceipt(input, jackpot, walletScope, rakeDest);
    settlementEvents.emit('replayed', receipt);
    return receipt;
  }

  const sequence: string[] = [];
  const ledgerEntryIds: string[] = [];
  const payouts: bigint[] = [];
  const loserAccountIds: string[] = [];
  let winnerAccountId = '';
  let rakeDestAccountId: string | null = null;
  let jpMiniId: string | null = null;
  let jpMinorId: string | null = null;
  let jpMajorId: string | null = null;
  let jpGrandId: string | null = null;

  const session = await mongoose.startSession();
  const started = Date.now();
  try {
    await session.withTransaction(async () => {
      // Phase A: each loser → winner (WIN_PAYOUT)
      for (const loser of input.losers) {
        const r = await applyTransfer(
          {
            from: { type: 'PLAYER', ownerId: loser.ownerId, walletScope },
            to: { type: 'PLAYER', ownerId: input.winnerOwnerId, walletScope },
            amount: loser.contribution,
            ledgerType: 'WIN_PAYOUT',
            idempotencyKey: payoutKey(input.roundId, loser.ownerId),
            metadata: {
              round_id: input.roundId,
              table_id: input.tableId,
              loser_id: loser.ownerId,
            },
          },
          session,
        );
        ledgerEntryIds.push(r.ledgerEntry._id);
        sequence.push('WIN_PAYOUT');
        payouts.push(loser.contribution);
        if (r.fromAccount?._id) loserAccountIds.push(r.fromAccount._id);
        if (r.toAccount?._id) winnerAccountId = r.toAccount._id;
      }

      // Phase B: winner → 4 JACKPOT pools (skip tiers with zero amount)
      const tiers: Array<['JACKPOT_MINI' | 'JACKPOT_MINOR' | 'JACKPOT_MAJOR' | 'JACKPOT_GRAND', bigint, 'mini' | 'minor' | 'major' | 'grand']> = [
        ['JACKPOT_MINI', jackpot.mini, 'mini'],
        ['JACKPOT_MINOR', jackpot.minor, 'minor'],
        ['JACKPOT_MAJOR', jackpot.major, 'major'],
        ['JACKPOT_GRAND', jackpot.grand, 'grand'],
      ];
      for (const [type, amount, tier] of tiers) {
        if (amount === 0n) continue;
        const r = await applyTransfer(
          {
            from: { type: 'PLAYER', ownerId: input.winnerOwnerId, walletScope },
            to: { type, ownerId: input.tableId },
            amount,
            ledgerType: 'JACKPOT_INJECT',
            idempotencyKey: jackpotKey(input.roundId, tier),
            metadata: {
              round_id: input.roundId,
              table_id: input.tableId,
              tier,
            },
          },
          session,
        );
        ledgerEntryIds.push(r.ledgerEntry._id);
        sequence.push('JACKPOT_INJECT');
        if (r.toAccount?._id) {
          if (tier === 'mini') jpMiniId = r.toAccount._id;
          else if (tier === 'minor') jpMinorId = r.toAccount._id;
          else if (tier === 'major') jpMajorId = r.toAccount._id;
          else jpGrandId = r.toAccount._id;
        }
      }

      // Phase C: winner → rake destination (RAKE) if non-zero
      if (input.rakeAmount > 0n) {
        const r = await applyTransfer(
          {
            from: { type: 'PLAYER', ownerId: input.winnerOwnerId, walletScope },
            to: { type: rakeDest.account_type, ownerId: rakeDest.owner_id },
            amount: input.rakeAmount,
            ledgerType: 'RAKE',
            idempotencyKey: rakeKey(input.roundId),
            metadata: { round_id: input.roundId, table_id: input.tableId },
          },
          session,
        );
        ledgerEntryIds.push(r.ledgerEntry._id);
        sequence.push('RAKE');
        if (r.toAccount?._id) rakeDestAccountId = r.toAccount._id;
      }
    });
  } catch (err) {
    if (err instanceof IdempotentReplay) {
      // Race lost — another caller settled this round between our replay-probe
      // and our tx. Reload and return.
      const receipt = await loadExistingReceipt(input, jackpot, walletScope, rakeDest);
      settlementEvents.emit('replayed', receipt);
      return receipt;
    }
    throw err;
  } finally {
    await session.endSession();
  }

  const durationMs = Date.now() - started;
  if (durationMs > TX_DURATION_WARN_MS) {
    logger.warn(
      { roundId: input.roundId, durationMs, transfers: ledgerEntryIds.length },
      `settleRound exceeded ${TX_DURATION_WARN_MS}ms hard limit`,
    );
  }

  const base: Omit<SettleRoundReceipt, 'hash' | 'durationMs' | 'replayed'> = {
    roundId: input.roundId,
    tableId: input.tableId,
    tableType: input.tableType,
    leagueId: input.leagueId ?? null,
    sequence,
    amounts: { payouts, rake: input.rakeAmount, jackpot },
    accounts: {
      winner: winnerAccountId,
      losers: loserAccountIds,
      rake_dest: rakeDestAccountId,
      jackpot_mini: jpMiniId,
      jackpot_minor: jpMinorId,
      jackpot_major: jpMajorId,
      jackpot_grand: jpGrandId,
    },
    ledgerEntryIds,
  };
  const receipt: SettleRoundReceipt = {
    ...base,
    hash: computeReceiptHash(base),
    durationMs,
    replayed: false,
  };

  // Phase 2 hook — fires AFTER tx commit. Listeners (M2+: Solana commitRound,
  // jackpot snapshot maintainer, rake aggregator) MUST be non-throwing or
  // they'll surface as unhandled rejections. We deliberately don't await.
  try {
    settlementEvents.emit('settled', receipt);
  } catch (err) {
    logger.error({ err, roundId: input.roundId }, 'settlement event listener threw');
  }

  return receipt;
}

async function loadExistingReceipt(
  input: SettleRoundInput,
  jackpot: JackpotSplit,
  _walletScope: string,
  _rakeDest: { account_type: string; owner_id: string },
): Promise<SettleRoundReceipt> {
  const entries = await Ledger.find({ 'metadata.round_id': input.roundId })
    .sort({ created_at: 1 })
    .lean<LedgerDoc[]>();
  if (entries.length === 0) {
    throw new Error(`loadExistingReceipt: no entries for round ${input.roundId}`);
  }

  const sequence: string[] = [];
  const ledgerEntryIds: string[] = [];
  const payouts: bigint[] = [];
  const loserAccountIds: string[] = [];
  let winnerAccountId = '';
  let rakeDestAccountId: string | null = null;
  let jpMiniId: string | null = null;
  let jpMinorId: string | null = null;
  let jpMajorId: string | null = null;
  let jpGrandId: string | null = null;

  for (const e of entries) {
    sequence.push(e.type);
    ledgerEntryIds.push(e._id);
    if (e.type === 'WIN_PAYOUT') {
      payouts.push(e.amount);
      if (e.from_account) loserAccountIds.push(e.from_account);
      if (e.to_account) winnerAccountId = e.to_account;
    } else if (e.type === 'JACKPOT_INJECT') {
      const tier = (e.metadata as { tier?: string }).tier;
      if (tier === 'mini') jpMiniId = e.to_account;
      else if (tier === 'minor') jpMinorId = e.to_account;
      else if (tier === 'major') jpMajorId = e.to_account;
      else if (tier === 'grand') jpGrandId = e.to_account;
    } else if (e.type === 'RAKE') {
      rakeDestAccountId = e.to_account;
    }
  }

  const base: Omit<SettleRoundReceipt, 'hash' | 'durationMs' | 'replayed'> = {
    roundId: input.roundId,
    tableId: input.tableId,
    tableType: input.tableType,
    leagueId: input.leagueId ?? null,
    sequence,
    amounts: { payouts, rake: input.rakeAmount, jackpot },
    accounts: {
      winner: winnerAccountId,
      losers: loserAccountIds,
      rake_dest: rakeDestAccountId,
      jackpot_mini: jpMiniId,
      jackpot_minor: jpMinorId,
      jackpot_major: jpMajorId,
      jackpot_grand: jpGrandId,
    },
    ledgerEntryIds,
  };
  return { ...base, hash: computeReceiptHash(base), durationMs: 0, replayed: true };
}
