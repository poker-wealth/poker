import { type Card, cardId } from '../../cards/card.js';
import { freshDeck, shuffleDeck } from '../../cards/deck.js';
import { evaluateBestFive } from '../../cards/hand-eval.js';
import {
  BaseGame,
  type ApplyActionResult,
  type BaseGameConfig,
  type GameAction,
  type GameType,
} from '../../state-machine/base-game.js';
import { StateMachine } from '../../state-machine/state-machine.js';
import { TurnManager } from '../../state-machine/turn-manager.js';
import { awardPots, computePots, type PlayerChips } from './betting.js';
import { dealHoldem } from './deal.js';

/**
 * Texas Hold'em engine (spec §7 BaseGame). Plays a full hand:
 * blinds → deal → 4 betting streets → showdown → settlement plan.
 *
 * Chips are in-memory table stacks (the buy-in model). The engine conserves
 * chips perfectly — sum of all stacks + pot is invariant. Rake and jackpot
 * are NOT applied here; they're computed by the settlement adapter from the
 * HandResult and pushed to the Financial Core. Keeping them out keeps the
 * engine a clean, verifiable poker machine.
 */

export type TexasState =
  | 'WAITING'
  | 'PRE_FLOP'
  | 'FLOP'
  | 'TURN'
  | 'RIVER'
  | 'SHOWDOWN'
  | 'SETTLED';

export interface TexasPlayer {
  playerId: string;
  seat: number;
  stack: bigint;
  holeCards: Card[];
  /** Total committed this hand (all streets). */
  committed: bigint;
  /** Committed on the current street (resets each street). */
  streetCommitted: bigint;
  folded: boolean;
  allIn: boolean;
  /** Acted since the last aggressive action on this street. */
  hasActed: boolean;
}

export interface TexasConfig extends BaseGameConfig {
  smallBlind: bigint;
  bigBlind: bigint;
}

export interface HandResultPlayer {
  playerId: string;
  startStack: bigint;
  endStack: bigint;
  net: bigint; // endStack - startStack
  committed: bigint;
  folded: boolean;
  bestHand?: string; // category name, present if reached showdown
}

export interface HandResult {
  roundId: string;
  tableId: string;
  board: string[];
  winners: string[];
  potAwards: Array<{ amount: bigint; winners: string[] }>;
  players: HandResultPlayer[];
  /** total chips that were in the pot. */
  potTotal: bigint;
}

export interface StartHandInput {
  roundId: string;
  /** 32-byte provably-fair final seed; the deck is shuffled from it. */
  finalSeed: Uint8Array;
}

const TEXAS_TRANSITIONS: Readonly<Record<TexasState, readonly TexasState[]>> = {
  WAITING: ['PRE_FLOP'],
  PRE_FLOP: ['FLOP', 'SHOWDOWN'],
  FLOP: ['TURN', 'SHOWDOWN'],
  TURN: ['RIVER', 'SHOWDOWN'],
  RIVER: ['SHOWDOWN'],
  SHOWDOWN: ['SETTLED'],
  SETTLED: ['WAITING'],
};

export class TexasHoldem extends BaseGame<unknown, unknown> {
  readonly gameType: GameType = 'TEXAS_HOLDEM';
  override readonly config: TexasConfig;

  private readonly sm: StateMachine<TexasState>;
  private readonly turns: TurnManager;
  private readonly players = new Map<string, TexasPlayer>();
  private board: Card[] = [];
  private deck: Card[] = [];
  private currentBet = 0n;
  private minRaise = 0n;
  private roundId = '';
  private startStacks = new Map<string, bigint>();
  private result: HandResult | null = null;

  constructor(config: TexasConfig) {
    super(config);
    this.config = config;
    this.turns = new TurnManager(config.maxPlayers);
    this.sm = new StateMachine<TexasState>({
      initial: 'WAITING',
      transitions: TEXAS_TRANSITIONS,
      onTransition: (from, to) => this.events.emit('state_changed', { from, to }),
    });
  }

  get state(): TexasState {
    return this.sm.current;
  }

  override get playerCount(): number {
    return this.players.size;
  }

