import mongoose, { Schema, type Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import {
  ACCOUNT_TYPES,
  type AccountType,
  PLATFORM_OWNER,
  validateOwnerForType,
} from '../domain/account-types.js';

/**
 * `accounts` collection — one document per (account_type, owner_id, wallet_scope).
 *
 * Iron rule from spec §3.2:
 *   `UPDATE accounts SET balance = balance - 100 WHERE id = ...` is PROHIBITED.
 *   All balance changes happen inside transfer() with optimistic-lock + ledger write
 *   in a single ≤50ms MongoDB transaction.
 */
export interface AccountDoc {
  _id: string; // UUID v7 string
  account_type: AccountType;
  owner_id: string;
  wallet_scope: string;
  balance: bigint; // cents, never negative
  version: number; // optimistic-lock counter, incremented by transfer()
  created_at: Date;
  updated_at: Date;
}

const AccountSchema = new Schema<AccountDoc>(
  {
    _id: { type: String, default: () => uuidv7() },

    account_type: {
      type: String,
      enum: { values: [...ACCOUNT_TYPES], message: 'invalid account_type: {VALUE}' },
      required: true,
      immutable: true,
    },

    owner_id: { type: String, required: true, immutable: true, trim: true },

    wallet_scope: {
      type: String,
      required: true,
      default: PLATFORM_OWNER,
      immutable: true,
      trim: true,
    },

    balance: {
      type: BigInt,
      required: true,
      default: () => 0n,
      validate: {
        validator: (v: bigint) => typeof v === 'bigint' && v >= 0n,
        message: 'balance must be a non-negative BigInt (cents)',
      },
    },

    version: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: 'version must be an integer',
      },
    },
  },
  {
    collection: 'accounts',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false, // we manage `version` manually for optimistic-lock semantics
    minimize: false,
    optimisticConcurrency: false,
  },
);

// Cross-field validation: owner_id shape must match account_type rules.
// If account_type itself is invalid, defer to the field-level enum validator.
AccountSchema.pre('validate', function (next) {
  if (!ACCOUNT_TYPES.includes(this.account_type)) return next();
  const result = validateOwnerForType(this.account_type, this.owner_id);
  if (!result.ok) return next(new Error(`account validation failed: ${result.reason}`));
  next();
});

// Unique natural key — one account per (type, owner, scope). Compound is the
// hot lookup path used by transfer() and by the rake-routing Settlement Domain.
AccountSchema.index(
  { account_type: 1, owner_id: 1, wallet_scope: 1 },
  { unique: true, name: 'uniq_account_natural_key' },
);

// Reverse lookup: every account a given owner holds (e.g., all wallets for player X).
AccountSchema.index({ owner_id: 1, account_type: 1 }, { name: 'by_owner' });

export const Account: Model<AccountDoc> =
  (mongoose.models.Account as Model<AccountDoc>) ??
  mongoose.model<AccountDoc>('Account', AccountSchema);
