import type { Server, Socket } from 'socket.io';
import { logger } from '../lib/logger.js';
import { DisconnectManager } from '../runtime/disconnect-manager.js';
import type { GameService } from '../runtime/game-service.js';
import type { GameEventMap } from '../state-machine/event-bus.js';

/**
 * Socket.io gateway — real-time game state push (spec §17: game-state and chat
 * on SEPARATE namespaces so chat can never destabilize the game).
 *
 *   /game  — players (immediate state) + spectators (5s-delayed, read-only,
 *            max 20/table). Clients RECEIVE state here; ACTIONS go via HTTP,
 *            so spectators are inherently unable to act (the engine rejects
 *            non-seated players).
 *   /chat  — separate namespace (M2 stub; full chat is M6).
 *
 * Disconnect handling (spec §6.4) via DisconnectManager: a player socket drop
 * PAUSES their action with a 20s grace timer; on expiry (or per-hour cap) the
 * player is auto-folded.
 */

const SPECTATOR_DELAY_MS = 5_000;
const MAX_SPECTATORS_PER_TABLE = 20;

const FORWARDED_EVENTS = [
  'state_changed',
  'player_joined',
  'player_left',
  'turn_changed',
  'action_applied',
  'hand_started',
  'hand_settled',
] as const satisfies ReadonlyArray<keyof GameEventMap>;

interface GatewayDeps {
  gameService: GameService;
  disconnect?: DisconnectManager;
  /** Override the spectator delay (tests use 0). */
  spectatorDelayMs?: number;
}

export function attachGameGateway(io: Server, deps: GatewayDeps): void {
  const { gameService } = deps;
  const disconnect = deps.disconnect ?? new DisconnectManager();
  const spectatorDelayMs = deps.spectatorDelayMs ?? SPECTATOR_DELAY_MS;

  const wired = new Set<string>(); // tableIds whose event bus we've subscribed to
  const spectatorCount = new Map<string, number>();
  const game = io.of('/game');

  function playerRoom(tableId: string): string {
    return `table:${tableId}`;
  }
  function spectatorRoom(tableId: string): string {
    return `spec:${tableId}`;
  }

  /** Subscribe (once per table) to the game's event bus → forward to rooms. */
  function wireTable(tableId: string): void {
    if (wired.has(tableId)) return;
    let room;
    try {
      room = gameService.roomManager.getRoom(tableId);
    } catch {
      return;
    }
    for (const evt of FORWARDED_EVENTS) {
      room.events.on(evt, ((payload: unknown) => {
        // Players: immediate.
        game.to(playerRoom(tableId)).emit(evt, payload);
        // Spectators: delayed.
        setTimeout(() => {
          game.to(spectatorRoom(tableId)).emit(evt, payload);
        }, spectatorDelayMs);
      }) as never);
    }
    wired.add(tableId);
  }

  game.on('connection', (socket: Socket) => {
    const tableId = String(socket.handshake.query['tableId'] ?? '');
    const pid = socket.handshake.query['playerId'] ? String(socket.handshake.query['playerId']) : null;
    const asSpectator = String(socket.handshake.query['spectator'] ?? '') === 'true';

    if (!tableId || !gameService.roomManager.hasRoom(tableId)) {
      socket.emit('error_event', { code: 'TABLE_NOT_FOUND', tableId });
      socket.disconnect(true);
      return;
    }

    wireTable(tableId);

    if (asSpectator) {
      const count = spectatorCount.get(tableId) ?? 0;
      if (count >= MAX_SPECTATORS_PER_TABLE) {
        socket.emit('error_event', { code: 'SPECTATOR_LIMIT', tableId });
        socket.disconnect(true);
        return;
      }
      spectatorCount.set(tableId, count + 1);
      void socket.join(spectatorRoom(tableId));
      socket.data['spectator'] = true;
      socket.emit('state', gameService.roomManager.getRoom(tableId).getPublicState());
      socket.on('disconnect', () => {
        spectatorCount.set(tableId, Math.max(0, (spectatorCount.get(tableId) ?? 1) - 1));
      });
      return;
    }

    // Seated player (or observer with a player id).
    void socket.join(playerRoom(tableId));
    socket.data['playerId'] = pid;
    const room = gameService.roomManager.getRoom(tableId);
    socket.emit('state', pid ? room.getPrivateView(pid) : room.getPublicState());

    // Reconnect: if this player was mid-grace, resume.
    if (pid) disconnect.onReconnect(currentHandId(gameService, tableId), pid);

    socket.on('disconnect', () => {
      if (!pid) return;
      const handId = currentHandId(gameService, tableId);
      const outcome = disconnect.onDisconnect(handId, pid);
      logger.info({ tableId, playerId: pid, outcome }, 'player socket disconnected');
      if (outcome === 'AUTO_FOLD') {
        autoFold(gameService, tableId, pid);
      } else {
        // Schedule an auto-fold when grace expires unless they reconnect.
        const graceMs = disconnect.remainingGraceMs(handId, pid);
        setTimeout(() => {
          if (disconnect.shouldAutoFold(handId, pid)) autoFold(gameService, tableId, pid);
        }, graceMs).unref?.();
      }
    });
  });

  // Separate chat namespace — M2 stub (full chat lands in M6).
  io.of('/chat').on('connection', (socket: Socket) => {
    socket.emit('chat_ready', { note: 'chat is a separate namespace; full chat is M6' });
  });
}

function currentHandId(gameService: GameService, tableId: string): string {
  const state = gameService.roomManager.getRoom(tableId).getPublicState() as { tableId?: string };
  return `${tableId}:${state.tableId ?? ''}`;
}

function autoFold(gameService: GameService, tableId: string, playerId: string): void {
  try {
    const result = gameService.applyAction(tableId, playerId, { type: 'fold' });
    if (result.ok) {
      void gameService.settleIfComplete(tableId);
      logger.info({ tableId, playerId }, 'auto-folded disconnected player');
    }
  } catch (err) {
    logger.debug({ err, tableId, playerId }, 'auto-fold no-op (not actionable)');
  }
}
