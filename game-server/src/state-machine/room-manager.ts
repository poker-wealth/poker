import type { BaseGame } from './base-game.js';

/**
 * RoomManager — lifecycle of game tables (rooms). Holds the active BaseGame
 * instances and routes joins/leaves/lookups. The WebSocket layer asks the
 * RoomManager to find a room, then forwards actions to it.
 *
 * Single-account-one-table (spec §8 Anti-Bot) is enforced here at the room
 * layer: a player may occupy at most one table at a time across the whole
 * RoomManager. The Redis atomic check is the production cross-node enforcement;
 * this in-process guard is the local backstop.
 */

export class PlayerAlreadySeatedError extends Error {
  constructor(
    public readonly playerId: string,
    public readonly existingTableId: string,
  ) {
    super(`PlayerAlreadySeated: ${playerId} is already at table ${existingTableId}`);
    this.name = 'PlayerAlreadySeatedError';
  }
}

export class RoomNotFoundError extends Error {
  constructor(public readonly tableId: string) {
    super(`RoomNotFound: ${tableId}`);
    this.name = 'RoomNotFoundError';
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, BaseGame>();
  /** playerId → tableId, enforcing single-account-one-table. */
  private readonly playerTable = new Map<string, string>();

  /** Register a freshly-created game as a room. */
  createRoom(game: BaseGame): void {
    const id = game.config.tableId;
    if (this.rooms.has(id)) throw new Error(`RoomManager: table ${id} already exists`);
    this.rooms.set(id, game);
  }

  getRoom(tableId: string): BaseGame {
    const room = this.rooms.get(tableId);
    if (!room) throw new RoomNotFoundError(tableId);
    return room;
  }

  hasRoom(tableId: string): boolean {
    return this.rooms.has(tableId);
  }

  listRooms(): BaseGame[] {
    return [...this.rooms.values()];
  }

  /**
   * Join a player to a table through the manager so the single-table rule is
   * enforced. Returns the assigned seat.
   */
  join(tableId: string, playerId: string, seatIndex?: number): number {
    const existing = this.playerTable.get(playerId);
    if (existing && existing !== tableId) {
      throw new PlayerAlreadySeatedError(playerId, existing);
    }
    const room = this.getRoom(tableId);
    const seat = room.join(playerId, seatIndex);
    this.playerTable.set(playerId, tableId);
    return seat;
  }

  leave(tableId: string, playerId: string): void {
    const room = this.getRoom(tableId);
    room.leave(playerId);
    this.playerTable.delete(playerId);
  }

  /** Which table is this player at, if any? */
  tableOf(playerId: string): string | null {
    return this.playerTable.get(playerId) ?? null;
  }

  /** Close and remove a room. Drops all its players from the single-table map. */
  closeRoom(tableId: string): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    for (const [pid, tid] of this.playerTable) {
      if (tid === tableId) this.playerTable.delete(pid);
    }
    this.rooms.delete(tableId);
  }
}
