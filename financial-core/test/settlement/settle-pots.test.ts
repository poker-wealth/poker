import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { Account } from '../../src/wallet/account.model';
import { Ledger } from '../../src/wallet/ledger.model';
import { settlePots } from '../../src/settlement/settle-pots';

describe('settlement/settlePots — multi-winner (split / side pots)', () => {
  let rs: MongoMemoryReplSet;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
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

  async function balance(ownerId: string): Promise<bigint> {
    const a = await Account.findOne({ account_type: 'PLAYER', owner_id: ownerId });
    return a?.balance ?? 0n;
  }

  it('single winner via netDeltas behaves like settleRound', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'l1', balance: 5_000n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'l2', balance: 5_000n });

    const r = await settlePots({
      roundId: 'sp-1',
      tableId: 't1',
      tableType: 'PLATFORM',
      rakeAmount: 250n,
      netDeltas: [
        { ownerId: 'w', net: 10_000n },
        { ownerId: 'l1', net: -5_000n },
        { ownerId: 'l2', net: -5_000n },
      ],
    });

    expect(r.winners).toEqual(['w']);
    // Winner: +10000 gross, -250 rake, -50 jackpot (0.5% of 10000) = +9700.
    expect(await balance('w')).toBe(9_700n);
    expect(await balance('l1')).toBe(0n);
    expect(await balance('l2')).toBe(0n);
    const treasury = await Account.findOne({ account_type: 'TREASURY' });
    expect(treasury?.balance).toBe(250n);
    // Jackpot pools sum to 50 (0.5% of 10000).
    const jpTotal = (await Account.find({ account_type: { $regex: /^JACKPOT/ } })).reduce(
      (s, a) => s + a.balance,
      0n,
    );
    expect(jpTotal).toBe(50n);
  });

  it('split pot: two winners tie, each gets half (greedy match conserves chips)', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'w1', balance: 0n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'w2', balance: 0n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'l1', balance: 10_000n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'l2', balance: 10_000n });

    // Two losers forfeit 10k each (20k pot). Two winners split: +10k each.
    const r = await settlePots({
      roundId: 'sp-2',
      tableId: 't1',
      tableType: 'PLATFORM',
      rakeAmount: 0n,
      netDeltas: [
        { ownerId: 'w1', net: 10_000n },
        { ownerId: 'w2', net: 10_000n },
        { ownerId: 'l1', net: -10_000n },
        { ownerId: 'l2', net: -10_000n },
      ],
    });

    expect(r.winners.sort()).toEqual(['w1', 'w2']);
    // jackpot 0.5% of total winner profit (20000) = 100, paid by primary winner.
    // Both winners grossed 10000; primary (first, w1) pays the 100 jackpot.
    const w1 = await balance('w1');
    const w2 = await balance('w2');
    expect(w1 + w2).toBe(19_900n); // 20000 - 100 jackpot
    expect(await balance('l1')).toBe(0n);
    expect(await balance('l2')).toBe(0n);
    const jpTotal = (await Account.find({ account_type: { $regex: /^JACKPOT/ } })).reduce(
      (s, a) => s + a.balance,
      0n,
    );
    expect(jpTotal).toBe(100n);
  });

  it('side pot: short all-in winner + bigger side-pot winner', async () => {
    // a (short) net +3000, b net +4000, c net -7000. Conserves to 0.
    await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 0n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'b', balance: 0n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'c', balance: 7_000n });

    const r = await settlePots({
      roundId: 'sp-3',
      tableId: 't1',
      tableType: 'PLATFORM',
      rakeAmount: 100n,
      netDeltas: [
        { ownerId: 'a', net: 3_000n },
        { ownerId: 'b', net: 4_000n },
        { ownerId: 'c', net: -7_000n },
      ],
    });

    expect(r.winners.sort()).toEqual(['a', 'b']);
    // total winner profit 7000 → jackpot 0.5% = 35. primary = b (largest net 4000).
    // b pays rake 100 + jackpot 35 = 135. a untouched by house cut.
    expect(await balance('a')).toBe(3_000n);
    expect(await balance('b')).toBe(4_000n - 135n);
    expect(await balance('c')).toBe(0n);
    const treasury = await Account.findOne({ account_type: 'TREASURY' });
    expect(treasury?.balance).toBe(100n);
  });

  it('LEAGUE table routes rake to LEAGUE_INVENTORY', async () => {
    const scope = 'league-9';
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', wallet_scope: scope, balance: 0n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'l', wallet_scope: scope, balance: 5_000n });

    await settlePots({
      roundId: 'sp-4',
      tableId: 'lt',
      tableType: 'LEAGUE',
      leagueId: scope,
      rakeAmount: 200n,
      netDeltas: [
        { ownerId: 'w', net: 5_000n, walletScope: scope },
        { ownerId: 'l', net: -5_000n, walletScope: scope },
      ],
    });

    const treasury = await Account.findOne({ account_type: 'TREASURY' });
    const inv = await Account.findOne({ account_type: 'LEAGUE_INVENTORY', owner_id: scope });
    expect(treasury).toBeNull();
    expect(inv?.balance).toBe(200n);
  });

  it('idempotent: replaying the same round does not double-settle', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'l', balance: 5_000n });
    const input = {
      roundId: 'sp-idem',
      tableId: 't1',
      tableType: 'PLATFORM' as const,
      rakeAmount: 0n,
      netDeltas: [
        { ownerId: 'w', net: 5_000n },
        { ownerId: 'l', net: -5_000n },
      ],
    };
    const first = await settlePots(input);
    const second = await settlePots(input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(await balance('w')).toBe(4_975n); // 5000 - 25 jackpot, once
  });

  it('rejects net deltas that do not sum to zero', async () => {
    await expect(
      settlePots({
        roundId: 'bad',
        tableId: 't',
        tableType: 'PLATFORM',
        rakeAmount: 0n,
        netDeltas: [
          { ownerId: 'w', net: 5_000n },
          { ownerId: 'l', net: -4_000n },
        ],
      }),
    ).rejects.toThrow(/sum to 0/);
  });

  it('rejects when rake + jackpot exceed total winner profit', async () => {
    await expect(
      settlePots({
        roundId: 'bad2',
        tableId: 't',
        tableType: 'PLATFORM',
        rakeAmount: 10_000n, // more than the 5000 profit
        netDeltas: [
          { ownerId: 'w', net: 5_000n },
          { ownerId: 'l', net: -5_000n },
        ],
      }),
    ).rejects.toThrow(/exceeds total winner profit/);
  });
});
