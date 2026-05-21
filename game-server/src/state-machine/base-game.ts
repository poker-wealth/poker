import { TypedEventBus, type GameEventMap } from './event-bus.js';

/**
 * BaseGame — the contract every game engine implements (spec §17, "4-step new
 * game integration"). The runtime (RoomManager + WebSocket layer) only ever
 * talks to a game through this interface, so adding a game means implementing
 * these methods, not touching the framework.
 *
 * Iron rules enforced by the shape:
 *   - Rule 1: clients send actions via applyAction(); they never mutate state.
 *   - Rule 2: all state lives inside the game; reads go through getPublicState /
 *     getPrivateState (which redacts other players' hidden cards).
 *   - Rule 3: settlement goes through the Financial Core API (the game calls
 *     the injected settle function — it never writes balances itself).
 */

export type GameType =
  | 'TEXAS_HOLDEM'
  | 'BACCARAT'
  | 'NIU_NIU'
  | 'DOU_DI_ZHU'
  | 'SAN_ZHANG'
  | 'RED_PACKET_MINESWEEPER'
  | 'COWBOY_AND_BEAUTY'
  | 'LOTTERY'
  | 'SLOTS';

export interface GameAction {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ApplyActionResult {
  ok: boolean;
  /** Set when ok=false — a machine-readable reason the action was rejected. */
  error?: string;
}

export interface BaseGameConfig {
  tableId: string;
  tableType: 'PLATFORM' | 'LEAGUE';
  leagueId?: string;
  minPlayers: number;
  maxPlayers: number;
}

export abstract class BaseGame<PublicState = unknown, PrivateView = unknown> {
  abstract readonly gameType: GameType;
  readonly config: BaseGameConfig;
  readonly events: TypedEventBus<GameEventMap>;

  constructor(config: BaseGameConfig) {
    this.config = config;
    this.events = new TypedEventBus<GameEventMap>();
  }

  /** Seat a player at the table. Returns the assigned seat index. */
  abstract join(playerId: string, seatIndex?: number): number;

  /** Remove a player from the table. */
  abstract leave(playerId: string): void;

  /** Can a new hand legally start right now (enough players, table not mid-hand)? */
  abstract canStart(): boolean;

  /** Apply a player action (bet/call/fold/etc.). Validates and mutates state. */
  abstract applyAction(playerId: string, action: GameAction): ApplyActionResult;

  /** Public state safe to broadcast to everyone (no hidden cards). */
  abstract getPublicState(): PublicState;

  /** Per-player view including that player's own hidden information. */
  abstract getPrivateView(playerId: string): PrivateView;

  /** Current player count. */
  abstract get playerCount(): number;
}
