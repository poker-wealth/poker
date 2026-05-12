import mongoose, { Schema, type Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';

/**
 * Withdrawal — 5-state machine per spec §3.6.
 *
 *   REQUESTED  → balance NOT yet deducted; awaiting risk control + human review.
 *   APPROVED   → balance atomically deducted via transfer(PLAYER, null, WITHDRAW).
 *   BROADCASTING → on-chain tx broadcast; balance deducted; awaiting confirmations.
 *   CONFIRMED  → 20-block confirm (terminal).
 *   FAILED → ROLLED_BACK → broadcast failure or 48h timeout; balance atomically
 *            refunded via transfer(null, PLAYER, WITHDRAW_REFUND).
 *
 * Address modification (spec §10.2): 48-hour cooldown, player-initiated only;
 * not modeled here — enforced upstream in the API/handler layer.
 */
export const WITHDRAWAL_STATES = [
  'REQUESTED',
  'APPROVED',
  'BROADCASTING',
  'CONFIRMED',
  'FAILED',
  'ROLLED_BACK',
] as const;

export type WithdrawalState = (typeof WITHDRAWAL_STATES)[number];

export interface WithdrawalHistoryEntry {
  state: WithdrawalState;
  at: Date;
  actor?: string; // ops user id, "auto", or "system"
  note?: string;
}

export interface WithdrawalDoc {
  _id: string;
  player_id: string;
  amount: bigint;
  destination_address: string;
  state: WithdrawalState;
  /** WITHDRAW ledger entry id (set when transitioning REQUESTED → APPROVED). */
  ledger_entry_id: string | null;
  /** WITHDRAW_REFUND ledger entry id (set when transitioning FAILED → ROLLED_BACK). */
  refund_ledger_entry_id: string | null;
  /** On-chain tx hash, set when BROADCASTING begins. */
  tx_hash: string | null;
  /** Ops user id who approved (required for amounts > $10K per spec §10.2). */
  reviewed_by: string | null;
  /** Reason for FAILED state. */
  failure_reason: string | null;
  state_history: WithdrawalHistoryEntry[];
  created_at: Date;
  updated_at: Date;
}

const WithdrawalHistorySchema = new Schema<WithdrawalHistoryEntry>(
  {
    state: { type: String, enum: [...WITHDRAWAL_STATES], required: true },
    at: { type: Date, required: true, default: () => new Date() },
    actor: { type: String, default: undefined },
    note: { type: String, default: undefined },
  },
  { _id: false },
);

const WithdrawalSchema = new Schema<WithdrawalDoc>(
  {
    _id: { type: String, default: () => uuidv7() },
    player_id: { type: String, required: true, immutable: true, trim: true },
    amount: {
      type: BigInt,
      required: true,
      immutable: true,
      validate: {
        validator: (v: bigint) => typeof v === 'bigint' && v > 0n,
        message: 'amount must be a positive BigInt (cents)',
      },
    },
    destination_address: { type: String, required: true, immutable: true, trim: true },
    state: {
      type: String,
      enum: { values: [...WITHDRAWAL_STATES], message: 'invalid state: {VALUE}' },
      required: true,
      default: 'REQUESTED',
    },
    ledger_entry_id: { type: String, default: null },
    refund_ledger_entry_id: { type: String, default: null },
    tx_hash: { type: String, default: null },
    reviewed_by: { type: String, default: null },
    failure_reason: { type: String, default: null },
    state_history: { type: [WithdrawalHistorySchema], default: () => [] },
  },
  {
    collection: 'withdrawals',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    minimize: false,
  },
);

// Hot lookups
WithdrawalSchema.index({ player_id: 1, state: 1, created_at: -1 }, { name: 'by_player_state' });
WithdrawalSchema.index({ state: 1, created_at: -1 }, { name: 'by_state' });
WithdrawalSchema.index(
  { tx_hash: 1 },
  { unique: true, sparse: true, name: 'uniq_tx_hash' },
);

export const Withdrawal: Model<WithdrawalDoc> =
  (mongoose.models.Withdrawal as Model<WithdrawalDoc>) ??
  mongoose.model<WithdrawalDoc>('Withdrawal', WithdrawalSchema);
