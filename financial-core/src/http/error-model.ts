import { ZodError } from 'zod';
import { IllegalFundFlowError } from '../clearing/clearing-rules.js';
import {
  InsufficientConfirmationsError,
  UnauthorizedContractError,
} from '../deposit/deposit-credit.js';
import { AccountNotFoundError, InsufficientBalanceError } from '../wallet/errors.js';
import {
  IllegalWithdrawalTransitionError,
  WithdrawalNotFoundError,
} from '../withdrawal/withdrawal-state-machine.js';

/**
 * RFC 7807 problem-details error model for the FC HTTP layer.
 * Spec docs/api-v1.md §2.
 */

export interface ProblemDetails {
  /** A URI identifier for this error type. */
  type: string;
  /** Short human-readable summary. Stable across language. */
  title: string;
  /** HTTP status code echoed in the body for convenience. */
  status: number;
  /** Specific instance details (e.g., which account / round). */
  detail?: string;
  /** Request URI for diagnostics. */
  instance?: string;
  /** Stable machine-readable code (UPPER_SNAKE). */
  code: string;
  /** Optional structured payload (BigInt-safe — values are strings). */
  extra?: Record<string, unknown>;
}

const TYPE_BASE = 'https://fairplay.app/errors/';

/**
 * Maps a thrown error to RFC 7807. Unknown errors collapse to 500.
 * Always returns the same shape so the HTTP layer can serialize uniformly.
 */
export function toProblemDetails(err: unknown, instance?: string): ProblemDetails {
  if (err instanceof IllegalFundFlowError) {
    return {
      type: TYPE_BASE + 'illegal-fund-flow',
      title: 'IllegalFundFlow',
      status: 422,
      detail: err.message,
      code: 'ILLEGAL_FUND_FLOW',
      instance,
      extra: {
        from_type: err.fromType,
        to_type: err.toType,
        ledger_type: err.ledgerType,
      },
    };
  }
  if (err instanceof InsufficientBalanceError) {
    return {
      type: TYPE_BASE + 'insufficient-balance',
      title: 'InsufficientBalance',
      status: 409,
      detail: err.message,
      code: 'INSUFFICIENT_BALANCE',
      instance,
      extra: {
        account_id: err.accountId,
        requested: err.requested.toString(),
        available: err.available.toString(),
      },
    };
  }
  if (err instanceof AccountNotFoundError) {
    return {
      type: TYPE_BASE + 'account-not-found',
      title: 'AccountNotFound',
      status: 404,
      detail: err.message,
      code: 'ACCOUNT_NOT_FOUND',
      instance,
      extra: { ref: err.ref },
    };
  }
  if (err instanceof WithdrawalNotFoundError) {
    return {
      type: TYPE_BASE + 'withdrawal-not-found',
      title: 'WithdrawalNotFound',
      status: 404,
      detail: err.message,
      code: 'WITHDRAWAL_NOT_FOUND',
      instance,
      extra: { withdrawal_id: err.withdrawalId },
    };
  }
  if (err instanceof IllegalWithdrawalTransitionError) {
    return {
      type: TYPE_BASE + 'illegal-withdrawal-transition',
      title: 'IllegalWithdrawalTransition',
      status: 409,
      detail: err.message,
      code: 'ILLEGAL_WITHDRAWAL_TRANSITION',
      instance,
      extra: {
        withdrawal_id: err.withdrawalId,
        from: err.from,
        to: err.to,
      },
    };
  }
  if (err instanceof InsufficientConfirmationsError) {
    return {
      type: TYPE_BASE + 'insufficient-confirmations',
      title: 'InsufficientConfirmations',
      status: 409,
      detail: err.message,
      code: 'INSUFFICIENT_CONFIRMATIONS',
      instance,
      extra: {
        confirmations: err.confirmations,
        required: err.required,
        tx_hash: err.txHash,
      },
    };
  }
  if (err instanceof UnauthorizedContractError) {
    return {
      type: TYPE_BASE + 'unauthorized-contract',
      title: 'UnauthorizedContract',
      status: 422,
      detail: err.message,
      code: 'UNAUTHORIZED_CONTRACT',
      instance,
      extra: { contract_address: err.contractAddress },
    };
  }
  if (err instanceof ZodError) {
    return {
      type: TYPE_BASE + 'validation-failed',
      title: 'ValidationFailed',
      status: 400,
      detail: 'Request payload failed schema validation',
      code: 'VALIDATION_FAILED',
      instance,
      extra: {
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      },
    };
  }

  // Catch-all: known Error with .message, fall back to generic.
  const message = err instanceof Error ? err.message : 'unexpected error';
  return {
    type: TYPE_BASE + 'internal',
    title: 'InternalError',
    status: 500,
    detail: message,
    code: 'INTERNAL_ERROR',
    instance,
  };
}

/**
 * BigInt-safe JSON replacer for use with `app.set('json replacer', ...)`.
 * The contract (docs/api-v1.md) says all money values are strings.
 */
export const bigIntJsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;
