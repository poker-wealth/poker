/**
 * TurnManager — seat order, dealer button, and whose-action-is-it for
 * turn-based games (spec §17 component).
 *
 * Poker-aware:
 *   - Seats are a fixed ring (0..N-1). Players occupy seats; empty seats and
 *     folded/all-in players are skipped when advancing action.
 *   - The dealer button rotates each hand.
 *   - Blind positions and first-to-act derive from the button.
 *
 * Generic enough for the other turn-based games (Niu Niu, Dou Di Zhu, etc.)
 * to reuse the rotation primitives.
 */

export interface Seat {
  seatIndex: number;
  playerId: string;
}

export class TurnManager {
  /** seatIndex → playerId for occupied seats. */
  private readonly seats = new Map<number, string>();
  private readonly maxSeats: number;
  private buttonSeat = 0;
  private actorSeat: number | null = null;
  /** Seats temporarily out of the action this hand (folded / all-in). */
  private readonly inactive = new Set<number>();

  constructor(maxSeats: number) {
    if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 10) {
      throw new Error('TurnManager: maxSeats must be 2..10');
    }
    this.maxSeats = maxSeats;
  }

  seat(playerId: string, seatIndex: number): void {
    if (seatIndex < 0 || seatIndex >= this.maxSeats) {
      throw new Error(`TurnManager.seat: seatIndex out of range 0..${this.maxSeats - 1}`);
    }
    if (this.seats.has(seatIndex)) throw new Error(`TurnManager.seat: seat ${seatIndex} occupied`);
    for (const [s, pid] of this.seats) {
      if (pid === playerId) throw new Error(`TurnManager.seat: player already at seat ${s}`);
    }
    this.seats.set(seatIndex, playerId);
  }

  unseat(seatIndex: number): void {
    this.seats.delete(seatIndex);
    this.inactive.delete(seatIndex);
    if (this.actorSeat === seatIndex) this.actorSeat = null;
  }

  get occupiedSeats(): Seat[] {
    return [...this.seats.entries()]
      .map(([seatIndex, playerId]) => ({ seatIndex, playerId }))
      .sort((a, b) => a.seatIndex - b.seatIndex);
  }

  get playerCount(): number {
    return this.seats.size;
  }

  playerAt(seatIndex: number): string | null {
    return this.seats.get(seatIndex) ?? null;
  }

  seatOf(playerId: string): number | null {
    for (const [s, pid] of this.seats) if (pid === playerId) return s;
    return null;
  }

  get button(): number {
    return this.buttonSeat;
  }

  /** Move the dealer button to the next occupied seat (called between hands). */
  advanceButton(): number {
    this.buttonSeat = this.nextOccupied(this.buttonSeat);
    return this.buttonSeat;
  }

  /** Mark a seat out of the action for the rest of the hand (fold / all-in). */
  setInactive(seatIndex: number): void {
    this.inactive.add(seatIndex);
  }

  /** Reset inactive set (new hand). */
  resetActivity(): void {
    this.inactive.clear();
  }

  get activeSeats(): number[] {
    return this.occupiedSeats.map((s) => s.seatIndex).filter((s) => !this.inactive.has(s));
  }

  get currentActorSeat(): number | null {
    return this.actorSeat;
  }

  get currentActorPlayer(): string | null {
    return this.actorSeat === null ? null : (this.seats.get(this.actorSeat) ?? null);
  }

  /** Set the actor to a specific seat (e.g., first-to-act for a street). */
  setActor(seatIndex: number | null): void {
    this.actorSeat = seatIndex;
  }

  /** Advance action to the next active seat after the current actor. Returns null if none. */
  advanceActor(): number | null {
    if (this.actorSeat === null) {
      const first = this.activeSeats[0];
      this.actorSeat = first ?? null;
      return this.actorSeat;
    }
    const next = this.nextActive(this.actorSeat);
    this.actorSeat = next;
    return next;
  }

  /** First active seat clockwise from `seatIndex` (exclusive). null if none active. */
  private nextActive(seatIndex: number): number | null {
    for (let i = 1; i <= this.maxSeats; i++) {
      const s = (seatIndex + i) % this.maxSeats;
      if (this.seats.has(s) && !this.inactive.has(s)) return s;
    }
    return null;
  }

  /** First occupied seat clockwise from `seatIndex` (exclusive). Wraps to itself if alone. */
  private nextOccupied(seatIndex: number): number {
    for (let i = 1; i <= this.maxSeats; i++) {
      const s = (seatIndex + i) % this.maxSeats;
      if (this.seats.has(s)) return s;
    }
    return seatIndex; // only this seat occupied
  }

  /**
   * Heads-up + multiway blind/action positions derived from the button.
   * Returns seat indices. Heads-up (2 players): button is small blind.
   */
  blindPositions(): { smallBlind: number; bigBlind: number; firstToActPreflop: number } {
    const occ = this.occupiedSeats.map((s) => s.seatIndex);
    if (occ.length < 2) throw new Error('blindPositions: need at least 2 players');
    if (occ.length === 2) {
      // Heads-up: button posts small blind, acts first preflop.
      const sb = this.buttonSeat;
      const bb = this.nextOccupied(sb);
      return { smallBlind: sb, bigBlind: bb, firstToActPreflop: sb };
    }
    const sb = this.nextOccupied(this.buttonSeat);
    const bb = this.nextOccupied(sb);
    const firstToActPreflop = this.nextOccupied(bb); // UTG
    return { smallBlind: sb, bigBlind: bb, firstToActPreflop };
  }

  /** First-to-act postflop: first active seat clockwise from the button. */
  firstToActPostflop(): number | null {
    return this.nextActive(this.buttonSeat);
  }
}
