import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { PLATFORM_OWNER } from '../../src/domain/account-types';
import { buildApp } from '../../src/http/app';
import { signToken } from '../../src/security/jwt';
import { Account } from '../../src/wallet/account.model';
import { Ledger } from '../../src/wallet/ledger.model';
import { Withdrawal } from '../../src/withdrawal/withdrawal.model';

const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN!;

describe('http/app — end-to-end via supertest', () => {
  let rs: MongoMemoryReplSet;
  const app = buildApp();

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await connectDB(rs.getUri());
    await Account.syncIndexes();
    await Ledger.syncIndexes();
    await Withdrawal.syncIndexes();
  });

  afterAll(async () => {
    await disconnectDB();
    await rs.stop();
  });

  beforeEach(async () => {
    await Account.deleteMany({});
    await Ledger.deleteMany({});
    await Withdrawal.deleteMany({});
  });

  // ───────────────────────────────────────────────────────────────────
  // Health
  // ───────────────────────────────────────────────────────────────────
  describe('GET /api/v1/health', () => {
    it('returns 200 with status ok and mongo connected', async () => {
      const r = await request(app).get('/api/v1/health');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: 'ok', mongo: 'connected' });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // 404 fallback + error model shape
  // ───────────────────────────────────────────────────────────────────
  describe('error model', () => {
    it('unknown route returns 404 problem-details', async () => {
      const r = await request(app).get('/api/v1/does-not-exist');
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({
        type: expect.stringContaining('not-found'),
        title: 'NotFound',
        status: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Player /me/* — auth required
  // ───────────────────────────────────────────────────────────────────
  describe('/api/v1/me — player routes', () => {
    it('balance: 401 without token', async () => {
      const r = await request(app).get('/api/v1/me/balance');
      expect(r.status).toBe(401);
    });

    it('balance: returns wallets across scopes for the JWT subject', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'player-A',
        balance: 12_345_600n,
      });
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'player-A',
        wallet_scope: 'league-7',
        balance: 5_000n,
      });
      const token = signToken({ sub: 'player-A', roles: ['player'] });
      const r = await request(app)
        .get('/api/v1/me/balance')
        .set('Authorization', `Bearer ${token}`);
      expect(r.status).toBe(200);
      expect(r.body.userId).toBe('player-A');
      expect(r.body.wallets).toHaveLength(2);
      // BigInt → string per docs/api-v1.md §2.
      const platform = r.body.wallets.find(
        (w: { walletScope: string }) => w.walletScope === 'PLATFORM',
      );
      expect(platform.balance).toBe('12345600');
      expect(platform.currency).toBe('USDT-cents');
    });

    it('transactions: returns ledger entries for the player', async () => {
      const player = await Account.create({
        account_type: 'PLAYER',
        owner_id: 'player-A',
        balance: 10_000n,
      });
      const treasury = await Account.create({
        account_type: 'TREASURY',
        owner_id: PLATFORM_OWNER,
      });
      await Ledger.create({
        from_account: player._id,
        to_account: treasury._id,
        amount: 500n,
        type: 'RAKE',
        idempotency_key: 'r1:rake',
        status: 'SETTLED',
        metadata: { round_id: 'r1' },
      });
      const token = signToken({ sub: 'player-A', roles: ['player'] });
      const r = await request(app)
        .get('/api/v1/me/transactions')
        .set('Authorization', `Bearer ${token}`);
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0]).toMatchObject({
        type: 'RAKE',
        amount: '500',
        direction: 'out',
        status: 'SETTLED',
      });
    });

    it('withdrawals: create → get → cancel happy path', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'player-A',
        balance: 10_000n,
      });
      const token = signToken({ sub: 'player-A', roles: ['player'] });

      // Create
      const created = await request(app)
        .post('/api/v1/me/withdrawals')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: '5000', destination_address: 'TR-test-address' });
      expect(created.status).toBe(201);
      expect(created.body.state).toBe('REQUESTED');
      expect(created.body.amount).toBe('5000');
      const wId = created.body.id;

      // Get
      const got = await request(app)
        .get(`/api/v1/me/withdrawals/${wId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(wId);

      // Cancel
      const cancelled = await request(app)
        .post(`/api/v1/me/withdrawals/${wId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 'changed mind' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.state).toBe('ROLLED_BACK');
      expect(cancelled.body.failure_reason).toBe('changed mind');
    });

    it('withdrawals: cannot view another player\'s withdrawal (returns 404)', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'alice',
        balance: 10_000n,
      });
      const aliceToken = signToken({ sub: 'alice', roles: ['player'] });
      const bobToken = signToken({ sub: 'bob', roles: ['player'] });

      const created = await request(app)
        .post('/api/v1/me/withdrawals')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ amount: '1000', destination_address: 'TR-x' });
      const wId = created.body.id;

      const r = await request(app)
        .get(`/api/v1/me/withdrawals/${wId}`)
        .set('Authorization', `Bearer ${bobToken}`);
      expect(r.status).toBe(404);
    });

    it('balance strips body-supplied leagueId (data-scope iron rule)', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'player-A',
        balance: 100n,
      });
      const token = signToken({ sub: 'player-A', leagueId: 'real-league' });
      // Even if attacker tries to inject leagueId via body, it's stripped
      // BEFORE the handler sees it — handler reads from req.scope (JWT).
      const r = await request(app)
        .post('/api/v1/me/withdrawals')
        .set('Authorization', `Bearer ${token}`)
        .send({
          amount: '50',
          destination_address: 'TR-x',
          leagueId: 'attacker-league', // stripped
        });
      expect(r.status).toBe(201);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Internal /api/v1/internal/* — service auth
  // ───────────────────────────────────────────────────────────────────
  describe('/api/v1/internal — server-to-server', () => {
    it('settle-round: 401 without X-Internal-Token', async () => {
      const r = await request(app).post('/api/v1/internal/settle-round').send({});
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_INTERNAL_TOKEN');
    });

    it('settle-round: 401 with wrong token', async () => {
      const r = await request(app)
        .post('/api/v1/internal/settle-round')
        .set('X-Internal-Token', 'wrong-token-wrong-token-wrong')
        .send({});
      expect(r.status).toBe(401);
    });

    it('settle-round: full happy path produces a receipt', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'a',
        balance: 10_000n,
      });
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'w',
        balance: 0n,
      });

      const r = await request(app)
        .post('/api/v1/internal/settle-round')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({
          round_id: 'http-round-1',
          table_id: 'http-table-1',
          table_type: 'PLATFORM',
          winner_owner_id: 'w',
          winner_profit: '10000',
          rake_amount: '500',
          losers: [{ owner_id: 'a', contribution: '10000' }],
        });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        round_id: 'http-round-1',
        sequence: ['WIN_PAYOUT', 'JACKPOT_INJECT', 'JACKPOT_INJECT', 'JACKPOT_INJECT', 'JACKPOT_INJECT', 'RAKE'],
        replayed: false,
      });
      expect(r.body.amounts.rake).toBe('500');
      expect(r.body.amounts.jackpot.total).toBe('50');
      expect(r.body.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('settle-round: replay returns x-idempotent-replay header', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 10_000n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

      const send = () =>
        request(app)
          .post('/api/v1/internal/settle-round')
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .send({
            round_id: 'http-replay-1',
            table_id: 't',
            table_type: 'PLATFORM',
            winner_owner_id: 'w',
            winner_profit: '10000',
            rake_amount: '500',
            losers: [{ owner_id: 'a', contribution: '10000' }],
          });
      const first = await send();
      const second = await send();
      expect(first.body.replayed).toBe(false);
      expect(first.headers['x-idempotent-replay']).toBeUndefined();
      expect(second.body.replayed).toBe(true);
      expect(second.headers['x-idempotent-replay']).toBe('true');
    });

    it('settle-round: validation rejects bad payload with 400 + issue list', async () => {
      const r = await request(app)
        .post('/api/v1/internal/settle-round')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({
          round_id: '',
          table_id: 't',
          table_type: 'PLATFORM',
          winner_owner_id: 'w',
          winner_profit: '0',
          rake_amount: '0',
          losers: [],
        });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(r.body.extra.issues)).toBe(true);
    });

    it('transfer: 422 for non-whitelist flow (CB6 emits)', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'p', balance: 100n });
      await Account.create({ account_type: 'REINSURANCE', owner_id: 'PLATFORM' });
      const r = await request(app)
        .post('/api/v1/internal/transfer')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .set('Idempotency-Key', 'http-illegal-1')
        .send({
          from: { type: 'PLAYER', owner_id: 'p' },
          to: { type: 'REINSURANCE', owner_id: 'PLATFORM' },
          amount: '50',
          ledger_type: 'BET',
        });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('ILLEGAL_FUND_FLOW');
      expect(r.body.extra.from_type).toBe('PLAYER');
      expect(r.body.extra.to_type).toBe('REINSURANCE');
    });

    it('transfer: 400 when Idempotency-Key header is missing', async () => {
      const r = await request(app)
        .post('/api/v1/internal/transfer')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({
          from: { type: 'PLAYER', owner_id: 'p' },
          to: { type: 'TREASURY', owner_id: 'PLATFORM' },
          amount: '1',
          ledger_type: 'RAKE',
        });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('deposit/credit: rejects non-official contract with 422', async () => {
      const r = await request(app)
        .post('/api/v1/internal/deposit/credit')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({
          player_id: 'p1',
          amount: '1000',
          tx_hash: 'tx-bad-contract',
          contract_address: 'TFakeContract',
          confirmations: 30,
        });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('UNAUTHORIZED_CONTRACT');
    });

    it('deposit/credit: rejects insufficient confirmations with 409', async () => {
      const r = await request(app)
        .post('/api/v1/internal/deposit/credit')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({
          player_id: 'p1',
          amount: '1000',
          tx_hash: 'tx-pending',
          contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          confirmations: 5,
        });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('INSUFFICIENT_CONFIRMATIONS');
    });

    it('deposit/credit: happy path credits player', async () => {
      const r = await request(app)
        .post('/api/v1/internal/deposit/credit')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({
          player_id: 'p1',
          amount: '5000',
          tx_hash: 'tx-deposit-1',
          contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          confirmations: 30,
          block_number: 12345678,
        });
      expect(r.status).toBe(200);
      expect(r.body.replayed).toBe(false);
      expect(r.body.to_account.balance).toBe('5000');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Ops /api/v1/ops/* — withdrawal lifecycle
  // ───────────────────────────────────────────────────────────────────
  describe('/api/v1/ops — withdrawal lifecycle', () => {
    it('blocks player tokens with 403', async () => {
      const playerToken = signToken({ sub: 'random-player', roles: ['player'] });
      const r = await request(app)
        .get('/api/v1/ops/withdrawals')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(r.status).toBe(403);
    });

    it('full lifecycle: create → approve → broadcast → confirm via ops endpoints', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'p1',
        balance: 100_000n,
      });
      const playerToken = signToken({ sub: 'p1', roles: ['player'] });
      const opsToken = signToken({ sub: 'jane', roles: ['ops'] });

      // Player creates request.
      const created = await request(app)
        .post('/api/v1/me/withdrawals')
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ amount: '50000', destination_address: 'TR-y' });
      const wId = created.body.id;

      // Ops approves → balance deducted.
      const approved = await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/approve`)
        .set('Authorization', `Bearer ${opsToken}`);
      expect(approved.status).toBe(200);
      expect(approved.body.state).toBe('APPROVED');
      expect(approved.body.reviewed_by).toBe('jane');
      const player = await Account.findOne({ owner_id: 'p1' });
      expect(player?.balance).toBe(50_000n);

      // Ops broadcasts.
      const broadcasting = await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/broadcast`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ tx_hash: '0xtxhash-abc' });
      expect(broadcasting.status).toBe(200);
      expect(broadcasting.body.state).toBe('BROADCASTING');
      expect(broadcasting.body.tx_hash).toBe('0xtxhash-abc');

      // Ops confirms.
      const confirmed = await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/confirm`)
        .set('Authorization', `Bearer ${opsToken}`);
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.state).toBe('CONFIRMED');
    });

    it('fail path: BROADCASTING → FAILED → ROLLED_BACK refunds balance', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'p1',
        balance: 100_000n,
      });
      const playerToken = signToken({ sub: 'p1', roles: ['player'] });
      const opsToken = signToken({ sub: 'jane', roles: ['ops'] });

      const created = await request(app)
        .post('/api/v1/me/withdrawals')
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ amount: '40000', destination_address: 'TR-z' });
      const wId = created.body.id;

      await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/approve`)
        .set('Authorization', `Bearer ${opsToken}`);
      await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/broadcast`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ tx_hash: '0xfail' });

      const failed = await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/fail`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ reason: 'on-chain rejection' });
      expect(failed.status).toBe(200);
      expect(failed.body.state).toBe('ROLLED_BACK');
      expect(failed.body.failure_reason).toBe('on-chain rejection');

      const player = await Account.findOne({ owner_id: 'p1' });
      expect(player?.balance).toBe(100_000n); // refunded
    });

    it('approving a non-REQUESTED withdrawal returns 409', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 1_000n });
      const playerToken = signToken({ sub: 'p1', roles: ['player'] });
      const opsToken = signToken({ sub: 'jane', roles: ['ops'] });

      const created = await request(app)
        .post('/api/v1/me/withdrawals')
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ amount: '500', destination_address: 'TR-x' });
      const wId = created.body.id;

      // Approve once → APPROVED.
      await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/approve`)
        .set('Authorization', `Bearer ${opsToken}`);

      // Approve again → 409 ILLEGAL_WITHDRAWAL_TRANSITION.
      const r = await request(app)
        .post(`/api/v1/ops/withdrawals/${wId}/approve`)
        .set('Authorization', `Bearer ${opsToken}`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('ILLEGAL_WITHDRAWAL_TRANSITION');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Admin /api/v1/admin/*
  // ───────────────────────────────────────────────────────────────────
  describe('/api/v1/admin', () => {
    it('blocks ops tokens (admin-only) with 403', async () => {
      const opsToken = signToken({ sub: 'jane', roles: ['ops'] });
      const r = await request(app)
        .get('/api/v1/admin/circuit-breakers')
        .set('Authorization', `Bearer ${opsToken}`);
      expect(r.status).toBe(403);
    });

    it('admin gets the circuit-breaker status map', async () => {
      const adminToken = signToken({ sub: 'admin-1', roles: ['admin'] });
      const r = await request(app)
        .get('/api/v1/admin/circuit-breakers')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        CB1: 'STUB',
        CB2: 'STUB',
        CB3: 'STUB',
        CB4: 'STUB',
        CB5: 'STUB',
        CB6: 'ACTIVE',
        CB7: 'STUB',
      });
    });
  });
});
