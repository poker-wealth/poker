import { logger } from '../lib/logger.js';
import { Ledger } from '../wallet/ledger.model.js';
import { transfer } from '../wallet/transfer.js';
import {
  Withdrawal,
  type WithdrawalDoc,
  type WithdrawalState,
} from './withdrawal.model.js';

/**
 * Withdrawal state machine — spec §3.6.
 *
 * Allowed transitions:
 *   REQUESTED   → APPROVED | ROLLED_BACK   (cancellation by player or risk control)
 *   APPROVED    → BROADCASTING
 *   BROADCASTING → CONFIRMED | FAILED
 *   FAILED      → ROLLED_BACK              (auto, with WITHDRAW_REFUND ledger entry)
 *   CONFIRMED, ROLLED_BACK                 (terminal)
 *
 * Side effects:
 *   - approve(): transfer(PLAYER → null, WITHDRAW, status='PENDING'). Balance
 *     atomically deducted. Writes WITHDRAW ledger entry.
 *   - markConfirmed(): updates the WITHDRAW ledger entry status PENDING → SETTLED.
 *   - markFailed(): updates the WITHDRAW ledger entry status PENDING → FAILED.
 *   - rollback() (auto on FAILED): transfer(null → PLAYER, WITHDRAW_REFUND).
 *     Balance atomically refunded. Writes WITHDRAW_REFUND ledger entry.
 */

const ALLOWED_NEXT: Readonly<Record<WithdrawalState, ReadonlySet<WithdrawalState>>> = Object.freeze({
  REQUESTED: new Set<WithdrawalState>(['APPROVED', 'ROLLED_BACK']),
  APPROVED: new Set<WithdrawalState>(['BROADCASTING']),
  BROADCASTING: new Set<WithdrawalState>(['CONFIRMED', 'FAILED']),
  CONFIRMED: new Set<WithdrawalState>(),
  FAILED: new Set<WithdrawalState>(['ROLLED_BACK']),
  ROLLED_BACK: new Set<WithdrawalState>(),
});

export class WithdrawalNotFoundError extends Error {
  constructor(public readonly withdrawalId: string) {
    super(`WithdrawalNotFound: ${withdrawalId}`);
    this.name = 'WithdrawalNotFoundError';
  }
}

export class IllegalWithdrawalTransitionError extends Error {
  constructor(
    public readonly from: WithdrawalState,
    public readonly to: WithdrawalState,
    public readonly withdrawalId: string,
  ) {
    super(`IllegalWithdrawalTransition: ${from} -> ${to} on withdrawal ${withdrawalId}`);
    this.name = 'IllegalWithdrawalTransitionError';
  }
}

export interface CreateWithdrawalInput {
  playerId: string;
  amount: bigint; // cents
  destinationAddress: string;
  /** Optional wallet scope (defaults to PLATFORM). League withdrawals not supported. */
  walletScope?: string;
}

export async function createWithdrawal(input: CreateWithdrawalInput): Promise<WithdrawalDoc> {
  if (!input.playerId) throw new Error('createWithdrawal: playerId required');
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) {
    throw new Error('createWithdrawal: amount must be a positive BigInt (cents)');
  }
  if (!input.destinationAddress) throw new Error('createWithdrawal: destinationAddress required');

  const created = await Withdrawal.create({
    player_id: input.playerId,
    amount: input.amount,
    destination_address: input.destinationAddress,
    state: 'REQUESTED',
    state_history: [{ state: 'REQUESTED', at: new Date(), actor: 'system' }],
  });
  logger.info(
    { withdrawalId: created._id, playerId: input.playerId, amount: input.amount.toString() },
    'withdrawal REQUESTED',
  );
  return created.toObject();
}

function ensureTransition(
  withdrawal: WithdrawalDoc,
  next: WithdrawalState,
): void {
  const allowed = ALLOWED_NEXT[withdrawal.state];
  if (!allowed.has(next)) {
    throw new IllegalWithdrawalTransitionError(withdrawal.state, next, withdrawal._id);
  }
}

async function loadOrThrow(withdrawalId: string): Promise<WithdrawalDoc> {
  const w = await Withdrawal.findById(withdrawalId);
  if (!w) throw new WithdrawalNotFoundError(withdrawalId);
  return w.toObject();
}

