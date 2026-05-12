import type { AccountType } from '../domain/account-types.js';
import type { LedgerType } from '../domain/ledger-types.js';
import { isInflowType, isOutflowType } from '../domain/ledger-types.js';

/**
 * ClearingRules — the hardcoded whitelist of permitted fund flows.
 *
 * Spec §3.3 iron rules:
 *   1. Whitelist is hardcoded in source. NOT admin-configurable.
 *   2. Fund flows ONLY on whitelisted paths.
 *   3. Any non-whitelisted flow → reject + security log + TG Bot alert (CB6).
 *
 * Changing this file requires a 2-reviewer code review + security sign-off
 * (CODEOWNERS scopes /financial-core/src/clearing/ to @fc-leads @security).
 */

/**
 * Internal flows: AccountType → set of allowed destination AccountTypes.
 * Source: spec §3.3 table, plus PLAYER → PLAYER (per §3.5 WIN_PAYOUT example,
 * not in the §3.3 summary but explicit in the settlement pseudocode).
 *
 * Notable exclusions:
 *   - TREASURY → INSURANCE: PROHIBITED (must go through multi-sig override).
 *   - JACKPOT → anything except PLAYER: PROHIBITED (out-only, no misappropriation).
 *   - Cross-league LEAGUE_INVENTORY → LEAGUE_INVENTORY: PROHIBITED.
 *   - INSURANCE → TREASURY: PROHIBITED (premium leakage prevention).
 *   - REINSURANCE → PLAYER: PROHIBITED (must route through INSURANCE).
 */
const ALLOWED_INTERNAL_FLOWS: Readonly<Record<AccountType, ReadonlySet<AccountType>>> =
  Object.freeze({
    PLAYER: new Set<AccountType>([
      'PLAYER', // WIN_PAYOUT (loser → winner)
      'TREASURY', // RAKE on platform tables
      'LEAGUE_INVENTORY', // RAKE on league tables / league-context losses
      'INSURANCE', // INSURANCE_PREMIUM
      'JACKPOT_MINI',
      'JACKPOT_MINOR',
      'JACKPOT_MAJOR',
      'JACKPOT_GRAND',
    ]),
    TREASURY: new Set<AccountType>([
      'PLAYER', // agent commission / agent VIP bonus / withdrawal pre-stage
      'REINSURANCE', // platform-funded reinsurance topup
      'LEAGUE_INVENTORY', // league purchases credits
    ]),
    INSURANCE: new Set<AccountType>([
      'PLAYER', // INSURANCE_PAYOUT
      'REINSURANCE', // backstop request
    ]),
    REINSURANCE: new Set<AccountType>([
      'INSURANCE', // backstop payout
      'TREASURY', // clawback repayment
    ]),
    LEAGUE_INVENTORY: new Set<AccountType>([
      'PLAYER', // league table winners / league wallet top-up to player
      'TREASURY', // league remittance to platform
    ]),
    JACKPOT_MINI: new Set<AccountType>(['PLAYER']),
    JACKPOT_MINOR: new Set<AccountType>(['PLAYER']),
    JACKPOT_MAJOR: new Set<AccountType>(['PLAYER']),
    JACKPOT_GRAND: new Set<AccountType>(['PLAYER']),
  });

/** Inflows (DEPOSIT, WITHDRAW_REFUND): which AccountTypes may receive external money. */
const ALLOWED_INFLOW_TARGETS: ReadonlyMap<LedgerType, ReadonlySet<AccountType>> = new Map([
  ['DEPOSIT', new Set<AccountType>(['PLAYER', 'TREASURY'])],
  ['WITHDRAW_REFUND', new Set<AccountType>(['PLAYER'])],
]);

/** Outflows (WITHDRAW): which AccountTypes may send external money. */
const ALLOWED_OUTFLOW_SOURCES: ReadonlyMap<LedgerType, ReadonlySet<AccountType>> = new Map([
  ['WITHDRAW', new Set<AccountType>(['PLAYER', 'TREASURY'])],
]);

export interface FlowDescriptor {
  fromType: AccountType | null;
  toType: AccountType | null;
  ledgerType: LedgerType;
}

export type ClearingResult =
  | { ok: true }
  | { ok: false; reason: string };

export class IllegalFundFlowError extends Error {
  public readonly fromType: AccountType | null;
  public readonly toType: AccountType | null;
  public readonly ledgerType: LedgerType;

  constructor(flow: FlowDescriptor, reason: string) {
    super(
      `IllegalFundFlow: ${flow.fromType ?? 'EXTERNAL'} -> ${flow.toType ?? 'EXTERNAL'} ` +
        `via ${flow.ledgerType} (${reason})`,
    );
    this.name = 'IllegalFundFlowError';
    this.fromType = flow.fromType;
    this.toType = flow.toType;
    this.ledgerType = flow.ledgerType;
  }
}

/**
 * Pure validation — returns ok/false; does NOT throw, log, or alert.
 * The caller (transfer()) is responsible for emitting CB6 side effects.
 */
export function checkFlow(flow: FlowDescriptor): ClearingResult {
  const { fromType, toType, ledgerType } = flow;

  // Inflows: must have a destination, must not have a source.
  if (isInflowType(ledgerType)) {
    if (fromType !== null) {
      return { ok: false, reason: `${ledgerType} is an inflow; fromType must be null` };
    }
    if (toType === null) {
      return { ok: false, reason: `${ledgerType} requires a destination AccountType` };
    }
    const allowed = ALLOWED_INFLOW_TARGETS.get(ledgerType);
    if (!allowed || !allowed.has(toType)) {
      return {
        ok: false,
        reason: `${ledgerType} cannot target ${toType} (allowed: ${
          allowed ? [...allowed].join(', ') : 'none'
        })`,
      };
    }
    return { ok: true };
  }

  // Outflows: must have a source, must not have a destination.
  if (isOutflowType(ledgerType)) {
    if (toType !== null) {
      return { ok: false, reason: `${ledgerType} is an outflow; toType must be null` };
    }
    if (fromType === null) {
      return { ok: false, reason: `${ledgerType} requires a source AccountType` };
    }
    const allowed = ALLOWED_OUTFLOW_SOURCES.get(ledgerType);
    if (!allowed || !allowed.has(fromType)) {
      return {
        ok: false,
        reason: `${ledgerType} cannot originate from ${fromType} (allowed: ${
          allowed ? [...allowed].join(', ') : 'none'
        })`,
      };
    }
    return { ok: true };
  }

  // Internal flows: both sides required, whitelist by from-type.
  if (fromType === null || toType === null) {
    return { ok: false, reason: `${ledgerType} is an internal flow; both endpoints required` };
  }
  const allowedDestinations = ALLOWED_INTERNAL_FLOWS[fromType];
  if (!allowedDestinations.has(toType)) {
    return {
      ok: false,
      reason: `${fromType} -> ${toType} is not on the whitelist (allowed from ${fromType}: ${
        [...allowedDestinations].join(', ') || 'none'
      })`,
    };
  }
  return { ok: true };
}

/** Throws IllegalFundFlowError if the flow is not whitelisted. Convenience wrapper. */
export function assertFlowAllowed(flow: FlowDescriptor): void {
  const result = checkFlow(flow);
  if (!result.ok) throw new IllegalFundFlowError(flow, result.reason);
}

/** Test-only read-only view of the internal whitelist. */
export const __WHITELIST_FOR_TESTS = Object.freeze({
  INTERNAL: ALLOWED_INTERNAL_FLOWS,
  INFLOW: ALLOWED_INFLOW_TARGETS,
  OUTFLOW: ALLOWED_OUTFLOW_SOURCES,
});
