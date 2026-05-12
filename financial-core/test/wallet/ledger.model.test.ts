import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { Ledger } from '../../src/wallet/ledger.model';
import { LEDGER_TYPES, LEDGER_STATUSES } from '../../src/domain/ledger-types';

describe('wallet/Ledger model', () => {
  let rs: MongoMemoryReplSet;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await connectDB(rs.getUri());
    await Ledger.syncIndexes();
  });

  afterAll(async () => {
    await disconnectDB();
    await rs.stop();
  });

  beforeEach(async () => {
    await Ledger.deleteMany({});
  });

  it('exports the 16 LedgerTypes the spec mandates', () => {
    expect(LEDGER_TYPES).toHaveLength(16);
    expect(LEDGER_TYPES).toEqual(
      expect.arrayContaining([
        'DEPOSIT',
        'WITHDRAW',
        'WITHDRAW_REFUND',
        'BET',
        'WIN_PAYOUT',
        'RAKE',
        'INSURANCE_PREMIUM',
        'INSURANCE_PAYOUT',
        'REINSURANCE_INJECT',
        'REINSURANCE_PAYOUT',
        'JACKPOT_INJECT',
        'JACKPOT_PAYOUT',
        'LEAGUE_TOPUP',
        'LEAGUE_CASHOUT',
        'AGENT_COMMISSION',
        'AGENT_VIP_BONUS',
      ]),
    );
  });

  it('exports the 4 ledger statuses', () => {
    expect(LEDGER_STATUSES).toEqual(['PENDING', 'SETTLED', 'FAILED', 'ROLLED_BACK']);
  });

  it('creates a SETTLED RAKE entry between two accounts', async () => {
    const e = await Ledger.create({
      from_account: 'acc-loser',
      to_account: 'acc-treasury',
      amount: 500n, // $5.00 in cents
      type: 'RAKE',
      idempotency_key: 'round-1:rake',
      status: 'SETTLED',
      metadata: { round_id: 'round-1', table_id: 'table-7' },
    });
    expect(e._id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.amount).toBe(500n);
    expect(e.status).toBe('SETTLED');
    expect(e.metadata).toEqual({ round_id: 'round-1', table_id: 'table-7' });
  });

  it('rejects amount = 0 and amount < 0 (direction is encoded by from/to)', async () => {
    await expect(
      Ledger.create({
        from_account: 'a',
        to_account: 'b',
        amount: 0n,
        type: 'BET',
        idempotency_key: 'k1',
      }),
    ).rejects.toThrow(/positive/);
    await expect(
      Ledger.create({
        from_account: 'a',
        to_account: 'b',
        amount: -100n,
        type: 'BET',
        idempotency_key: 'k2',
      }),
    ).rejects.toThrow(/positive/);
  });

  it('rejects unknown ledger type', async () => {
    await expect(
      Ledger.create({
        from_account: 'a',
        to_account: 'b',
        amount: 1n,
        type: 'BOGUS' as 'BET',
        idempotency_key: 'k3',
      }),
    ).rejects.toThrow(/invalid ledger type/);
  });

  it('idempotency_key is unique — duplicate insert is rejected', async () => {
    await Ledger.create({
      from_account: 'a',
      to_account: 'b',
      amount: 100n,
      type: 'BET',
      idempotency_key: 'duplicate-key',
    });
    await expect(
      Ledger.create({
        from_account: 'c',
        to_account: 'd',
        amount: 200n,
        type: 'WIN_PAYOUT',
        idempotency_key: 'duplicate-key',
      }),
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it('DEPOSIT requires from_account=null and a to_account', async () => {
    const ok = await Ledger.create({
      from_account: null,
      to_account: 'player-acc',
      amount: 1_000_000n,
      type: 'DEPOSIT',
      idempotency_key: 'tx-hash-1',
      status: 'SETTLED',
      metadata: { tx_hash: '0xabc', confirmations: 20 },
    });
    expect(ok.from_account).toBeNull();
    expect(ok.to_account).toBe('player-acc');

    await expect(
      Ledger.create({
        from_account: 'something',
        to_account: 'player-acc',
        amount: 100n,
        type: 'DEPOSIT',
        idempotency_key: 'tx-hash-2',
      }),
    ).rejects.toThrow(/boundary inflow/);

    await expect(
      Ledger.create({
        from_account: null,
        to_account: null,
        amount: 100n,
        type: 'DEPOSIT',
        idempotency_key: 'tx-hash-3',
      }),
    ).rejects.toThrow(/requires to_account/);
  });

  it('WITHDRAW requires from_account and to_account=null', async () => {
    const ok = await Ledger.create({
      from_account: 'player-acc',
      to_account: null,
      amount: 5_000_00n,
      type: 'WITHDRAW',
      idempotency_key: 'wd-1',
      status: 'PENDING',
    });
    expect(ok.from_account).toBe('player-acc');
    expect(ok.to_account).toBeNull();

    await expect(
      Ledger.create({
        from_account: 'player-acc',
        to_account: 'somewhere',
        amount: 100n,
        type: 'WITHDRAW',
        idempotency_key: 'wd-2',
      }),
    ).rejects.toThrow(/boundary outflow/);
  });

  it('internal types require both from_account and to_account, and they must differ', async () => {
    await expect(
      Ledger.create({
        from_account: null,
        to_account: 'b',
        amount: 1n,
        type: 'RAKE',
        idempotency_key: 'r1',
      }),
    ).rejects.toThrow(/requires both/);
    await expect(
      Ledger.create({
        from_account: 'same',
        to_account: 'same',
        amount: 1n,
        type: 'RAKE',
        idempotency_key: 'r2',
      }),
    ).rejects.toThrow(/must differ/);
  });

  it('persists very large BigInt amounts and metadata roundtrip', async () => {
    const huge = 1_234_567_890_123_456n;
    const meta = {
      round_id: 'r-99',
      table_id: 'table-12',
      tx_hash: '0xdeadbeef',
      pool_split: { mini: 20, minor: 30, major: 25, grand: 25 },
    };
    await Ledger.create({
      from_account: 'src',
      to_account: 'dst',
      amount: huge,
      type: 'JACKPOT_INJECT',
      idempotency_key: 'big-roundtrip',
      status: 'SETTLED',
      metadata: meta,
    });
    const found = await Ledger.findOne({ idempotency_key: 'big-roundtrip' });
    expect(typeof found?.amount).toBe('bigint');
    expect(found?.amount).toBe(huge);
    expect(found?.metadata).toEqual(meta);
  });

  it('all 16 ledger types are valid (with appropriate from/to direction)', async () => {
    let counter = 0;
    const insert = async (type: (typeof LEDGER_TYPES)[number]) => {
      const key = `t-${counter++}`;
      const isInflow = type === 'DEPOSIT' || type === 'WITHDRAW_REFUND';
      const isOutflow = type === 'WITHDRAW';
      await Ledger.create({
        from_account: isInflow ? null : `from-${key}`,
        to_account: isOutflow ? null : `to-${key}`,
        amount: 100n,
        type,
        idempotency_key: key,
        status: 'SETTLED',
      });
    };
    for (const t of LEDGER_TYPES) await insert(t);
    expect(await Ledger.countDocuments()).toBe(16);
  });
});
