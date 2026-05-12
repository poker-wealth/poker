/**
 * 16 LedgerTypes covering every fund-movement category in the system.
 *
 * 14 are listed verbatim in spec §3.2; AGENT_COMMISSION and AGENT_VIP_BONUS
 * come from spec §13.5 (the M8 W9 agent system). They are added now so the
 * ledger enum is stable across milestones — no schema migration when the
 * agent system lands.
 */
export const LEDGER_TYPES = [
  // External flows
  'DEPOSIT',
  'WITHDRAW',
  'WITHDRAW_REFUND',

  // Game flows
  'BET',
  'WIN_PAYOUT',
  'RAKE',

  // Insurance / reinsurance
  'INSURANCE_PREMIUM',
  'INSURANCE_PAYOUT',
  'REINSURANCE_INJECT',
  'REINSURANCE_PAYOUT',

  // Jackpot
  'JACKPOT_INJECT',
  'JACKPOT_PAYOUT',

  // League system
  'LEAGUE_TOPUP',
  'LEAGUE_CASHOUT',

  // Agent system (spec §13.5)
  'AGENT_COMMISSION',
  'AGENT_VIP_BONUS',
] as const;

export type LedgerType = (typeof LEDGER_TYPES)[number];

/** Lifecycle states for a ledger entry. */
export const LEDGER_STATUSES = ['PENDING', 'SETTLED', 'FAILED', 'ROLLED_BACK'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/**
 * LedgerTypes that originate OUTSIDE the platform (no internal `from_account`).
 * Validation: from_account must be null/absent, to_account must be set.
 */
export const INFLOW_TYPES = ['DEPOSIT', 'WITHDRAW_REFUND'] as const satisfies readonly LedgerType[];

/**
 * LedgerTypes that exit the platform (no internal `to_account`).
 * Validation: from_account must be set, to_account must be null/absent.
 */
export const OUTFLOW_TYPES = ['WITHDRAW'] as const satisfies readonly LedgerType[];

export function isInflowType(type: LedgerType): boolean {
  return (INFLOW_TYPES as readonly LedgerType[]).includes(type);
}

export function isOutflowType(type: LedgerType): boolean {
  return (OUTFLOW_TYPES as readonly LedgerType[]).includes(type);
}
