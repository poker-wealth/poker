import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES } from '../../domain/account-types.js';
import { LEDGER_STATUSES, LEDGER_TYPES } from '../../domain/ledger-types.js';
import { creditDeposit } from '../../deposit/deposit-credit.js';
import { settlePots, type SettlePotsReceipt } from '../../settlement/settle-pots.js';
import { settleRound, type SettleRoundReceipt } from '../../settlement/settlement-engine.js';
import { transfer } from '../../wallet/transfer.js';

/**
 * Server-to-server routes (mounted at /api/v1/internal).
 * Gated by internalAuthMiddleware (X-Internal-Token shared secret).
 */
export const internalRouter = Router();

const asyncHandler =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<void>) =>
  (req: T, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

const accountRefSchema = z.object({
  type: z.enum(ACCOUNT_TYPES),
  owner_id: z.string().min(1),
  wallet_scope: z.string().min(1).optional(),
});

const bigintFromInput = z
  .union([z.string(), z.number()])
  .transform((v) => BigInt(typeof v === 'number' ? Math.floor(v) : v))
  .refine((b) => b > 0n, 'amount must be > 0');

// ─── POST /api/v1/internal/settle-round ─────────────────────────────────
const settleRoundSchema = z.object({
  round_id: z.string().min(1),
  table_id: z.string().min(1),
  table_type: z.enum(['PLATFORM', 'LEAGUE']),
  league_id: z.string().min(1).nullable().optional(),
  winner_owner_id: z.string().min(1),
  winner_profit: z
    .union([z.string(), z.number()])
    .transform((v) => BigInt(typeof v === 'number' ? Math.floor(v) : v))
    .refine((b) => b >= 0n, 'winner_profit must be >= 0'),
  rake_amount: z
    .union([z.string(), z.number()])
    .transform((v) => BigInt(typeof v === 'number' ? Math.floor(v) : v))
    .refine((b) => b >= 0n, 'rake_amount must be >= 0'),
  losers: z
    .array(
      z.object({
        owner_id: z.string().min(1),
        contribution: bigintFromInput,
      }),
    )
    .min(1),
});

internalRouter.post(
  '/settle-round',
  asyncHandler(async (req, res) => {
    const body = settleRoundSchema.parse(req.body);
    const receipt = await settleRound({
      roundId: body.round_id,
      tableId: body.table_id,
      tableType: body.table_type,
      leagueId: body.league_id ?? undefined,
      winnerOwnerId: body.winner_owner_id,
      winnerProfit: body.winner_profit,
      rakeAmount: body.rake_amount,
      losers: body.losers.map((l) => ({
        ownerId: l.owner_id,
        contribution: l.contribution,
      })),
    });
    if (receipt.replayed) res.set('x-idempotent-replay', 'true');
    res.json(serializeReceipt(receipt));
  }),
);

// ─── POST /api/v1/internal/settle-pots (multi-winner: split / side pots) ─
const settlePotsSchema = z.object({
  round_id: z.string().min(1),
  table_id: z.string().min(1),
  table_type: z.enum(['PLATFORM', 'LEAGUE']),
  league_id: z.string().min(1).nullable().optional(),
  rake_amount: z
    .union([z.string(), z.number()])
    .transform((v) => BigInt(typeof v === 'number' ? Math.floor(v) : v))
    .refine((b) => b >= 0n, 'rake_amount must be >= 0'),
  net_deltas: z
    .array(
      z.object({
        owner_id: z.string().min(1),
        net: z.union([z.string(), z.number()]).transform((v) => BigInt(typeof v === 'number' ? Math.floor(v) : v)),
        wallet_scope: z.string().min(1).optional(),
      }),
    )
    .min(2),
});

internalRouter.post(
  '/settle-pots',
  asyncHandler(async (req, res) => {
    const body = settlePotsSchema.parse(req.body);
    const receipt = await settlePots({
      roundId: body.round_id,
      tableId: body.table_id,
      tableType: body.table_type,
      leagueId: body.league_id ?? undefined,
      rakeAmount: body.rake_amount,
      netDeltas: body.net_deltas.map((d) => ({
        ownerId: d.owner_id,
        net: d.net,
        ...(d.wallet_scope !== undefined && { walletScope: d.wallet_scope }),
      })),
    });
    if (receipt.replayed) res.set('x-idempotent-replay', 'true');
    res.json(serializePotsReceipt(receipt));
  }),
);

// ─── POST /api/v1/internal/transfer ─────────────────────────────────────
const transferSchema = z.object({
  from: accountRefSchema.optional(),
  to: accountRefSchema.optional(),
  amount: bigintFromInput,
  ledger_type: z.enum(LEDGER_TYPES),
  status: z.enum(LEDGER_STATUSES).optional(),
  metadata: z.record(z.unknown()).optional(),
});

internalRouter.post(
  '/transfer',
  asyncHandler(async (req, res) => {
    const body = transferSchema.parse(req.body);
    const idempotencyKey = req.header('idempotency-key') ?? '';
    if (!idempotencyKey) {
      res.status(400).json({
        type: 'https://fairplay.app/errors/missing-idempotency-key',
        title: 'MissingIdempotencyKey',
        status: 400,
        detail: 'POST /internal/transfer requires Idempotency-Key header',
        code: 'MISSING_IDEMPOTENCY_KEY',
      });
      return;
    }
    const result = await transfer({
      from: body.from
        ? {
            type: body.from.type,
            ownerId: body.from.owner_id,
            ...(body.from.wallet_scope !== undefined && { walletScope: body.from.wallet_scope }),
          }
        : undefined,
      to: body.to
        ? {
            type: body.to.type,
            ownerId: body.to.owner_id,
            ...(body.to.wallet_scope !== undefined && { walletScope: body.to.wallet_scope }),
          }
        : undefined,
      amount: body.amount,
      ledgerType: body.ledger_type,
      idempotencyKey,
      ...(body.status !== undefined && { status: body.status }),
      ...(body.metadata !== undefined && { metadata: body.metadata }),
    });
    if (result.replayed) res.set('x-idempotent-replay', 'true');
    res.json({
      ledger_entry: result.ledgerEntry,
      from_account: result.fromAccount,
      to_account: result.toAccount,
      duration_ms: result.durationMs,
      replayed: result.replayed,
      retries: result.retries,
    });
  }),
);

// ─── POST /api/v1/internal/deposit/credit ───────────────────────────────
const depositCreditSchema = z.object({
  player_id: z.string().min(1),
  amount: bigintFromInput,
  tx_hash: z.string().min(1),
  contract_address: z.string().min(1),
  confirmations: z.number().int().nonnegative(),
  block_number: z.number().int().nonnegative().optional(),
  from_tron_address: z.string().optional(),
  wallet_scope: z.string().min(1).optional(),
});

internalRouter.post(
  '/deposit/credit',
  asyncHandler(async (req, res) => {
    const body = depositCreditSchema.parse(req.body);
    const result = await creditDeposit({
      playerId: body.player_id,
      amount: body.amount,
      txHash: body.tx_hash,
      contractAddress: body.contract_address,
      confirmations: body.confirmations,
      ...(body.block_number !== undefined && { blockNumber: body.block_number }),
      ...(body.from_tron_address !== undefined && { fromTronAddress: body.from_tron_address }),
      ...(body.wallet_scope !== undefined && { walletScope: body.wallet_scope }),
    });
    if (result.replayed) res.set('x-idempotent-replay', 'true');
    res.json({
      ledger_entry: result.ledgerEntry,
      to_account: result.toAccount,
      tx_hash: result.txHash,
      replayed: result.replayed,
    });
  }),
);

function serializeReceipt(r: SettleRoundReceipt): Record<string, unknown> {
  return {
    round_id: r.roundId,
    table_id: r.tableId,
    table_type: r.tableType,
    league_id: r.leagueId,
    sequence: r.sequence,
    amounts: {
      payouts: r.amounts.payouts,
      rake: r.amounts.rake,
      jackpot: {
        mini: r.amounts.jackpot.mini,
        minor: r.amounts.jackpot.minor,
        major: r.amounts.jackpot.major,
        grand: r.amounts.jackpot.grand,
        total: r.amounts.jackpot.total,
      },
    },
    accounts: r.accounts,
    ledger_entry_ids: r.ledgerEntryIds,
    hash: r.hash,
    duration_ms: r.durationMs,
    replayed: r.replayed,
  };
}

function serializePotsReceipt(r: SettlePotsReceipt): Record<string, unknown> {
  return {
    round_id: r.roundId,
    table_id: r.tableId,
    table_type: r.tableType,
    league_id: r.leagueId,
    winners: r.winners,
    amounts: {
      rake: r.amounts.rake,
      gross_payout_total: r.amounts.grossPayoutTotal,
      jackpot: {
        mini: r.amounts.jackpot.mini,
        minor: r.amounts.jackpot.minor,
        major: r.amounts.jackpot.major,
        grand: r.amounts.jackpot.grand,
        total: r.amounts.jackpot.total,
      },
    },
    ledger_entry_ids: r.ledgerEntryIds,
    hash: r.hash,
    duration_ms: r.durationMs,
    replayed: r.replayed,
  };
}
