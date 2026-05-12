import { logger } from '../lib/logger.js';
import { sendTgAlert } from '../lib/tg-bot.js';
import { securityEvents, type IllegalFundFlowEvent } from './security-events.js';

/**
 * CB6 — Non-whitelist fund flow (spec §3.8, "MOST IMPORTANT").
 *
 * Trigger: any attempt to route funds through a non-whitelisted path
 * (caught by ClearingRules → IllegalFundFlowError → securityEvents emission).
 *
 * Auto action:
 *   1. Reject the transfer (already done by transfer() rejecting the throw).
 *   2. Write a structured security log entry (logger.error level).
 *   3. Fire a TG Bot alert to ops within 5 seconds (M1 acceptance test).
 */

let registered = false;
let unsubscribe: (() => void) | null = null;

function handler(evt: IllegalFundFlowEvent): void {
  const { error, idempotencyKey, amount } = evt;
  logger.error(
    {
      event: 'CB6_ILLEGAL_FUND_FLOW',
      from: error.fromType ?? 'EXTERNAL',
      to: error.toType ?? 'EXTERNAL',
      ledgerType: error.ledgerType,
      idempotencyKey,
      amount: amount?.toString(),
    },
    'CB6: illegal fund flow blocked',
  );
  // Fire-and-forget; the test verifies the call was initiated within 5s.
  void sendTgAlert(
    `🚨 <b>CB6: Illegal fund flow blocked</b>\n` +
      `<code>${error.fromType ?? 'EXTERNAL'} → ${error.toType ?? 'EXTERNAL'}</code>\n` +
      `Type: <code>${error.ledgerType}</code>\n` +
      (amount !== undefined ? `Amount: <code>${amount.toString()}</code> cents\n` : '') +
      (idempotencyKey ? `Key: <code>${idempotencyKey}</code>` : ''),
  );
}

/** Idempotent: registers the CB6 handler once. Safe to call from app boot. */
export function registerCB6(): void {
  if (registered) return;
  securityEvents.on('illegal_fund_flow', handler);
  unsubscribe = () => securityEvents.off('illegal_fund_flow', handler);
  registered = true;
  logger.info('CB6 (illegal fund flow → TG alert) registered');
}

/** Unregister — used by tests to isolate. */
export function unregisterCB6(): void {
  if (!registered) return;
  unsubscribe?.();
  unsubscribe = null;
  registered = false;
}
