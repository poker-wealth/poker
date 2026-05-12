import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { Account } from '../../src/wallet/account.model';
import {
  ACCOUNT_TYPES,
  type AccountType,
  PLATFORM_OWNER,
} from '../../src/domain/account-types';

describe('wallet/Account model', () => {
  let rs: MongoMemoryReplSet;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await connectDB(rs.getUri());
    await Account.syncIndexes();
  });

  afterAll(async () => {
    await disconnectDB();
    await rs.stop();
  });

  beforeEach(async () => {
    await Account.deleteMany({});
  });

  it('exports exactly the 9 account types from spec §3.1', () => {
    expect(ACCOUNT_TYPES).toEqual([
      'PLAYER',
      'TREASURY',
      'INSURANCE',
      'REINSURANCE',
      'LEAGUE_INVENTORY',
      'JACKPOT_MINI',
      'JACKPOT_MINOR',
      'JACKPOT_MAJOR',
      'JACKPOT_GRAND',
    ]);
  });

  it('creates account with auto UUID v7 _id, default zero balance, version 0, scope PLATFORM', async () => {
    const a = await Account.create({ account_type: 'PLAYER', owner_id: 'player-1' });
    expect(a._id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.balance).toBe(0n);
    expect(a.version).toBe(0);
    expect(a.wallet_scope).toBe(PLATFORM_OWNER);
    expect(a.created_at).toBeInstanceOf(Date);
    expect(a.updated_at).toBeInstanceOf(Date);
  });

  it('rejects an unknown account_type', async () => {
    await expect(
      Account.create({ account_type: 'BOGUS' as AccountType, owner_id: 'x' }),
    ).rejects.toThrow(/invalid account_type/);
  });

  it('rejects a negative balance', async () => {
    await expect(
      Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: -1n }),
    ).rejects.toThrow(/non-negative/);
  });

  it('TREASURY owner_id must be PLATFORM', async () => {
    await expect(
      Account.create({ account_type: 'TREASURY', owner_id: 'someone-else' }),
    ).rejects.toThrow(/PLATFORM/);
    const ok = await Account.create({ account_type: 'TREASURY', owner_id: PLATFORM_OWNER });
    expect(ok.account_type).toBe('TREASURY');
  });

  it('LEAGUE_INVENTORY owner_id cannot be PLATFORM', async () => {
    await expect(
      Account.create({ account_type: 'LEAGUE_INVENTORY', owner_id: PLATFORM_OWNER }),
    ).rejects.toThrow(/leagueId/);
    const ok = await Account.create({ account_type: 'LEAGUE_INVENTORY', owner_id: 'league-1' });
    expect(ok.account_type).toBe('LEAGUE_INVENTORY');
  });

  it('enforces unique natural key (account_type, owner_id, wallet_scope)', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1' });
    await expect(
      Account.create({ account_type: 'PLAYER', owner_id: 'p1' }),
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it('PLAYER may have separate Platform and per-League wallets via wallet_scope', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1' });
    await Account.create({
      account_type: 'PLAYER',
      owner_id: 'p1',
      wallet_scope: 'league-A',
    });
    await Account.create({
      account_type: 'PLAYER',
      owner_id: 'p1',
      wallet_scope: 'league-B',
    });
    const all = await Account.find({ account_type: 'PLAYER', owner_id: 'p1' });
    expect(all).toHaveLength(3);
    expect(all.map((a) => a.wallet_scope).sort()).toEqual(['PLATFORM', 'league-A', 'league-B']);
  });

  it('persists BigInt balance through roundtrip without precision loss', async () => {
    const huge = 999_999_999_999_999n; // ~$10 trillion in cents
    const a = await Account.create({ account_type: 'PLAYER', owner_id: 'p2', balance: huge });
    const loaded = await Account.findById(a._id);
    expect(typeof loaded?.balance).toBe('bigint');
    expect(loaded?.balance).toBe(huge);
  });

  it('all 9 account types are creatable with valid owner_ids', async () => {
    const samples: ReadonlyArray<readonly [AccountType, string]> = [
      ['PLAYER', 'p1'],
      ['TREASURY', PLATFORM_OWNER],
      ['INSURANCE', PLATFORM_OWNER],
      ['REINSURANCE', PLATFORM_OWNER],
      ['LEAGUE_INVENTORY', 'league-1'],
      ['JACKPOT_MINI', 'table-1'],
      ['JACKPOT_MINOR', 'table-1'],
      ['JACKPOT_MAJOR', 'table-1'],
      ['JACKPOT_GRAND', 'table-1'],
    ];
    for (const [type, owner] of samples) {
      await Account.create({ account_type: type, owner_id: owner });
    }
    expect(await Account.countDocuments()).toBe(9);
  });

  it('account_type and owner_id are immutable post-create', async () => {
    const a = await Account.create({ account_type: 'PLAYER', owner_id: 'p1' });
    a.account_type = 'TREASURY';
    a.owner_id = 'PLATFORM';
    await a.save();
    const reloaded = await Account.findById(a._id);
    expect(reloaded?.account_type).toBe('PLAYER');
    expect(reloaded?.owner_id).toBe('p1');
  });
});