  override join(playerId: string, seatIndex?: number): number {
    if (this.sm.current !== 'WAITING' && this.sm.current !== 'SETTLED') {
      throw new Error('join: cannot join mid-hand');
    }
    const seat = seatIndex ?? this.firstFreeSeat();
    this.turns.seat(playerId, seat);
    this.players.set(playerId, {
      playerId,
      seat,
      stack: 0n,
      holeCards: [],
      committed: 0n,
      streetCommitted: 0n,
      folded: false,
      allIn: false,
      hasActed: false,
    });
    this.events.emit('player_joined', { playerId, seat });
    return seat;
  }

  override leave(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    this.turns.unseat(p.seat);
    this.players.delete(playerId);
    this.events.emit('player_left', { playerId, seat: p.seat });
  }

  /** Buy in: add chips to a seated player's table stack (FC moved real funds upstream). */
  buyIn(playerId: string, amount: bigint): void {
    const p = this.requirePlayer(playerId);
    if (amount <= 0n) throw new Error('buyIn: amount must be > 0');
    p.stack += amount;
  }

  override canStart(): boolean {
    const funded = [...this.players.values()].filter((p) => p.stack > 0n);
    return (
      (this.sm.current === 'WAITING' || this.sm.current === 'SETTLED') &&
      funded.length >= this.config.minPlayers
    );
  }

  /** Begin a hand: rotate button, post blinds, deal, open preflop betting. */
  startHand(input: StartHandInput): void {
    if (!this.canStart()) throw new Error('startHand: cannot start (need funded players / wrong state)');
    if (this.sm.current === 'SETTLED') this.sm.transition('WAITING');

    this.roundId = input.roundId;
    this.result = null;
    this.board = [];
    this.currentBet = 0n;
    this.minRaise = this.config.bigBlind;
    this.turns.resetActivity();

    // Reset per-hand player state, drop unfunded players from the deal.
    const dealt = [...this.players.values()].filter((p) => p.stack > 0n).sort((a, b) => a.seat - b.seat);
    for (const p of this.players.values()) {
      p.holeCards = [];
      p.committed = 0n;
      p.streetCommitted = 0n;
      p.folded = p.stack <= 0n; // unfunded sit out
      p.allIn = false;
      p.hasActed = false;
    }
    this.startStacks = new Map(dealt.map((p) => [p.playerId, p.stack]));

    this.turns.advanceButton();

    // Deal from the provably-fair shuffled deck.
    this.deck = shuffleDeck(freshDeck(), input.finalSeed);
    const deal = dealHoldem(this.deck, dealt.length);
    dealt.forEach((p, i) => {
      p.holeCards = deal.holeCards[i]!;
    });

    // Post blinds.
    const { smallBlind, bigBlind, firstToActPreflop } = this.turns.blindPositions();
    this.postBlind(this.turns.playerAt(smallBlind)!, this.config.smallBlind);
    this.postBlind(this.turns.playerAt(bigBlind)!, this.config.bigBlind);
    this.currentBet = this.config.bigBlind;
    this.minRaise = this.config.bigBlind;

    this.sm.transition('PRE_FLOP');
    // First to act preflop; BB still has the option (hasActed=false for all).
    this.turns.setActor(firstToActPreflop);
    this.events.emit('hand_started', { roundId: this.roundId, serverCommit: '' });
    this.emitTurn();
  }

  override applyAction(playerId: string, action: GameAction): ApplyActionResult {
    if (!['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(this.sm.current)) {
      return { ok: false, error: 'not in a betting round' };
    }
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: 'unknown player' };
    if (this.turns.currentActorPlayer !== playerId) return { ok: false, error: 'not your turn' };
    if (p.folded || p.allIn) return { ok: false, error: 'cannot act (folded or all-in)' };

    const toCall = this.currentBet - p.streetCommitted;

    switch (action.type) {
      case 'fold':
        p.folded = true;
        p.hasActed = true;
        this.turns.setInactive(p.seat);
        break;

      case 'check':
        if (toCall !== 0n) return { ok: false, error: 'cannot check facing a bet' };
        p.hasActed = true;
        break;

      case 'call': {
        if (toCall === 0n) return { ok: false, error: 'nothing to call — use check' };
        const pay = toCall <= p.stack ? toCall : p.stack;
        this.commit(p, pay);
        p.hasActed = true;
        break;
      }

      case 'bet':
      case 'raise': {
        const target = this.parseAmount(action);
        if (target === null) return { ok: false, error: 'bet/raise requires a numeric amount' };
        // `target` is the total streetCommitted the player wants to reach.
        if (target <= p.streetCommitted) return { ok: false, error: 'raise amount must increase your commitment' };
        const additional = target - p.streetCommitted;
        const isAllIn = additional >= p.stack;
        const raiseSize = target - this.currentBet;
        if (!isAllIn && target < this.currentBet + this.minRaise) {
          return { ok: false, error: `raise must reach at least ${this.currentBet + this.minRaise}` };
        }
        const pay = isAllIn ? p.stack : additional;
        this.commit(p, pay);
        if (target > this.currentBet) {
          // Aggressive action: re-open the round; everyone else must respond.
          if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
          this.currentBet = p.streetCommitted;
          for (const other of this.players.values()) {
            if (!other.folded && !other.allIn && other.playerId !== p.playerId) other.hasActed = false;
          }
        }
        p.hasActed = true;
        break;
      }

      default:
        return { ok: false, error: `unknown action ${action.type}` };
    }

    this.events.emit('action_applied', { playerId, action: action.type, payload: action.payload ?? null });
    this.advance();
    return { ok: true };
  }

