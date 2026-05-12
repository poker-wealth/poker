import type { AccountType } from '../domain/account-types.js';
import type { LedgerStatus, LedgerType } from '../domain/ledger-types.js';
import type { AccountDoc } from './account.model.js';
import type { LedgerDoc } from './ledger.model.js';

/** Reference to a specific account by its natural key (type + owner + scope). */
export interface AccountRef {
  type: AccountType;
  ownerId: string;
  /** Defaults to PLATFORM. Use a leagueId for league-scoped wallets. */
  walletScope?: string;
}

/**
 * Single fund-flow input. Boundary types:
 *   - DEPOSIT / WITHDRAW_REFUND: omit `from`, set `to`.
 *   - WITHDRAW: set `from`, omit `to`.
 *   - All other types: set both.
 */
export interface TransferInput {
  from?: AccountRef;
  to?: AccountRef;
  amount: bigint;
  ledgerType: LedgerType;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  /** Default SETTLED. WITHDRAW typically uses PENDING and transitions later. */
  status?: LedgerStatus;
}

export interface TransferResult {
  ledgerEntry: LedgerDoc;
  fromAccount: AccountDoc | null;
  toAccount: AccountDoc | null;
  /** Local transaction time in ms (spec hard limit: ≤50ms). */
  durationMs: number;
  /** true if a previous call already settled this idempotency_key. */
  replayed: boolean;
  /** Number of retries due to TransientTransactionError before success. */
  retries: number;
}
