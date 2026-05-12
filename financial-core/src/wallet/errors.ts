import type { AccountRef } from './transfer-types.js';

export class InsufficientBalanceError extends Error {
  public readonly accountId: string;
  public readonly requested: bigint;
  public readonly available: bigint;
  constructor(accountId: string, requested: bigint, available: bigint) {
    super(
      `InsufficientBalance: account ${accountId} has ${available} cents, requested ${requested}`,
    );
    this.name = 'InsufficientBalanceError';
    this.accountId = accountId;
    this.requested = requested;
    this.available = available;
  }
}

export class AccountNotFoundError extends Error {
  public readonly ref: AccountRef;
  constructor(ref: AccountRef) {
    super(
      `AccountNotFound: ${ref.type}/${ref.ownerId}/${ref.walletScope ?? 'PLATFORM'}`,
    );
    this.name = 'AccountNotFoundError';
    this.ref = ref;
  }
}

export class TransferTimeoutError extends Error {
  public readonly attempts: number;
  constructor(attempts: number) {
    super(`Transfer exhausted retries after ${attempts} attempts on TransientTransactionError`);
    this.name = 'TransferTimeoutError';
    this.attempts = attempts;
  }
}
