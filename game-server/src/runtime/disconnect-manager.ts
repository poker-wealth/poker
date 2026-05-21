/**
 * Disconnect / reconnect rules (spec §6.4).
 *
 *   - On disconnect the player's action timer PAUSES (does not keep counting).
 *   - 20-second reconnect grace window.
 *   - Per-hand cumulative pause cap: 60 seconds total across all of a player's
 *     disconnects in one hand (stops staggered-disconnect stalling).
 *   - Per-hour cap: max 3 disconnects per player per rolling hour. Beyond that,
 *     a disconnect AUTO-FOLDS immediately instead of pausing (anti-abuse —
 *     prevents malicious observation of chat / stalling).
 *
 * Pure logic with an injected clock so it's fully testable without timers.
 */

export interface DisconnectManagerOptions {
  graceMs?: number;
  perHandCapMs?: number;
  perHourLimit?: number;
  /** Injected clock (ms epoch). Defaults to Date.now. */
  clock?: () => number;
}

export type DisconnectOutcome = 'PAUSED' | 'AUTO_FOLD';

interface PlayerHandState {
  /** Cumulative paused ms already consumed this hand (from prior reconnects). */
  consumedMs: number;
  /** When the current pause started, or null if connected. */
  pausedAt: number | null;
}

export class DisconnectManager {
  private readonly graceMs: number;
  private readonly perHandCapMs: number;
  private readonly perHourLimit: number;
  private readonly clock: () => number;

  /** playerId → disconnect timestamps within the rolling hour. */
  private readonly disconnectTimes = new Map<string, number[]>();
  /** `${handId}:${playerId}` → pause accounting for this hand. */
  private readonly handState = new Map<string, PlayerHandState>();

  constructor(opts: DisconnectManagerOptions = {}) {
    this.graceMs = opts.graceMs ?? 20_000;
    this.perHandCapMs = opts.perHandCapMs ?? 60_000;
    this.perHourLimit = opts.perHourLimit ?? 3;
    this.clock = opts.clock ?? Date.now;
  }

  private key(handId: string, playerId: string): string {
    return `${handId}:${playerId}`;
  }

  /**
   * Record a disconnect. Returns PAUSED (grace timer running) or AUTO_FOLD
   * (per-hour limit exceeded, or per-hand pause budget already exhausted).
   */
  onDisconnect(handId: string, playerId: string): DisconnectOutcome {
    const now = this.clock();

    // Rolling-hour disconnect count.
    const times = (this.disconnectTimes.get(playerId) ?? []).filter((t) => now - t < 3_600_000);
    times.push(now);
    this.disconnectTimes.set(playerId, times);
    if (times.length > this.perHourLimit) {
      return 'AUTO_FOLD';
    }

    const k = this.key(handId, playerId);
    const state = this.handState.get(k) ?? { consumedMs: 0, pausedAt: null };
    if (state.consumedMs >= this.perHandCapMs) {
      this.handState.set(k, state);
      return 'AUTO_FOLD';
    }
    state.pausedAt = now;
    this.handState.set(k, state);
    return 'PAUSED';
  }

  /** Record a reconnect; accrues the elapsed pause toward the per-hand cap. */
  onReconnect(handId: string, playerId: string): { resumed: boolean } {
    const k = this.key(handId, playerId);
    const state = this.handState.get(k);
    if (!state || state.pausedAt === null) return { resumed: false };
    const elapsed = this.clock() - state.pausedAt;
    state.consumedMs = Math.min(this.perHandCapMs, state.consumedMs + elapsed);
    state.pausedAt = null;
    this.handState.set(k, state);
    return { resumed: true };
  }

  /**
   * Should a still-disconnected player be auto-folded now? True when either the
   * 20s grace elapsed OR the per-hand 60s cumulative pause cap is reached.
   */
  shouldAutoFold(handId: string, playerId: string): boolean {
    const k = this.key(handId, playerId);
    const state = this.handState.get(k);
    if (!state || state.pausedAt === null) return false;
    const pausedFor = this.clock() - state.pausedAt;
    if (pausedFor >= this.graceMs) return true;
    if (state.consumedMs + pausedFor >= this.perHandCapMs) return true;
    return false;
  }

  /** Remaining grace ms for a currently-paused player (0 if not paused/expired). */
  remainingGraceMs(handId: string, playerId: string): number {
    const k = this.key(handId, playerId);
    const state = this.handState.get(k);
    if (!state || state.pausedAt === null) return 0;
    const pausedFor = this.clock() - state.pausedAt;
    const byGrace = this.graceMs - pausedFor;
    const byCap = this.perHandCapMs - state.consumedMs - pausedFor;
    return Math.max(0, Math.min(byGrace, byCap));
  }

  /** Clear per-hand accounting when a new hand starts. */
  resetHand(handId: string, playerIds: string[]): void {
    for (const pid of playerIds) this.handState.delete(this.key(handId, pid));
  }

  /** Disconnect count in the rolling hour (for tests / monitoring). */
  disconnectsThisHour(playerId: string): number {
    const now = this.clock();
    return (this.disconnectTimes.get(playerId) ?? []).filter((t) => now - t < 3_600_000).length;
  }
}
