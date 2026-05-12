import mongoose, { Schema, type Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import {
  LEDGER_STATUSES,
  LEDGER_TYPES,
  isInflowType,
  isOutflowType,
  type LedgerStatus,
  type LedgerType,
} from '../domain/ledger-types.js';

/**
 * `ledger` collection — append-only single source of truth for every fund movement.
 *
 * Iron rules from spec §3.2:
 *   - Every balance change has a ledger entry.
 *   - amount > 0 (direction expressed by from/to, never by sign).
 *   - idempotency_key is UNIQUE — duplicate writes return the original entry.
 *   - VIP effective volume, agent commission, audits all read from ledger.
 *
 * Boundary entries (DEPOSIT / WITHDRAW / WITHDRAW_REFUND) cross the platform
 * edge. For these one of from_account/to_account is null; the on-chain side is
 * recorded in metadata.tx_hash.
 */
export interface LedgerDoc {
  _id: string; // UUID v7
  from_account: string | null; // accounts._id, null for inflows
  to_account: string | null; // accounts._id, null for outflows
  amount: bigint; // cents, always > 0
  type: LedgerType;
  idempotency_key: string;
  status: LedgerStatus;
  metadata: Record<string, unknown>; // round_id, tx_hash, table_id, etc.
  created_at: Date;
  updated_at: Date;
}

const LedgerSchema = new Schema<LedgerDoc>(
  {
    _id: { type: String, default: () => uuidv7() },

    from_account: { type: String, default: null, immutable: true },
    to_account: { type: String, default: null, immutable: true },

    amount: {
      type: BigInt,
      required: true,
      immutable: true,
      validate: {
        validator: (v: bigint) => typeof v === 'bigint' && v > 0n,
        message: 'amount must be a positive BigInt (cents); direction is encoded by from/to',
      },
    },

    type: {
      type: String,
      enum: { values: [...LEDGER_TYPES], message: 'invalid ledger type: {VALUE}' },
      required: true,
      immutable: true,
    },

    idempotency_key: {
      type: String,
      required: true,
      immutable: true,
      trim: true,
      minlength: 1,
    },

    status: {
      type: String,
      enum: { values: [...LEDGER_STATUSES], message: 'invalid ledger status: {VALUE}' },
      required: true,
      default: 'PENDING',
    },

    metadata: {
      type: Schema.Types.Mixed,
      required: true,
      default: () => ({}),
    },
  },
  {
    collection: 'ledger',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    minimize: false,
  },
);

// Direction validation: inflow types (DEPOSIT / WITHDRAW_REFUND) only have a
// destination; outflow types (WITHDRAW) only have a source; everything else
// requires both endpoints.
LedgerSchema.pre('validate', function (next) {
  if (!LEDGER_TYPES.includes(this.type)) return next();

  if (isInflowType(this.type)) {
    if (this.from_account !== null) {
      return next(new Error(`${this.type} must have from_account=null (boundary inflow)`));
    }
    if (!this.to_account) {
      return next(new Error(`${this.type} requires to_account`));
    }
  } else if (isOutflowType(this.type)) {
    if (this.to_account !== null) {
      return next(new Error(`${this.type} must have to_account=null (boundary outflow)`));
    }
    if (!this.from_account) {
      return next(new Error(`${this.type} requires from_account`));
    }
  } else {
    if (!this.from_account || !this.to_account) {
      return next(new Error(`${this.type} requires both from_account and to_account`));
    }
    if (this.from_account === this.to_account) {
      return next(new Error('from_account and to_account must differ'));
    }
  }

  next();
});

// idempotency_key is the de-dup primary signal. Unique index enforces the
// "duplicate request returns already-processed" guarantee.
LedgerSchema.index(
  { idempotency_key: 1 },
  { unique: true, name: 'uniq_idempotency_key' },
);

// Hot read paths used by reconciliation, agent commission distribution,
// and VIP effective-volume aggregation.
LedgerSchema.index({ from_account: 1, created_at: -1 }, { name: 'by_from_account' });
LedgerSchema.index({ to_account: 1, created_at: -1 }, { name: 'by_to_account' });
LedgerSchema.index({ type: 1, created_at: -1 }, { name: 'by_type' });

// All ledger entries for a given settlement round (round_id is in metadata).
LedgerSchema.index(
  { 'metadata.round_id': 1 },
  { name: 'by_round_id', sparse: true },
);

export const Ledger: Model<LedgerDoc> =
  (mongoose.models.Ledger as Model<LedgerDoc>) ??
  mongoose.model<LedgerDoc>('Ledger', LedgerSchema);
