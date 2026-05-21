import { logger } from '../lib/logger.js';
import { FcClient } from '../fc-client/fc-client.js';
import { buildSettlePotsRequest } from '../fc-client/settlement-adapter.js';
import { TexasHoldem, type HandResult, type TexasConfig } from '../games/texas/texas-holdem.js';
import type { ApplyActionResult, GameAction } from '../state-machine/base-game.js';
import { RoomManager } from '../state-machine/room-manager.js';
import type { CloudRandomSource } from '../provably-fair/kms.js';
import type { DrandClientOptions } from '../provably-fair/drand.js';
import { beginRound } from '../provably-fair/round-randomness.js';

/**
 * GameService — the runtime orchestrator that runs complete hands end-to-end:
 *
 *   provably-fair seed (beginRound) → deal → betting actions → showdown →
 *   FC settlement (settle-pots) → reconcile table stacks with the house cut.
 *
 * Holds the RoomManager (single-account-one-table) and wires each game to the
 * Financial Core over HTTP. The WebSocket/HTTP transport layer sits ABOVE this
 * — it calls these methods and forwards game events to clients.
 */

export interface RakePolicy {
  /** Compute rake (cents) from the round's gross pot. House rules + caps. */
  (potTotalCents: bigint): bigint;
}

export interface GameServiceDeps {
  fcClient: FcClient;
  drand: DrandClientOptions;
  cloud: CloudRandomSource;
  rakePolicy: RakePolicy;
}

export interface SettlementOutcome {
  roundId: string;
  winners: string[];
  rakeCents: bigint;
  /** The receipt returned by FC settle-pots. */
  receipt: unknown;
}

export class GameService {
  private readonly rooms = new RoomManager();
  private readonly deps: GameServiceDeps;
  /** roundIds already settled, to avoid double-settling. */
  private readonly settled = new Set<string>();

  constructor(deps: GameServiceDeps) {
    this.deps = deps;
  }

  get roomManager(): RoomManager {
    return this.rooms;
  }

  createTexasTable(config: TexasConfig): TexasHoldem {
    const game = new TexasHoldem(config);
    this.rooms.createRoom(game);
    return game;
  }

  join(tableId: string, playerId: string, seatIndex?: number): number {
    return this.rooms.join(tableId, playerId, seatIndex);
  }

  leave(tableId: string, playerId: string): void {
    this.rooms.leave(tableId, playerId);
  }

  buyIn(tableId: string, playerId: string, amountCents: bigint): void {
    this.texas(tableId).buyIn(playerId, amountCents);
  }

  /**
   * Begin a hand: fetch the provably-fair seed (drand + KMS triple-mix),
   * commit, then deal. Returns the public commit so clients can verify later.
   */
  async startHand(tableId: string, roundId: string): Promise<{ roundId: string; serverCommit: string }> {
    const game = this.texas(tableId);
    const seed = await beginRound(roundId, { drand: this.deps.drand, cloud: this.deps.cloud });
    game.startHand({ roundId, finalSeed: seed.finalSeed });
    logger.info({ tableId, roundId, serverCommit: seed.serverCommit }, 'hand started');
    return { roundId, serverCommit: seed.serverCommit };
  }

  applyAction(tableId: string, playerId: string, action: GameAction): ApplyActionResult {
    return this.texas(tableId).applyAction(playerId, action);
  }

  /**
   * If the table's current hand has reached SETTLED, settle it with the
   * Financial Core and reconcile in-memory stacks with the house cut.
   * Idempotent per round. Returns null if there's nothing to settle.
   */
  async settleIfComplete(tableId: string): Promise<SettlementOutcome | null> {
    const game = this.texas(tableId);
    if (game.state !== 'SETTLED') return null;
    const result = game.getHandResult();
    if (!result) return null;
    if (this.settled.has(result.roundId)) return null;

    const rakeCents = this.deps.rakePolicy(result.potTotal);
    const policy = {
      tableType: game.config.tableType,
      ...(game.config.leagueId !== undefined && { leagueId: game.config.leagueId }),
      rakeCents,
    };
    const req = buildSettlePotsRequest(result, policy);

    const receipt = await this.deps.fcClient.settlePots(req, `settle:${result.roundId}`);
    this.settled.add(result.roundId);

    // Reconcile: FC took rake + jackpot from the primary winner. Reduce that
    // winner's table stack so it matches their real FC balance.
    this.reconcileHouseCut(game, result, rakeCents);

    logger.info(
      { tableId, roundId: result.roundId, winners: result.winners, rakeCents: rakeCents.toString() },
      'hand settled with FC',
    );
    return { roundId: result.roundId, winners: result.winners, rakeCents, receipt };
  }

  private reconcileHouseCut(game: TexasHoldem, result: HandResult, rakeCents: bigint): void {
    // jackpot = 0.5% of total winner profit (FC's rate). Primary winner pays.
    const totalWinnerProfit = result.players
      .filter((p) => p.net > 0n)
      .reduce((s, p) => s + p.net, 0n);
    const jackpotTotal = (totalWinnerProfit * 5n) / 1000n;
    const houseCut = rakeCents + jackpotTotal;
    if (houseCut === 0n) return;

    // Primary winner = largest net (matches settlePots' choice).
    const primary = [...result.players]
      .filter((p) => p.net > 0n)
      .sort((a, b) => (b.net > a.net ? 1 : -1))[0];
    if (!primary) return;
    game.applyHouseCut(primary.playerId, houseCut);
  }

  private texas(tableId: string): TexasHoldem {
    const room = this.rooms.getRoom(tableId);
    if (!(room instanceof TexasHoldem)) {
      throw new Error(`GameService: table ${tableId} is not Texas Hold'em`);
    }
    return room;
  }
}
