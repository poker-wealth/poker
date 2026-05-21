import {
  BaseGame,
  type ApplyActionResult,
  type BaseGameConfig,
  type GameAction,
  type GameType,
} from '../../src/state-machine/base-game';
import {
  PlayerAlreadySeatedError,
  RoomManager,
  RoomNotFoundError,
} from '../../src/state-machine/room-manager';

/** Minimal concrete game for testing the room layer. */
class StubGame extends BaseGame<{ players: string[] }, { players: string[] }> {
  readonly gameType: GameType = 'TEXAS_HOLDEM';
  private readonly players = new Map<string, number>();
  private nextSeat = 0;

  override join(playerId: string, seatIndex?: number): number {
    const seat = seatIndex ?? this.nextSeat++;
    this.players.set(playerId, seat);
    return seat;
  }
  override leave(playerId: string): void {
    this.players.delete(playerId);
  }
  override canStart(): boolean {
    return this.players.size >= this.config.minPlayers;
  }
  override applyAction(_playerId: string, _action: GameAction): ApplyActionResult {
    return { ok: true };
  }
  override getPublicState(): { players: string[] } {
    return { players: [...this.players.keys()] };
  }
  override getPrivateView(): { players: string[] } {
    return { players: [...this.players.keys()] };
  }
  override get playerCount(): number {
    return this.players.size;
  }
}

function makeGame(tableId: string): StubGame {
  const config: BaseGameConfig = {
    tableId,
    tableType: 'PLATFORM',
    minPlayers: 2,
    maxPlayers: 6,
  };
  return new StubGame(config);
}

describe('state-machine/RoomManager', () => {
  it('creates and looks up rooms', () => {
    const rm = new RoomManager();
    rm.createRoom(makeGame('t1'));
    expect(rm.hasRoom('t1')).toBe(true);
    expect(rm.getRoom('t1').config.tableId).toBe('t1');
    expect(rm.listRooms()).toHaveLength(1);
  });

  it('rejects duplicate table ids', () => {
    const rm = new RoomManager();
    rm.createRoom(makeGame('t1'));
    expect(() => rm.createRoom(makeGame('t1'))).toThrow(/already exists/);
  });

  it('throws RoomNotFoundError for unknown tables', () => {
    const rm = new RoomManager();
    expect(() => rm.getRoom('nope')).toThrow(RoomNotFoundError);
  });

  it('joins a player and tracks their table', () => {
    const rm = new RoomManager();
    rm.createRoom(makeGame('t1'));
    const seat = rm.join('t1', 'alice');
    expect(typeof seat).toBe('number');
    expect(rm.tableOf('alice')).toBe('t1');
  });

  it('enforces single-account-one-table (spec §8)', () => {
    const rm = new RoomManager();
    rm.createRoom(makeGame('t1'));
    rm.createRoom(makeGame('t2'));
    rm.join('t1', 'alice');
    expect(() => rm.join('t2', 'alice')).toThrow(PlayerAlreadySeatedError);
    // Same table re-join is allowed (idempotent reconnect).
    expect(() => rm.join('t1', 'alice')).not.toThrow();
  });

  it('leave frees the player to join elsewhere', () => {
    const rm = new RoomManager();
    rm.createRoom(makeGame('t1'));
    rm.createRoom(makeGame('t2'));
    rm.join('t1', 'alice');
    rm.leave('t1', 'alice');
    expect(rm.tableOf('alice')).toBeNull();
    expect(() => rm.join('t2', 'alice')).not.toThrow();
    expect(rm.tableOf('alice')).toBe('t2');
  });

  it('closeRoom removes the room and drops its players', () => {
    const rm = new RoomManager();
    rm.createRoom(makeGame('t1'));
    rm.join('t1', 'alice');
    rm.join('t1', 'bob');
    rm.closeRoom('t1');
    expect(rm.hasRoom('t1')).toBe(false);
    expect(rm.tableOf('alice')).toBeNull();
    expect(rm.tableOf('bob')).toBeNull();
  });
});