export interface ApproveInput {
  withdrawalId: string;
  /** Ops user id; required for amounts > $10K (≥1_000_000 cents). */
  reviewer?: string;
  /** Optional wallet scope (defaults to PLATFORM). */
  walletScope?: string;
}

const HUMAN_REVIEW_THRESHOLD = 1_000_000n; // $10,000 in cents

/**
 * REQUESTED → APPROVED. Atomically deducts balance via WITHDRAW ledger entry
 * (status=PENDING). The on-chain broadcast and confirmation happen later via
 * markBroadcasting() and markConfirmed().
 */
export async function approveWithdrawal(input: ApproveInput): Promise<WithdrawalDoc> {
  const w = await loadOrThrow(input.withdrawalId);
  ensureTransition(w, 'APPROVED');

  if (w.amount > HUMAN_REVIEW_THRESHOLD && !input.reviewer) {
    throw new Error(
      `approveWithdrawal: amounts > ${HUMAN_REVIEW_THRESHOLD} cents require reviewer`,
    );
  }

  // Deduct balance via WITHDRAW (status=PENDING; flips to SETTLED on CONFIRMED).
  const transferResult = await transfer({
    from: { type: 'PLAYER', ownerId: w.player_id, walletScope: input.walletScope ?? 'PLATFORM' },
    amount: w.amount,
    ledgerType: 'WITHDRAW',
    idempotencyKey: `withdraw:${w._id}`,
    status: 'PENDING',
    metadata: {
      withdrawal_id: w._id,
      destination_address: w.destination_address,
      reviewer: input.reviewer ?? null,
    },
  });

  const updated = await Withdrawal.findOneAndUpdate(
    { _id: w._id, state: 'REQUESTED' },
    {
      $set: {
        state: 'APPROVED',
        ledger_entry_id: transferResult.ledgerEntry._id,
        reviewed_by: input.reviewer ?? null,
      },
      $push: {
        state_history: {
          state: 'APPROVED',
          at: new Date(),
          actor: input.reviewer ?? 'auto',
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    // CAS race — somebody else moved this withdrawal. Reload and decide.
    throw new IllegalWithdrawalTransitionError(w.state, 'APPROVED', w._id);
  }
  logger.info(
    { withdrawalId: w._id, ledgerEntryId: transferResult.ledgerEntry._id },
    'withdrawal APPROVED + balance deducted',
  );
  return updated.toObject();
}

export interface MarkBroadcastingInput {
  withdrawalId: string;
  txHash: string;
}

export async function markBroadcasting(input: MarkBroadcastingInput): Promise<WithdrawalDoc> {
  if (!input.txHash) throw new Error('markBroadcasting: txHash required');
  const w = await loadOrThrow(input.withdrawalId);
  ensureTransition(w, 'BROADCASTING');

  const updated = await Withdrawal.findOneAndUpdate(
    { _id: w._id, state: 'APPROVED' },
    {
      $set: { state: 'BROADCASTING', tx_hash: input.txHash },
      $push: {
        state_history: { state: 'BROADCASTING', at: new Date(), actor: 'system', note: input.txHash },
      },
    },
    { new: true },
  );
  if (!updated) throw new IllegalWithdrawalTransitionError(w.state, 'BROADCASTING', w._id);
  logger.info({ withdrawalId: w._id, txHash: input.txHash }, 'withdrawal BROADCASTING');
  return updated.toObject();
}

export interface MarkConfirmedInput {
  withdrawalId: string;
}

export async function markConfirmed(input: MarkConfirmedInput): Promise<WithdrawalDoc> {
  const w = await loadOrThrow(input.withdrawalId);
  ensureTransition(w, 'CONFIRMED');

  // Flip the WITHDRAW ledger entry from PENDING → SETTLED.
  if (w.ledger_entry_id) {
    await Ledger.updateOne(
      { _id: w.ledger_entry_id, status: 'PENDING' },
      { $set: { status: 'SETTLED' } },
    );
  }

  const updated = await Withdrawal.findOneAndUpdate(
    { _id: w._id, state: 'BROADCASTING' },
    {
      $set: { state: 'CONFIRMED' },
      $push: { state_history: { state: 'CONFIRMED', at: new Date(), actor: 'system' } },
    },
    { new: true },
  );
  if (!updated) throw new IllegalWithdrawalTransitionError(w.state, 'CONFIRMED', w._id);
  logger.info({ withdrawalId: w._id }, 'withdrawal CONFIRMED');
  return updated.toObject();
}

export interface MarkFailedInput {
  withdrawalId: string;
  reason: string;
  /** Optional wallet scope used for the refund (defaults to PLATFORM). */
  walletScope?: string;
}

/**
 * BROADCASTING → FAILED → ROLLED_BACK. Two transitions in one call:
 * 1. Mark FAILED (and flip ledger entry status PENDING → FAILED).
 * 2. Auto-refund via transfer(null → PLAYER, WITHDRAW_REFUND), then mark ROLLED_BACK.
 *
 * Returns the final ROLLED_BACK doc.
 */
export async function markFailedAndRollback(input: MarkFailedInput): Promise<WithdrawalDoc> {
  if (!input.reason) throw new Error('markFailedAndRollback: reason required');
  const w = await loadOrThrow(input.withdrawalId);
  ensureTransition(w, 'FAILED');

  // 1. Mark FAILED + update ledger entry.
  if (w.ledger_entry_id) {
    await Ledger.updateOne(
      { _id: w.ledger_entry_id, status: 'PENDING' },
      { $set: { status: 'FAILED' } },
    );
  }
  const failedDoc = await Withdrawal.findOneAndUpdate(
    { _id: w._id, state: 'BROADCASTING' },
    {
      $set: { state: 'FAILED', failure_reason: input.reason },
      $push: { state_history: { state: 'FAILED', at: new Date(), actor: 'system', note: input.reason } },
    },
    { new: true },
  );
  if (!failedDoc) throw new IllegalWithdrawalTransitionError(w.state, 'FAILED', w._id);

  // 2. Refund and mark ROLLED_BACK.
  const refund = await transfer({
    to: { type: 'PLAYER', ownerId: w.player_id, walletScope: input.walletScope ?? 'PLATFORM' },
    amount: w.amount,
    ledgerType: 'WITHDRAW_REFUND',
    idempotencyKey: `withdraw-refund:${w._id}`,
    status: 'SETTLED',
    metadata: {
      withdrawal_id: w._id,
      original_ledger_entry_id: w.ledger_entry_id,
      reason: input.reason,
    },
  });

  const rolledBack = await Withdrawal.findOneAndUpdate(
    { _id: w._id, state: 'FAILED' },
    {
      $set: { state: 'ROLLED_BACK', refund_ledger_entry_id: refund.ledgerEntry._id },
      $push: {
        state_history: { state: 'ROLLED_BACK', at: new Date(), actor: 'system', note: 'auto-refund' },
      },
    },
    { new: true },
  );
  if (!rolledBack) throw new IllegalWithdrawalTransitionError('FAILED', 'ROLLED_BACK', w._id);

  logger.warn(
    { withdrawalId: w._id, reason: input.reason, refundLedgerEntryId: refund.ledgerEntry._id },
    'withdrawal FAILED → ROLLED_BACK + balance refunded',
  );
  return rolledBack.toObject();
}

/** Cancel a REQUESTED withdrawal (player or risk-control rejection). No balance change. */
export async function cancelWithdrawal(
  withdrawalId: string,
  actor: string,
  note?: string,
): Promise<WithdrawalDoc> {
  const w = await loadOrThrow(withdrawalId);
  ensureTransition(w, 'ROLLED_BACK');

  const updated = await Withdrawal.findOneAndUpdate(
    { _id: w._id, state: 'REQUESTED' },
    {
      $set: { state: 'ROLLED_BACK', failure_reason: note ?? 'cancelled' },
      $push: {
        state_history: { state: 'ROLLED_BACK', at: new Date(), actor, note: note ?? 'cancelled' },
      },
    },
    { new: true },
  );
  if (!updated) throw new IllegalWithdrawalTransitionError(w.state, 'ROLLED_BACK', w._id);
  logger.info({ withdrawalId: w._id, actor }, 'withdrawal cancelled (REQUESTED → ROLLED_BACK)');
  return updated.toObject();
}

export { ALLOWED_NEXT, HUMAN_REVIEW_THRESHOLD };
