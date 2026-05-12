import { logger } from '../lib/logger.js';
import { registerCB6 } from './cb6-illegal-fund-flow.js';

/**
 * Circuit Breakers (spec §3.8). Status as of M1:
 *
 *   CB1: Insurance pool level → disable insurance sales when balance < threshold.
 *        Status: STUB. Needs INSURANCE pool to actually exist (M2 Underwriting).
 *
 *   CB2: Daily payout rate → suspend insurance 24h when payouts > 15% of pool.
 *        Status: STUB. Needs CB1 infra.
 *
 *   CB3: Jackpot anomaly → freeze table's Jackpot on 3+ Mini triggers / 1h.
 *        Status: STUB. Needs jackpot trigger tracking (M5).
 *
 *   CB4: Abnormal account withdrawal → freeze account withdrawals 1h.
 *        Status: STUB. Needs per-account rate tracking (M10 Operations).
 *
 *   CB5: Platform withdrawal rate → enable throttle (5-min delay).
 *        Status: STUB. Needs aggregate withdrawal rate tracking (M10 Operations).
 *
 *   CB6: Non-whitelist fund flow → reject + log + TG alert.
 *        Status: ACTIVE. ClearingRules + securityEvents + cb6-illegal-fund-flow.ts.
 *        Acceptance test: alert fires within 5 seconds.
 *
 *   CB7: On-chain address mapping validation → abort tx + human review.
 *        Status: STUB. Needs on-chain integration (M2 TRC20 listener + M2 Solana).
 *
 * Call registerAllCircuitBreakers() once at app boot.
 */

export function registerAllCircuitBreakers(): void {
  registerCB6();
  // CB1-CB5, CB7 will register their handlers as they're implemented.
  logger.info('circuit breakers registered (active: CB6; stubbed: CB1-CB5, CB7)');
}

/** Public surface so callers can introspect status — useful for /health endpoints. */
export const CIRCUIT_BREAKER_STATUS = Object.freeze({
  CB1: 'STUB',
  CB2: 'STUB',
  CB3: 'STUB',
  CB4: 'STUB',
  CB5: 'STUB',
  CB6: 'ACTIVE',
  CB7: 'STUB',
} as const);

export type CircuitBreakerId = keyof typeof CIRCUIT_BREAKER_STATUS;
