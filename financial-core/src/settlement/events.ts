import { EventEmitter } from 'node:events';
import type { SettleRoundReceipt } from './settlement-engine.js';

/**
 * Settlement event bus — the decoupling point between Phase 1 (synchronous,
 * strong-consistency MongoDB tx) and Phase 2 (eventual-consistency async work).
 *
 * Spec §3.5 Phase 2 work (real workers wired in later milestones):
 *   - RAKE_QUEUE Worker=5: aggregate rake to on-chain TREASURY (M2 Solana).
 *   - JACKPOT_QUEUE Worker=3: refresh denormalized jackpot snapshots / on-chain
 *     commitJackpot for Grand triggers.
 *   - settlement_receipt → Solana commitment (commitRound), background async,
 *     does NOT block Phase 1 commit.
 *
 * Spec backlog policy (M11 monitoring will enforce):
 *   - backlog > 1,000 → alert ops via TG Bot.
 *   - backlog > 5,000 → auto-scale workers.
 *
 * For M1, this is a pure in-process EventEmitter. M2+ will register listeners
 * that push to Redis/BullMQ for cross-node fanout.
 */

type SettlementEventMap = {
  /** Fired AFTER settleRound's MongoDB transaction commits successfully. */
  settled: [SettleRoundReceipt];
  /** Fired when a previously-settled round is detected on replay. */
  replayed: [SettleRoundReceipt];
};

class TypedEmitter<T extends Record<string, ReadonlyArray<unknown>>> extends EventEmitter {
  override emit<E extends keyof T & string>(event: E, ...args: T[E] extends readonly unknown[] ? T[E] : never): boolean {
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
  override once<E extends keyof T & string>(
    event: E,
    listener: T[E] extends readonly unknown[] ? (...args: T[E]) => void : never,
  ): this {
    return super.once(event, listener);
  }
}

/** Singleton event bus for settlement-related notifications. */
export const settlementEvents = new TypedEmitter<SettlementEventMap>();
// Bump default listener cap — multiple Phase 2 workers (jackpot, rake, solana,
// agent commission) will subscribe; default 10 would trigger leak warnings.
settlementEvents.setMaxListeners(32);
