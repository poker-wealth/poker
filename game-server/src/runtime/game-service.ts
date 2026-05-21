import { logger } from '../lib/logger.js';
import { cardId } from '../cards/card.js';
import { freshDeck, shuffleDeck } from '../cards/deck.js';
import { FcClient } from '../fc-client/fc-client.js';
import { buildSettlePotsRequest } from '../fc-client/settlement-adapter.js';
import { TexasHoldem, type HandResult, type TexasConfig } from '../games/texas/texas-holdem.js';
import type { ApplyActionResult, GameAction } from '../state-machine/base-game.js';
import { RoomManager } from '../state-machine/room-manager.js';
import type { CloudRandomSource } from '../provably-fair/kms.js';
import type { DrandClientOptions } from '../provably-fair/drand.js';
import { beginRound, type RoundSeed } from '../provably-fair/round-randomness.js';
import type { RevealReceipt } from '../provably-fair/verification.js';
import type { ResilientCommitter, CommitResult } from '../blockchain/chain-commit.js';

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
  /** Optional: anchors each settled hand's receipt on-chain (async, off the
   *  critical path). When omitted, no chain commitment is attempted. */
  chainCommitter?: ResilientCommitter;
}

export interface SettlementOutcome {
  roundId: string;
  winners: string[];
  rakeCents: bigint;
  /** The receipt returned by FC settle-pots. */
  receipt: unknown;
}

/** Per-round reveal data, published once the hand is SETTLED (provably fair). */
interface RoundRecord {
  seed: RoundSeed;
  tableId: string;
  numPlayers: number;
  revealed: boolean;
}

export class GameService {
  private readonly rooms = new RoomManager();
  private readonly deps: GameServiceDeps;
  /** roundIds already settled, to avoid double-settling. */
  private readonly settled = new Set<string>();
  /** roundId → reveal record (seed published only after SETTLED). */
  private readonly rounds = new Map<string, RoundRecord>();
  /** roundId → on-chain commit result (set async after settlement). */
  private readonly commits = new Map<string, CommitResult>();

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
    // Record reveal data — kept secret (revealed=false) until the hand settles.
    this.rounds.set(roundId, { seed, tableId, numPlayers: game.playerCount, revealed: false });
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

    // Reveal becomes public now that the hand is over (provably fair).
    const round = this.rounds.get(result.roundId);
    if (round) round.revealed = true;

    // Anchor the receipt on-chain — async, OFF the critical path (spec §6).
    const receiptHash = (receipt as { hash?: string }).hash;
    if (this.deps.chainCommitter && receiptHash) {
      void this.deps.chainCommitter
        .commit({ roundId: result.roundId, hash: receiptHash })
        .then((c) => {
          this.commits.set(result.roundId, c);
          logger.info({ roundId: result.roundId, chain: c.chainUsed, ref: c.reference }, 'receipt anchored');
        })
        .catch((err) => logger.error({ err, roundId: result.roundId }, 'chain commit failed (all layers)'));
    }

    logger.info(
      { tableId, roundId: result.roundId, winners: result.winners, rakeCents: rakeCents.toString() },
      'hand settled with FC',
    );
    return { roundId: result.roundId, winners: result.winners, rakeCents, receipt };
  }

  /** On-chain commit result for a round, once anchored (null if pending/none). */
  getCommit(roundId: string): CommitResult | null {
    return this.commits.get(roundId) ?? null;
  }

  /**
   * Public reveal data for a SETTLED round — the inputs an external verifier
   * needs to re-derive the deck and confirm the deal was fair. Returns null if
   * the round is unknown or not yet revealed (hand still in progress).
   */
  getRevealReceipt(roundId: string): RevealReceipt | null {
    const round = this.rounds.get(roundId);
    if (!round || !round.revealed) return null;
    const deck = shuffleDeck(freshDeck(), round.seed.finalSeed);
    return {
      roundId: round.seed.roundId,
      serverSeedHex: round.seed.serverSeedHex,
      serverCommit: round.seed.serverCommit,
      finalSeedHex: round.seed.finalSeedHex,
      randomSource: round.seed.randomSource,
      cloudRandomHex: round.seed.cloudRandomHex,
      drand: round.seed.drand,
      dealtDeck: deck.map(cardId),
    };
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
