import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { transfer } from '../wallet/transfer.js';
import type { TransferResult } from '../wallet/transfer-types.js';

/**
 * TRC20 deposit credit logic (spec §3.7).
 *
 * Iron rules:
 *   1. Only the official USDT contract address is accepted.
 *      Non-official → log + TG notify player + ZERO credit.
 *   2. Mempool deposits → ZERO credit. Caller passes `confirmations`; must be
 *      >= TRON_DEPOSIT_CONFIRMATIONS (default 20).
 *   3. Each tx_hash is unique — idempotency key is `deposit:${txHash}`.
 *      Replay returns the original ledger entry.
 *   4. Amounts are BigInt (USDT has 6 decimals on-chain; convert to cents
 *      before calling this function — 1 USDT = 100 cents in our accounting).
 *
 * The actual Tron node polling / websocket subscription lives in
 * `tron-listener.ts` (M1 W2+ integration). This function is the credit
 * primitive that the listener invokes once it has a confirmed deposit.
 */

export interface DepositInput {
  /** Player whose deposit address received the funds. */
  playerId: string;
  /** Cents to credit (1 USDT = 100 cents). */
  amount: bigint;
  /** Transaction hash from the Tron network. Used as idempotency key. */
  txHash: string;
  /** Tron contract that emitted the transfer. Validated against the whitelist. */
  contractAddress: string;
  /** Confirmation depth at the time of credit. Must be >= TRON_DEPOSIT_CONFIRMATIONS. */
  confirmations: number;
  /** Optional wallet scope (defaults to PLATFORM — the lobby wallet). */
  walletScope?: string;
  /** Block number where the tx was included. Captured in metadata. */
  blockNumber?: number;
  /** Sending Tron address — captured for compliance/audit only. */
  fromTronAddress?: string;
}

export class UnauthorizedContractError extends Error {
  constructor(public readonly contractAddress: string) {
    super(
      `UnauthorizedContractError: deposit from contract ${contractAddress} is not the official USDT contract`,
    );
    this.name = 'UnauthorizedContractError';
  }
}

export class InsufficientConfirmationsError extends Error {
  constructor(
    public readonly confirmations: number,
    public readonly required: number,
    public readonly txHash: string,
  ) {
    super(
      `InsufficientConfirmationsError: tx ${txHash} has ${confirmations} confirmations, need ≥ ${required}`,
    );
    this.name = 'InsufficientConfirmationsError';
  }
}

function depositKey(txHash: string): string {
  return `deposit:${txHash}`;
}

export interface CreditDepositResult extends TransferResult {
  /** Convenience: the tx hash this credit corresponded to. */
  txHash: string;
}

export async function creditDeposit(input: DepositInput): Promise<CreditDepositResult> {
  if (!input.playerId) throw new Error('creditDeposit: playerId required');
  if (!input.txHash) throw new Error('creditDeposit: txHash required');
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) {
    throw new Error('creditDeposit: amount must be a positive BigInt (cents)');
  }
  if (!input.contractAddress) throw new Error('creditDeposit: contractAddress required');
  if (!Number.isInteger(input.confirmations) || input.confirmations < 0) {
    throw new Error('creditDeposit: confirmations must be a non-negative integer');
  }

  const env = loadEnv();

  // Rule 1: official contract whitelist.
  if (input.contractAddress !== env.TRON_USDT_CONTRACT) {
    logger.error(
      {
        event: 'UNAUTHORIZED_CONTRACT_DEPOSIT',
        playerId: input.playerId,
        contractAddress: input.contractAddress,
        expected: env.TRON_USDT_CONTRACT,
        txHash: input.txHash,
        amount: input.amount.toString(),
      },
      'TRC20 deposit from non-official contract — NOT credited',
    );
    throw new UnauthorizedContractError(input.contractAddress);
  }

  // Rule 2: confirmation threshold (Mempool → 0 confirmations, never credited).
  if (input.confirmations < env.TRON_DEPOSIT_CONFIRMATIONS) {
    logger.info(
      {
        event: 'DEPOSIT_PENDING_CONFIRMATIONS',
        playerId: input.playerId,
        txHash: input.txHash,
        confirmations: input.confirmations,
        required: env.TRON_DEPOSIT_CONFIRMATIONS,
      },
      'TRC20 deposit not yet credited — awaiting confirmations',
    );
    throw new InsufficientConfirmationsError(
      input.confirmations,
      env.TRON_DEPOSIT_CONFIRMATIONS,
      input.txHash,
    );
  }

  // Rule 3+4: credit via transfer() with txHash as idempotency key.
  const result = await transfer({
    to: {
      type: 'PLAYER',
      ownerId: input.playerId,
      walletScope: input.walletScope ?? 'PLATFORM',
    },
    amount: input.amount,
    ledgerType: 'DEPOSIT',
    idempotencyKey: depositKey(input.txHash),
    status: 'SETTLED',
    metadata: {
      tx_hash: input.txHash,
      contract_address: input.contractAddress,
      confirmations: input.confirmations,
      block_number: input.blockNumber ?? null,
      from_tron_address: input.fromTronAddress ?? null,
    },
  });

  logger.info(
    {
      event: 'DEPOSIT_CREDITED',
      playerId: input.playerId,
      txHash: input.txHash,
      amount: input.amount.toString(),
      ledgerEntryId: result.ledgerEntry._id,
      replayed: result.replayed,
    },
    result.replayed ? 'TRC20 deposit credit replayed (idempotent)' : 'TRC20 deposit credited',
  );

  return { ...result, txHash: input.txHash };
}

/** Internal helper exported for tests. */
export const __DEPOSIT_INTERNAL = Object.freeze({ depositKey });
