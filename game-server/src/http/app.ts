import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import type { GameService } from '../runtime/game-service.js';
import { PlayerAlreadySeatedError, RoomNotFoundError } from '../state-machine/room-manager.js';

/**
 * HTTP transport for the game-server — table lifecycle (spec §17 game
 * lifecycle). Sits above the GameService. Real-time state push is handled
 * by the Socket.io gateway; this layer is request/response actions.
 *
 * Auth (M2): the authenticated player id arrives in `x-player-id`, trusted
 * as set by the upstream gateway (which validates the player JWT, same issuer
 * as Financial Core). Game-server does not re-validate the JWT in M2.
 *
 * Money values cross as strings (BigInt cents), matching the FC contract.
 */

const bigIntReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

function playerId(req: Request): string {
  const id = req.header('x-player-id');
  if (!id) throw new HttpError(401, 'MISSING_PLAYER_ID', 'x-player-id header required');
  return id;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

const createTableSchema = z.object({
  table_id: z.string().min(1).optional(),
  table_type: z.enum(['PLATFORM', 'LEAGUE']).default('PLATFORM'),
  league_id: z.string().min(1).optional(),
  small_blind: z.union([z.string(), z.number()]).transform((v) => BigInt(typeof v === 'number' ? v : v)),
  big_blind: z.union([z.string(), z.number()]).transform((v) => BigInt(typeof v === 'number' ? v : v)),
  min_players: z.number().int().min(2).max(10).default(2),
  max_players: z.number().int().min(2).max(10).default(6),
});

let tableSeq = 0;

export function buildGameApp(gameService: GameService): Express {
  const app = express();
  app.set('json replacer', bigIntReplacer);
  app.use(express.json({ limit: '256kb' }));

  const v1 = express.Router();

  v1.get('/health', (_req, res) => {
    res.json({ status: 'ok', tables: gameService.roomManager.listRooms().length });
  });

  // Create a table.
  v1.post(
    '/tables',
    asyncHandler(async (req, res) => {
      const b = createTableSchema.parse(req.body);
      const tableId = b.table_id ?? `table-${++tableSeq}-${Date.now()}`;
      gameService.createTexasTable({
        tableId,
        tableType: b.table_type,
        ...(b.league_id !== undefined && { leagueId: b.league_id }),
        minPlayers: b.min_players,
        maxPlayers: b.max_players,
        smallBlind: b.small_blind,
        bigBlind: b.big_blind,
      });
      res.status(201).json({ table_id: tableId });
    }),
  );

  // Lobby: list tables (public state).
  v1.get('/tables', (_req, res) => {
    res.json({
      tables: gameService.roomManager.listRooms().map((g) => g.getPublicState()),
    });
  });

  // Public table state.
  v1.get(
    '/tables/:id',
    asyncHandler(async (req, res) => {
      const game = gameService.roomManager.getRoom(req.params.id as string);
      res.json(game.getPublicState());
    }),
  );

  // Private view (own hole cards).
  v1.get(
    '/tables/:id/me',
    asyncHandler(async (req, res) => {
      const game = gameService.roomManager.getRoom(req.params.id as string);
      res.json(game.getPrivateView(playerId(req)));
    }),
  );

  // Join.
  v1.post(
    '/tables/:id/join',
    asyncHandler(async (req, res) => {
      const seat = typeof req.body?.seat === 'number' ? req.body.seat : undefined;
      const assigned = gameService.join(req.params.id as string, playerId(req), seat);
      res.status(201).json({ seat: assigned });
    }),
  );

  // Buy in.
  v1.post(
    '/tables/:id/buyin',
    asyncHandler(async (req, res) => {
      const amount = BigInt(req.body?.amount ?? 0);
      gameService.buyIn(req.params.id as string, playerId(req), amount);
      res.json({ ok: true });
    }),
  );

  // Start a hand.
  v1.post(
    '/tables/:id/start',
    asyncHandler(async (req, res) => {
      const tableId = req.params.id as string;
      const roundId = typeof req.body?.round_id === 'string' ? req.body.round_id : `r-${tableId}-${Date.now()}`;
      const out = await gameService.startHand(tableId, roundId);
      res.json({ round_id: out.roundId, server_commit: out.serverCommit });
    }),
  );

  // Apply an action; auto-settle if the hand completes.
  v1.post(
    '/tables/:id/action',
    asyncHandler(async (req, res) => {
      const tableId = req.params.id as string;
      const action = { type: String(req.body?.type), payload: req.body?.payload };
      const result = gameService.applyAction(tableId, playerId(req), action);
      if (!result.ok) {
        res.status(409).json({ code: 'ACTION_REJECTED', detail: result.error });
        return;
      }
      const settlement = await gameService.settleIfComplete(tableId);
      res.json({
        ok: true,
        state: gameService.roomManager.getRoom(tableId).getPublicState(),
        settled: settlement !== null,
        ...(settlement ? { winners: settlement.winners } : {}),
      });
    }),
  );

  app.use('/api/v1', v1);

  app.use((req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', detail: `${req.method} ${req.path}` });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ code: err.code, detail: err.message });
      return;
    }
    if (err instanceof RoomNotFoundError) {
      res.status(404).json({ code: 'TABLE_NOT_FOUND', detail: err.message });
      return;
    }
    if (err instanceof PlayerAlreadySeatedError) {
      res.status(409).json({ code: 'ALREADY_SEATED', detail: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ code: 'VALIDATION_FAILED', detail: err.issues });
      return;
    }
    logger.error({ err, path: req.path }, 'game-server http error');
    res.status(500).json({ code: 'INTERNAL_ERROR', detail: (err as Error).message });
  };
  app.use(errorHandler);

  return app;
}
