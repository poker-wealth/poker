import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { LEDGER_TYPES } from '../../domain/ledger-types.js';
import { requireScope } from '../../security/data-scope-middleware.js';
import { Account } from '../../wallet/account.model.js';
import { Ledger } from '../../wallet/ledger.model.js';
import {
  cancelWithdrawal,
  createWithdrawal,
} from '../../withdrawal/withdrawal-state-machine.js';
import { Withdrawal } from '../../withdrawal/withdrawal.model.js';
import { pathParam } from '../route-utils.js';

/**
 * Player-facing routes (mounted at /api/v1/me).
 * All routes require a valid player JWT (dataScopeMiddleware).
 */
export const meRouter = Router();

const asyncHandler =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<void>) =>
  (req: T, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

// ─── GET /api/v1/me/balance ─────────────────────────────────────────────
meRouter.get(
  '/balance',
  asyncHandler(async (req, res) => {
    const scope = requireScope(req);
    const accounts = await Account.find({
      account_type: 'PLAYER',
      owner_id: scope.userId,
    }).lean();
    res.json({
      userId: scope.userId,
      wallets: accounts.map((a) => ({
        walletScope: a.wallet_scope,
        balance: a.balance,
        currency: 'USDT-cents',
      })),
    });
  }),
);

// ─── GET /api/v1/me/transactions ────────────────────────────────────────
const txQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  type: z.enum(LEDGER_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});

meRouter.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const scope = requireScope(req);
    const q = txQuerySchema.parse(req.query);

    // Find this player's account ids (across all wallet scopes), then
    // fetch ledger entries where the player is on either side.
    const myAccounts = await Account.find({
      account_type: 'PLAYER',
      owner_id: scope.userId,
    })
      .select('_id')
      .lean();
    const myAccountIds = myAccounts.map((a) => a._id);

    const filter: Record<string, unknown> = {
      $or: [{ from_account: { $in: myAccountIds } }, { to_account: { $in: myAccountIds } }],
    };
    if (q.type) filter.type = q.type;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      if (q.from) range.$gte = q.from;
      if (q.to) range.$lte = q.to;
      filter.created_at = range;
    }
    if (q.cursor) {
      try {
        const cursorDate = new Date(Buffer.from(q.cursor, 'base64url').toString('utf8'));
        if (!Number.isNaN(cursorDate.getTime())) {
          filter.created_at = { ...((filter.created_at as object) ?? {}), $lt: cursorDate };
        }
      } catch {
        // ignore malformed cursor
      }
    }

    const items = await Ledger.find(filter)
      .sort({ created_at: -1 })
      .limit(q.limit + 1)
      .lean();

    const hasMore = items.length > q.limit;
    const page = hasMore ? items.slice(0, q.limit) : items;
    const next_cursor = hasMore
      ? Buffer.from(page[page.length - 1]!.created_at.toISOString(), 'utf8').toString('base64url')
      : null;

    const myAccountIdSet = new Set(myAccountIds);
    res.json({
      items: page.map((e) => ({
        id: e._id,
        type: e.type,
        amount: e.amount,
        direction: e.from_account && myAccountIdSet.has(e.from_account) ? 'out' : 'in',
        counterparty:
          e.from_account && myAccountIdSet.has(e.from_account)
            ? { account_id: e.to_account }
            : { account_id: e.from_account },
        status: e.status,
        metadata: e.metadata,
        created_at: e.created_at,
      })),
      next_cursor,
    });
  }),
);

// ─── POST /api/v1/me/withdrawals ────────────────────────────────────────
const createWithdrawalSchema = z.object({
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => BigInt(typeof v === 'number' ? Math.floor(v) : v)),
  destination_address: z.string().min(1),
});

meRouter.post(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const scope = requireScope(req);
    const body = createWithdrawalSchema.parse(req.body);
    const w = await createWithdrawal({
      playerId: scope.userId,
      amount: body.amount,
      destinationAddress: body.destination_address,
    });
    res.status(201).json(serializeWithdrawal(w));
  }),
);

// ─── GET /api/v1/me/withdrawals/:id ─────────────────────────────────────
meRouter.get(
  '/withdrawals/:id',
  asyncHandler(async (req, res) => {
    const scope = requireScope(req);
    const id = pathParam(req, 'id');
    const w = await Withdrawal.findOne({
      _id: id,
      player_id: scope.userId,
    }).lean();
    if (!w) {
      res.status(404).json({
        type: 'https://fairplay.app/errors/withdrawal-not-found',
        title: 'WithdrawalNotFound',
        status: 404,
        detail: `withdrawal ${id} not found for this user`,
        code: 'WITHDRAWAL_NOT_FOUND',
      });
      return;
    }
    res.json(serializeWithdrawal(w));
  }),
);

// ─── POST /api/v1/me/withdrawals/:id/cancel ─────────────────────────────
meRouter.post(
  '/withdrawals/:id/cancel',
  asyncHandler(async (req, res) => {
    const scope = requireScope(req);
    const id = pathParam(req, 'id');
    // Verify ownership.
    const owned = await Withdrawal.findOne({
      _id: id,
      player_id: scope.userId,
    })
      .select('_id')
      .lean();
    if (!owned) {
      res.status(404).json({
        type: 'https://fairplay.app/errors/withdrawal-not-found',
        title: 'WithdrawalNotFound',
        status: 404,
        detail: `withdrawal ${id} not found for this user`,
        code: 'WITHDRAWAL_NOT_FOUND',
      });
      return;
    }
    const note =
      req.body && typeof (req.body as { note?: unknown }).note === 'string'
        ? (req.body as { note: string }).note
        : 'cancelled by player';
    const w = await cancelWithdrawal(id, scope.userId, note);
    res.json(serializeWithdrawal(w));
  }),
);

function serializeWithdrawal(w: {
  _id: string;
  player_id: string;
  amount: bigint;
  destination_address: string;
  state: string;
  ledger_entry_id: string | null;
  refund_ledger_entry_id: string | null;
  tx_hash: string | null;
  reviewed_by: string | null;
  failure_reason: string | null;
  state_history: unknown[];
  created_at: Date;
  updated_at: Date;
}): Record<string, unknown> {
  return {
    id: w._id,
    player_id: w.player_id,
    amount: w.amount,
    destination_address: w.destination_address,
    state: w.state,
    ledger_entry_id: w.ledger_entry_id,
    refund_ledger_entry_id: w.refund_ledger_entry_id,
    tx_hash: w.tx_hash,
    reviewed_by: w.reviewed_by,
    failure_reason: w.failure_reason,
    state_history: w.state_history,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

// Internal export for ops route reuse.
export { serializeWithdrawal };
