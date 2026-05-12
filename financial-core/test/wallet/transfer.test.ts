import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { IllegalFundFlowError } from '../../src/clearing/clearing-rules';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { PLATFORM_OWNER } from '../../src/domain/account-types';
import { Account } from '../../src/wallet/account.model';
import { AccountNotFoundError, InsufficientBalanceError } from '../../src/wallet/errors';
import { Ledger } from '../../src/wallet/ledger.model';
import { transfer } from '../../src/wallet/transfer';

describe('wallet/transfer', () => {
  let rs: MongoMemoryReplSet;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await connectDB(rs.getUri());
    await Account.syncIndexes();
    await Ledger.syncIndexes();
  });

  afterAll(async () => {
    await disconnectDB();
    await rs.stop();
  });

  beforeEach(async () => {
    await Account.deleteMany({});
    await Ledger.deleteMany({});
  });

  // ───────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────

  it('moves money internally PLAYER -> TREASURY (RAKE) and writes ledger', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });
    await Account.create({ account_type: 'TREASURY', owner_id: PLATFORM_OWNER });

    const r = await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
      amount: 1_000n,
      ledgerType: 'RAKE',
      idempotencyKey: 'round-1:rake',
      metadata: { round_id: 'round-1' },
    });

    expect(r.replayed).toBe(false);
    expect(r.retries).toBe(0);
    expect(r.fromAccount?.balance).toBe(9_000n);
    expect(r.toAccount?.balance).toBe(1_000n);
    expect(r.fromAccount?.version).toBe(1);
    expect(r.toAccount?.version).toBe(1);
    expect(r.ledgerEntry.amount).toBe(1_000n);
    expect(r.ledgerEntry.type).toBe('RAKE');
    expect(r.ledgerEntry.status).toBe('SETTLED');
    expect(r.ledgerEntry.metadata).toEqual({ round_id: 'round-1' });
  });

  it('upserts the to-account on first contact', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 5_000n });
    expect(await Account.countDocuments({ account_type: 'JACKPOT_MINI' })).toBe(0);

    const r = await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      to: { type: 'JACKPOT_MINI', ownerId: 'table-7' },
      amount: 100n,
      ledgerType: 'JACKPOT_INJECT',
      idempotencyKey: 'inject-1',
    });

    expect(r.toAccount).toBeTruthy();
    expect(r.toAccount?.balance).toBe(100n);
    const created = await Account.findOne({ account_type: 'JACKPOT_MINI', owner_id: 'table-7' });
    expect(created?._id).toBe(r.toAccount?._id);
  });

  // ───────────────────────────────────────────────────────────────────
  // Inflows / outflows
  // ───────────────────────────────────────────────────────────────────

  it('handles DEPOSIT (inflow) — to-only, upserts player account', async () => {
    const r = await transfer({
      to: { type: 'PLAYER', ownerId: 'p-new' },
      amount: 50_000n,
      ledgerType: 'DEPOSIT',
      idempotencyKey: 'tx-hash-deposit',
      metadata: { tx_hash: '0xabc', confirmations: 20 },
    });
    expect(r.fromAccount).toBeNull();
    expect(r.toAccount?.balance).toBe(50_000n);
    expect(r.ledgerEntry.from_account).toBeNull();
    expect(r.ledgerEntry.to_account).toBe(r.toAccount?._id);
  });

  it('handles WITHDRAW (outflow) — from-only, decrements player balance', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });
    const r = await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      amount: 3_000n,
      ledgerType: 'WITHDRAW',
      idempotencyKey: 'wd-1',
      status: 'PENDING',
    });
    expect(r.toAccount).toBeNull();
    expect(r.fromAccount?.balance).toBe(7_000n);
    expect(r.ledgerEntry.status).toBe('PENDING');
    expect(r.ledgerEntry.to_account).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────
  // ClearingRules enforcement
  // ───────────────────────────────────────────────────────────────────

  it('rejects non-whitelist flow PLAYER -> REINSURANCE with IllegalFundFlowError (no balance change)', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });
    await Account.create({ account_type: 'REINSURANCE', owner_id: PLATFORM_OWNER });

    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'REINSURANCE', ownerId: PLATFORM_OWNER },
        amount: 100n,
        ledgerType: 'BET',
        idempotencyKey: 'illegal-1',
      }),
    ).rejects.toBeInstanceOf(IllegalFundFlowError);

    const player = await Account.findOne({ account_type: 'PLAYER', owner_id: 'p1' });
    const reins = await Account.findOne({ account_type: 'REINSURANCE' });
    expect(player?.balance).toBe(10_000n);
    expect(reins?.balance).toBe(0n);
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it('rejects JACKPOT -> TREASURY (out-only invariant)', async () => {
    await Account.create({ account_type: 'JACKPOT_GRAND', owner_id: 'table-1', balance: 5_000n });
    await Account.create({ account_type: 'TREASURY', owner_id: PLATFORM_OWNER });
    await expect(
      transfer({
        from: { type: 'JACKPOT_GRAND', ownerId: 'table-1' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: 100n,
        ledgerType: 'WIN_PAYOUT',
        idempotencyKey: 'jp-misappropriation',
      }),
    ).rejects.toBeInstanceOf(IllegalFundFlowError);
  });

  // ───────────────────────────────────────────────────────────────────
  // Insufficient balance / not-found
  // ───────────────────────────────────────────────────────────────────

  it('rejects with InsufficientBalanceError when from-account lacks funds (no partial mutation)', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 50n });
    await Account.create({ account_type: 'TREASURY', owner_id: PLATFORM_OWNER });

    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: 100n,
        ledgerType: 'RAKE',
        idempotencyKey: 'insufficient-1',
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    expect((await Account.findOne({ account_type: 'PLAYER' }))?.balance).toBe(50n);
    expect((await Account.findOne({ account_type: 'TREASURY' }))?.balance).toBe(0n);
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it('rejects with AccountNotFoundError when from-account does not exist', async () => {
    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'ghost' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: 1n,
        ledgerType: 'RAKE',
        idempotencyKey: 'ghost-1',
      }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  // ───────────────────────────────────────────────────────────────────
  // Idempotency
  // ───────────────────────────────────────────────────────────────────

  it('idempotent replay: same key called twice → second returns replayed=true with no balance change', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });

    const first = await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
      amount: 1_000n,
      ledgerType: 'RAKE',
      idempotencyKey: 'idem-1',
    });
    const second = await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
      amount: 1_000n,
      ledgerType: 'RAKE',
      idempotencyKey: 'idem-1',
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.ledgerEntry._id).toBe(first.ledgerEntry._id);

    // Balance moved exactly once.
    expect((await Account.findOne({ account_type: 'PLAYER' }))?.balance).toBe(9_000n);
    expect((await Account.findOne({ account_type: 'TREASURY' }))?.balance).toBe(1_000n);
    expect(await Ledger.countDocuments({ idempotency_key: 'idem-1' })).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────
  // Atomicity / consistency
  // ───────────────────────────────────────────────────────────────────

  it('balance never goes negative under sequential transfers', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100n });
    await Account.create({ account_type: 'TREASURY', owner_id: PLATFORM_OWNER });

    await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
      amount: 60n,
      ledgerType: 'RAKE',
      idempotencyKey: 's-1',
    });
    await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
      amount: 30n,
      ledgerType: 'RAKE',
      idempotencyKey: 's-2',
    });
    // Third one would overdraft.
    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: 50n,
        ledgerType: 'RAKE',
        idempotencyKey: 's-3',
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    expect((await Account.findOne({ account_type: 'PLAYER' }))?.balance).toBe(10n);
    expect((await Account.findOne({ account_type: 'TREASURY' }))?.balance).toBe(90n);
  });

  it('sum of ledger flows reconciles to account balance changes', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 1_000n });
    await Account.create({ account_type: 'TREASURY', owner_id: PLATFORM_OWNER, balance: 500n });

    for (let i = 0; i < 5; i++) {
      await transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: 100n,
        ledgerType: 'RAKE',
        idempotencyKey: `recon-${i}`,
      });
    }

    const player = await Account.findOne({ account_type: 'PLAYER' });
    const treasury = await Account.findOne({ account_type: 'TREASURY' });
    expect(player?.balance).toBe(500n);
    expect(treasury?.balance).toBe(1_000n);

    // Sum of ledger should equal net change for each account.
    const entries = await Ledger.find({ status: 'SETTLED' });
    let playerNet = 0n;
    let treasuryNet = 0n;
    for (const e of entries) {
      if (e.from_account === player?._id) playerNet -= e.amount;
      if (e.to_account === player?._id) playerNet += e.amount;
      if (e.from_account === treasury?._id) treasuryNet -= e.amount;
      if (e.to_account === treasury?._id) treasuryNet += e.amount;
    }
    expect(playerNet).toBe(-500n);
    expect(treasuryNet).toBe(500n);
  });

  // ───────────────────────────────────────────────────────────────────
  // Input validation
  // ───────────────────────────────────────────────────────────────────

  it('rejects amount <= 0', async () => {
    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: 0n,
        ledgerType: 'RAKE',
        idempotencyKey: 'amt-0',
      }),
    ).rejects.toThrow(/positive BigInt/);
    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: -10n,
        ledgerType: 'RAKE',
        idempotencyKey: 'amt-neg',
      }),
    ).rejects.toThrow(/positive BigInt/);
  });

  it('rejects empty idempotencyKey', async () => {
    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'TREASURY', ownerId: PLATFORM_OWNER },
        amount: 1n,
        ledgerType: 'RAKE',
        idempotencyKey: '',
      }),
    ).rejects.toThrow(/idempotencyKey/);
  });

  it('rejects invalid owner_id shape per account_type before touching DB', async () => {
    await expect(
      transfer({
        from: { type: 'TREASURY', ownerId: 'not-platform' }, // must be PLATFORM
        to: { type: 'PLAYER', ownerId: 'p1' },
        amount: 1n,
        ledgerType: 'AGENT_COMMISSION',
        idempotencyKey: 'bad-owner',
      }),
    ).rejects.toThrow(/PLATFORM/);
  });
});
