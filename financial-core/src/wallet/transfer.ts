import mongoose from 'mongoose';
import { assertFlowAllowed } from '../clearing/clearing-rules.js';
import { PLATFORM_OWNER, validateOwnerForType } from '../domain/account-types.js';
import { logger } from '../lib/logger.js';
import { Account, type AccountDoc } from './account.model.js';
import { AccountNotFoundError, InsufficientBalanceError } from './errors.js';
import { Ledger, type LedgerDoc } from './ledger.model.js';
import type { AccountRef, TransferInput, TransferResult } from './transfer-types.js';

/**
 * transfer() — the ONLY mutator allowed to change `accounts.balance`.
 *
 * Pipeline:
 *   1. ClearingRules whitelist check (throws IllegalFundFlowError on violation).
 *   2. Owner validation per account type (TREASURY=PLATFORM, etc.).
 *   3. Atomic MongoDB session:
 *        a. Decrement `from` (filter requires balance >= amount; optimistic-lock version++).
 *        b. Upsert+increment `to` (creates account on first contact; version++).
 *        c. Insert ledger entry with the unique idempotency_key.
 *   4. Idempotency: duplicate idempotency_key on ledger insert rolls back the tx
 *      atomically and the caller receives the original entry with `replayed: true`.
 *   5. Retry: TransientTransactionError / WriteConflict → exponential backoff
 *      [50ms, 100ms, 200ms]; max 3 retries, then alert ops (spec Pitfall 1).
 */

const RETRY_DELAYS_MS: readonly number[] = [50, 100, 200];
const TX_DURATION_WARN_MS = 50;

class IdempotentReplay extends Error {
  constructor(public readonly idempotencyKey: string) {
    super('IdempotentReplay');
    this.name = 'IdempotentReplay';
  }
}

function isTransientTxError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { hasErrorLabel?: (l: string) => boolean; codeName?: string; code?: number };
  if (typeof e.hasErrorLabel === 'function' && e.hasErrorLabel('TransientTransactionError')) {
    return true;
  }
  return e.codeName === 'WriteConflict' || e.code === 112;
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: number }).code === 11000
  );
}

function assertRefValid(ref: AccountRef, label: 'from' | 'to'): void {
  if (!ref.ownerId) throw new Error(`transfer(): ${label}.ownerId required`);
  const r = validateOwnerForType(ref.type, ref.ownerId);
  if (!r.ok) throw new Error(`transfer(): ${label} invalid — ${r.reason}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transfer(input: TransferInput): Promise<TransferResult> {
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) {
    throw new Error('transfer(): amount must be a positive BigInt (cents)');
  }
  if (!input.idempotencyKey) throw new Error('transfer(): idempotencyKey required');

  // 1. ClearingRules whitelist — throws IllegalFundFlowError on violation.
  assertFlowAllowed({
    fromType: input.from?.type ?? null,
    toType: input.to?.type ?? null,
    ledgerType: input.ledgerType,
  });

  // 2. Per-type owner shape validation.
  if (input.from) assertRefValid(input.from, 'from');
  if (input.to) assertRefValid(input.to, 'to');

  // 3. Atomic transaction with retry on transient conflict.
  let attempt = 0;
  while (true) {
    const session = await mongoose.startSession();
    const started = Date.now();
    try {
      let result: TransferResult | null = null;

      await session.withTransaction(async () => {
        // 3a. Decrement from-account (if internal/outflow).
        let fromAccount: AccountDoc | null = null;
        if (input.from) {
          const { type, ownerId, walletScope = PLATFORM_OWNER } = input.from;
          fromAccount = await Account.findOneAndUpdate(
            {
              account_type: type,
              owner_id: ownerId,
              wallet_scope: walletScope,
              balance: { $gte: input.amount },
            },
            { $inc: { balance: -input.amount, version: 1 } },
            { session, new: true },
          ).lean<AccountDoc>();

          if (!fromAccount) {
            // Distinguish insufficient balance from account-not-found.
            const exists = await Account.findOne(
              { account_type: type, owner_id: ownerId, wallet_scope: walletScope },
              { _id: 1, balance: 1 },
              { session, lean: true },
            );
            if (!exists) throw new AccountNotFoundError(input.from);
            throw new InsufficientBalanceError(exists._id, input.amount, exists.balance);
          }
        }

        // 3b. Upsert+increment to-account (if internal/inflow).
        let toAccount: AccountDoc | null = null;
        if (input.to) {
          const { type, ownerId, walletScope = PLATFORM_OWNER } = input.to;
          toAccount = await Account.findOneAndUpdate(
            { account_type: type, owner_id: ownerId, wallet_scope: walletScope },
            { $inc: { balance: input.amount, version: 1 } },
            { session, new: true, upsert: true, setDefaultsOnInsert: true },
          ).lean<AccountDoc>();
        }

        // 3c. Insert ledger entry. Duplicate idempotency_key → rollback,
        // then the outer catch loads the existing entry and returns it.
        let ledgerEntry: LedgerDoc;
        try {
          const inserted = await Ledger.create(
            [
              {
                from_account: fromAccount?._id ?? null,
                to_account: toAccount?._id ?? null,
                amount: input.amount,
                type: input.ledgerType,
                idempotency_key: input.idempotencyKey,
                status: input.status ?? 'SETTLED',
                metadata: input.metadata ?? {},
              },
            ],
            { session },
          );
          ledgerEntry = inserted[0]!.toObject() as LedgerDoc;
        } catch (err) {
          if (isDuplicateKeyError(err)) throw new IdempotentReplay(input.idempotencyKey);
          throw err;
        }

        const durationMs = Date.now() - started;
        if (durationMs > TX_DURATION_WARN_MS) {
          logger.warn(
            { idempotencyKey: input.idempotencyKey, durationMs },
            `transfer tx exceeded ${TX_DURATION_WARN_MS}ms hard limit`,
          );
        }

        result = {
          ledgerEntry,
          fromAccount,
          toAccount,
          durationMs,
          replayed: false,
          retries: attempt,
        };
      });

      if (!result) throw new Error('transfer(): tx completed without producing a result');
      return result;
    } catch (err) {
      if (err instanceof IdempotentReplay) {
        // The previous successful call already moved the money. Return its entry.
        return loadReplay(err.idempotencyKey, attempt);
      }
      if (isTransientTxError(err) && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt]!;
        attempt++;
        logger.debug(
          { attempt, delay, idempotencyKey: input.idempotencyKey },
          'transient transaction error, retrying',
        );
        await sleep(delay);
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

async function loadReplay(idempotencyKey: string, retries: number): Promise<TransferResult> {
  const existing = await Ledger.findOne({ idempotency_key: idempotencyKey }).lean<LedgerDoc>();
  if (!existing) {
    throw new Error(
      `transfer(): idempotent replay for ${idempotencyKey} but no ledger entry found`,
    );
  }
  const fromAccount = existing.from_account
    ? await Account.findById(existing.from_account).lean<AccountDoc>()
    : null;
  const toAccount = existing.to_account
    ? await Account.findById(existing.to_account).lean<AccountDoc>()
    : null;
  return { ledgerEntry: existing, fromAccount, toAccount, durationMs: 0, replayed: true, retries };
}
