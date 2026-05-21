import { EventEmitter } from 'node:events';

/**
 * Typed event bus for game events (spec §17: Socket.io with separate game /
 * chat namespaces — this is the in-process emitter the WebSocket layer
 * subscribes to and forwards to clients).
 *
 * Each game room owns one EventBus instance. Events are strongly typed via
 * the EventMap so listeners and emitters can't drift.
 */

export class TypedEventBus<T extends Record<string, ReadonlyArray<unknown>>> {
  private readonly emitter = new EventEmitter();

  constructor(maxListeners = 64) {
    this.emitter.setMaxListeners(maxListeners);
  }

  emit<E extends keyof T & string>(event: E, ...args: T[E] extends readonly unknown[] ? T[E] : never): boolean {
    return this.emitter.emit(event, ...args);
  }

  on<E extends keyof T & string>(
    event: E,
    listener: T[E] extends readonly unknown[] ? (...args: T[E]) => void : never,
  ): this {
    this.emitter.on(event, listener as unknown as (...args: unknown[]) => void);
    return this;
  }

  once<E extends keyof T & string>(
    event: E,
    listener: T[E] extends readonly unknown[] ? (...args: T[E]) => void : never,
  ): this {
    this.emitter.once(event, listener as unknown as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof T & string>(
    event: E,
    listener: T[E] extends readonly unknown[] ? (...args: T[E]) => void : never,
  ): this {
    this.emitter.off(event, listener as unknown as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  listenerCount<E extends keyof T & string>(event: E): number {
    return this.emitter.listenerCount(event);
  }
}

/**
 * Standard game-event map shared by all game rooms. Games may extend this
 * with game-specific events via declaration merging or a wider EventMap.
 */
export interface GameEventMap extends Record<string, ReadonlyArray<unknown>> {
  state_changed: [{ from: string; to: string }];
  player_joined: [{ playerId: string; seat: number }];
  player_left: [{ playerId: string; seat: number }];
  turn_changed: [{ playerId: string | null; seat: number | null }];
  action_applied: [{ playerId: string; action: string; payload: unknown }];
  hand_started: [{ roundId: string; serverCommit: string }];
  hand_settled: [{ roundId: string; winners: string[] }];
}
