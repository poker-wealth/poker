import { EventEmitter } from 'node:events';
import type { IllegalFundFlowError } from '../clearing/clearing-rules.js';

/**
 * Security event bus — feeds Circuit Breakers and audit log.
 *
 * Spec §3.8: certain events trigger automatic responses (CB1-CB7).
 * This emitter is the publisher; circuit-breaker handlers subscribe.
 *
 * Add new event types here as new breakers are wired (kept narrow on purpose
 * to keep the type contract honest).
 */

export interface IllegalFundFlowEvent {
  error: IllegalFundFlowError;
  /** Optional context the caller may attach. */
  idempotencyKey?: string;
  amount?: bigint;
}

type SecurityEventMap = {
  /** CB6 trigger — fund movement attempted on a non-whitelisted path. */
  illegal_fund_flow: [IllegalFundFlowEvent];
};

class TypedEmitter<T extends Record<string, ReadonlyArray<unknown>>> extends EventEmitter {
  override emit<E extends keyof T & string>(
    event: E,
    ...args: T[E] extends readonly unknown[] ? T[E] : never
  ): boolean {
    return super.emit(event, ...args);
  }
  override on<E extends keyof T & string>(
    event: E,
    listener: T[E] extends readonly unknown[] ? (...args: T[E]) => void : never,
  ): this {
    return super.on(event, listener);
  }
  override off<E extends keyof T & string>(
    event: E,
    listener: T[E] extends readonly unknown[] ? (...args: T[E]) => void : never,
  ): this {
    return super.off(event, listener);
  }
}

export const securityEvents = new TypedEmitter<SecurityEventMap>();
securityEvents.setMaxListeners(32);