  // ── internal flow ────────────────────────────────────────────────

  private advance(): void {
    // Hand ends immediately if only one non-folded player remains.
    const live = [...this.players.values()].filter((p) => !p.folded);
    if (live.length === 1) {
      this.gotoShowdown();
      return;
    }

    if (this.isBettingRoundComplete()) {
      this.nextStreetOrShowdown();
      return;
    }
    // Otherwise pass action to the next eligible seat.
    const next = this.turns.advanceActor();
    if (next === null) {
      this.nextStreetOrShowdown();
    } else {
      this.emitTurn();
    }
  }

  private isBettingRoundComplete(): boolean {
    const contesting = [...this.players.values()].filter((p) => !p.folded && !p.allIn);
    if (contesting.length === 0) return true; // everyone all-in or folded
    return contesting.every((p) => p.hasActed && p.streetCommitted === this.currentBet);
  }

  private nextStreetOrShowdown(): void {
    switch (this.sm.current) {
      case 'PRE_FLOP':
        this.dealBoard(3);
        this.openStreet('FLOP');
        break;
      case 'FLOP':
        this.dealBoard(1);
        this.openStreet('TURN');
        break;
      case 'TURN':
        this.dealBoard(1);
        this.openStreet('RIVER');
        break;
      case 'RIVER':
        this.gotoShowdown();
        break;
      default:
        throw new Error(`nextStreetOrShowdown: unexpected state ${this.sm.current}`);
    }
  }

  private openStreet(to: TexasState): void {
    this.sm.transition(to);
    this.currentBet = 0n;
    this.minRaise = this.config.bigBlind;
    for (const p of this.players.values()) {
      p.streetCommitted = 0n;
      if (!p.folded && !p.allIn) p.hasActed = false;
    }
    // If ≤1 player can still act, skip betting and run it out.
    const canAct = [...this.players.values()].filter((p) => !p.folded && !p.allIn);
    if (canAct.length <= 1) {
      this.nextStreetOrShowdown();
      return;
    }
    const first = this.turns.firstToActPostflop();
    this.turns.setActor(first);
    this.emitTurn();
  }

  private dealBoard(n: number): void {
    // Board cards come after the hole cards in deal order. We already dealt via
    // dealHoldem at hand start, so re-derive board positions from the deck.
    const dealt = this.startStacks.size;
    const base = dealt * 2;
    const start = base + this.board.length;
    for (let i = 0; i < n; i++) {
      this.board.push(this.deck[start + i]!);
    }
  }

  private gotoShowdown(): void {
    if (this.sm.current !== 'SHOWDOWN') this.sm.transition('SHOWDOWN');
    this.runShowdown();
    this.sm.transition('SETTLED');
  }

