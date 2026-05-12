import mongoose, { type ClientSession } from 'mongoose';
import { IllegalFundFlowError, assertFlowAllowed } from '../clearing/clearing-rules.js';
import { securityEvents } from '../circuit-breakers/security-events.js';
import { PLATFORM_OWNER, validateOwnerForType } from '../domain/account-types.js';
import { logger } from '../lib/logger.js';
import { Account, type AccountDoc } from './account.model.js';
import { AccountNotFoundError, InsufficientBalanceError } from './errors.js';
import { Ledger, type LedgerDoc } from './ledger.model.js';
import type { AccountRef, TransferInput, TransferResult } from './transfer-types.js';

/**
 * transfer() — the ONLY mutator allowed to change `accounts.balance`.
 *
 * Two entry points:
 *   - transfer(input)                  : owns its session + retry loop.
 *   - applyTransfer(input, session)    : caller provides session (used by
 *                                         Settlement Engine to bundle N+5 transfers
 *                                         in one MongoDB transaction).
 *
 * Pipeline:
 *   1. ClearingRules whitelist check (throws IllegalFundFlowError).
 *   2. Owner validation per account type (TREASURY=PLATFORM, etc.).
 *   3. Decrement `from` (filter requires balance >= amount; optimistic-lock version++).
 *   4. Upsert+increment `to` (creates account on first contact; version++).
 *   5. Insert ledger entry with the unique idempotency_key.
 *   6. Idempotency: duplicate idempotency_key → IdempotentReplay → caller-side reload.
 *   7. Retry (transfer() only): TransientTransactionError / WriteConflict →
 *      exponential backoff [50ms, 100ms, 200ms]; max 3 retries (spec Pitfall 1).
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
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

function assertRefValid(ref: AccountRef, label: 'from' | 'to'): void {
  if (!ref.ownerId) throw new Error(`transfer(): ${label}.ownerId required`);
  const r = validateOwnerForType(ref.type, ref.ownerId);
  if (!r.ok) throw new Error(`transfer(): ${label} invalid — ${r.reason}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateInput(input: TransferInput): void {
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) {
    throw new Error('transfer(): amount must be a positive BigInt (cents)');
  }
  if (!input.idempotencyKey) throw new Error('transfer(): idempotencyKey required');
  try {
    assertFlowAllowed({
      fromType: input.from?.type ?? null,
      toType: input.to?.type ?? null,
      ledgerType: input.ledgerType,
    });
  } catch (err) {
    if (err instanceof IllegalFundFlowError) {
      // CB6 trigger — fire-and-forget security event before re-throwing.
      securityEvents.emit('illegal_fund_flow', {
        error: err,
        idempotencyKey: input.idempotencyKey,
        amount: input.amount,
      });
    }
    throw err;
  }
  if (input.from) assertRefValid(input.from, 'from');
  if (input.to) assertRefValid(input.to, 'to');
}

/**
 * Inner work — runs inside an existing transaction session.
 * Throws IdempotentReplay (sentinel) on duplicate idempotency_key so the caller
 * can roll back the tx and reload the existing entry.
 */
export async function applyTransfer(
  input: TransferInput,
  session: ClientSession,
): Promise<{ ledgerEntry: LedgerDoc; fromAccount: AccountDoc | null; toAccount: AccountDoc | null }> {
  validateInput(input);

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
      const exists = await Account.findOne(
        { account_type: type, owner_id: ownerId, wallet_scope: walletScope },
        { _id: 1, balance: 1 },
        { session, lean: true },
      );
      if (!exists) throw new AccountNotFoundError(input.from);
      throw new InsufficientBalanceError(exists._id, input.amount, exists.balance);
    }
  }

  let toAccount: AccountDoc | null = null;
  if (input.to) {
    const { type, ownerId, walletScope = PLATFORM_OWNER } = input.to;
    toAccount = await Account.findOneAndUpdate(
      { account_type: type, owner_id: ownerId, wallet_scope: walletScope },
      { $inc: { balance: input.amount, version: 1 } },
      { session, new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean<AccountDoc>();
  }

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

  return { ledgerEntry, fromAccount, toAccount };
}

/**
 * Public entry point — owns the session + retry loop.
 * Use this when you have a single fund movement. For settlement bundles,
 * use applyTransfer inside session.withTransaction.
 */
export async function transfer(input: TransferInput): Promise<TransferResult> {
  validateInput(input);

  let attempt = 0;
  while (true) {
    const session = await mongoose.startSession();
    const started = Date.now();
    try {
      let result: TransferResult | null = null;
      await session.withTransaction(async () => {
        const inner = await applyTransfer(input, session);
        const durationMs = Date.now() - started;
        if (durationMs > TX_DURATION_WARN_MS) {
          logger.warn(
            { idempotencyKey: input.idempotencyKey, durationMs },
            `transfer tx exceeded ${TX_DURATION_WARN_MS}ms hard limit`,
          );
        }
        result = { ...inner, durationMs, replayed: false, retries: attempt };
      });
      if (!result) throw new Error('transfer(): tx completed without producing a result');
      return result;
    } catch (err) {
      if (err instanceof IdempotentReplay) {
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

// Sentinel exported for Settlement Engine to identify idempotent-replay rollbacks.
export { IdempotentReplay };
