import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole, requireScope } from '../../security/data-scope-middleware.js';
import {
  approveWithdrawal,
  cancelWithdrawal,
  markBroadcasting,
  markConfirmed,
  markFailedAndRollback,
} from '../../withdrawal/withdrawal-state-machine.js';
import {
  WITHDRAWAL_STATES,
  Withdrawal,
} from '../../withdrawal/withdrawal.model.js';
import { pathParam } from '../route-utils.js';
import { serializeWithdrawal } from './me.js';

/**
 * Ops endpoints (mounted at /api/v1/ops). All require role = ops or admin.
 */
export const opsRouter = Router();

// Apply role gate to every ops route.
opsRouter.use(requireRole('ops', 'admin'));

const asyncHandler =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<void>) =>
  (req: T, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

// ─── GET /api/v1/ops/withdrawals ────────────────────────────────────────
const queueQuerySchema = z.object({
  state: z.enum(WITHDRAWAL_STATES).optional(),
  min_amount: z
    .union([z.string(), z.number()])
    .transform((v) => BigInt(typeof v === 'number' ? Math.floor(v) : v))
    .optional(),
  created_after: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

opsRouter.get(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const q = queueQuerySchema.parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.state) filter.state = q.state;
    if (q.min_amount !== undefined) filter.amount = { $gte: q.min_amount };
    if (q.created_after) filter.created_at = { $gte: q.created_after };
    const items = await Withdrawal.find(filter)
      .sort({ created_at: -1 })
      .limit(q.limit)
      .lean();
    res.json({ items: items.map((w) => serializeWithdrawal(w)) });
  }),
);

// ─── POST /api/v1/ops/withdrawals/:id/approve ───────────────────────────
opsRouter.post(
  '/withdrawals/:id/approve',
  asyncHandler(async (req, res) => {
    const scope = requireScope(req);
    const w = await approveWithdrawal({
      withdrawalId: pathParam(req, 'id'),
      reviewer: scope.userId,
    });
    res.json(serializeWithdrawal(w));
  }),
);

// ─── POST /api/v1/ops/withdrawals/:id/reject ────────────────────────────
const rejectSchema = z.object({ reason: z.string().min(1) });

opsRouter.post(
  '/withdrawals/:id/reject',
  asyncHandler(async (req, res) => {
    const scope = requireScope(req);
    const body = rejectSchema.parse(req.body);
    const w = await cancelWithdrawal(pathParam(req, 'id'), scope.userId, body.reason);
    res.json(serializeWithdrawal(w));
  }),
);

// ─── POST /api/v1/ops/withdrawals/:id/broadcast ─────────────────────────
const broadcastSchema = z.object({ tx_hash: z.string().min(1) });

opsRouter.post(
  '/withdrawals/:id/broadcast',
  asyncHandler(async (req, res) => {
    const body = broadcastSchema.parse(req.body);
    const w = await markBroadcasting({
      withdrawalId: pathParam(req, 'id'),
      txHash: body.tx_hash,
    });
    res.json(serializeWithdrawal(w));
  }),
);

// ─── POST /api/v1/ops/withdrawals/:id/confirm ───────────────────────────
opsRouter.post(
  '/withdrawals/:id/confirm',
  asyncHandler(async (req, res) => {
    const w = await markConfirmed({ withdrawalId: pathParam(req, 'id') });
    res.json(serializeWithdrawal(w));
  }),
);

// ─── POST /api/v1/ops/withdrawals/:id/fail ──────────────────────────────
const failSchema = z.object({ reason: z.string().min(1) });

opsRouter.post(
  '/withdrawals/:id/fail',
  asyncHandler(async (req, res) => {
    const body = failSchema.parse(req.body);
    const w = await markFailedAndRollback({
      withdrawalId: pathParam(req, 'id'),
      reason: body.reason,
    });
    res.json(serializeWithdrawal(w));
  }),
);