  private runShowdown(): void {
    const contributors: PlayerChips[] = [...this.players.values()]
      .filter((p) => p.committed > 0n)
      .map((p) => ({ playerId: p.playerId, committed: p.committed, folded: p.folded }));
    const pots = computePots(contributors);

    const live = [...this.players.values()].filter((p) => !p.folded);
    const strengths = new Map<string, number>();
    const bestNames = new Map<string, string>();

    if (live.length === 1) {
      // Uncontested — single live player wins everything regardless of cards.
      strengths.set(live[0]!.playerId, Number.MAX_SAFE_INTEGER);
    } else {
      // Need full board for evaluation; if the hand ended early (all-in) the
      // board may be short — deal remaining community cards.
      while (this.board.length < 5) this.dealBoard(1);
      for (const p of live) {
        const r = evaluateBestFive([...p.holeCards, ...this.board]);
        strengths.set(p.playerId, r.rank);
        bestNames.set(p.playerId, r.categoryName);
      }
    }

    const seatOrder = this.turns.occupiedSeats.map((s) => s.playerId);
    const { payouts, potAwards } = awardPots(pots, strengths, seatOrder);

    // Credit winnings to stacks.
    for (const [pid, won] of payouts) {
      const p = this.players.get(pid);
      if (p) p.stack += won;
    }

    const winners = [...payouts.keys()];
    this.result = {
      roundId: this.roundId,
      tableId: this.config.tableId,
      board: this.board.map(cardId),
      winners,
      potAwards: potAwards.map((a) => ({ amount: a.amount, winners: a.winners })),
      potTotal: contributors.reduce((s, c) => s + c.committed, 0n),
      players: [...this.startStacks.entries()].map(([pid, startStack]) => {
        const p = this.players.get(pid)!;
        const base: HandResultPlayer = {
          playerId: pid,
          startStack,
          endStack: p.stack,
          net: p.stack - startStack,
          committed: p.committed,
          folded: p.folded,
        };
        const name = bestNames.get(pid);
        return name ? { ...base, bestHand: name } : base;
      }),
    };

    this.events.emit('hand_settled', { roundId: this.roundId, winners });
  }

  // ── helpers ──────────────────────────────────────────────────────

  private postBlind(playerId: string, amount: bigint): void {
    const p = this.requirePlayer(playerId);
    const pay = amount <= p.stack ? amount : p.stack;
    this.commit(p, pay);
    // Blinds don't count as "acted" — players still get to act.
    p.hasActed = false;
  }

  private commit(p: TexasPlayer, amount: bigint): void {
    if (amount < 0n) throw new Error('commit: negative');
    const pay = amount <= p.stack ? amount : p.stack;
    p.stack -= pay;
    p.committed += pay;
    p.streetCommitted += pay;
    if (p.stack === 0n) {
      p.allIn = true;
      this.turns.setInactive(p.seat);
    }
  }

  private parseAmount(action: GameAction): bigint | null {
    const raw = action.payload?.['amount'];
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.floor(raw));
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
    return null;
  }

  private requirePlayer(playerId: string): TexasPlayer {
    const p = this.players.get(playerId);
    if (!p) throw new Error(`player not at table: ${playerId}`);
    return p;
  }

  private firstFreeSeat(): number {
    for (let i = 0; i < this.config.maxPlayers; i++) {
      if (this.turns.playerAt(i) === null) return i;
    }
    throw new Error('table full');
  }

  private emitTurn(): void {
    this.events.emit('turn_changed', {
      playerId: this.turns.currentActorPlayer,
      seat: this.turns.currentActorSeat,
    });
  }

  // ── views ────────────────────────────────────────────────────────

  override getPublicState(): unknown {
    return {
      tableId: this.config.tableId,
      state: this.sm.current,
      board: this.board.map(cardId),
      pot: [...this.players.values()].reduce((s, p) => s + p.committed, 0n).toString(),
      currentBet: this.currentBet.toString(),
      actor: this.turns.currentActorPlayer,
      button: this.turns.button,
      players: this.turns.occupiedSeats.map((s) => {
        const p = this.players.get(s.playerId)!;
        return {
          playerId: p.playerId,
          seat: p.seat,
          stack: p.stack.toString(),
          committed: p.committed.toString(),
          streetCommitted: p.streetCommitted.toString(),
          folded: p.folded,
          allIn: p.allIn,
        };
      }),
    };
  }

  override getPrivateView(playerId: string): unknown {
    const pub = this.getPublicState() as Record<string, unknown>;
    const p = this.players.get(playerId);
    return { ...pub, holeCards: p ? p.holeCards.map(cardId) : [] };
  }

  /** The settlement plan, available once the hand reaches SETTLED. */
  getHandResult(): HandResult | null {
    return this.result;
  }
}
