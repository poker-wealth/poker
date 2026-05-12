import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { Account } from '../../src/wallet/account.model';
import { Ledger } from '../../src/wallet/ledger.model';
import { settlementEvents } from '../../src/settlement/events';
import { settleRound, type SettleRoundReceipt } from '../../src/settlement/settlement-engine';

describe('settlement/events — Phase 2 hook surface', () => {
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
    settlementEvents.removeAllListeners();
  });

  it('fires `settled` listener once after a successful round', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 1_000n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

    const seen: SettleRoundReceipt[] = [];
    settlementEvents.on('settled', (r) => {
      seen.push(r);
    });

    const receipt = await settleRound({
      roundId: 'evt-1',
      tableId: 't',
      tableType: 'PLATFORM',
      winnerOwnerId: 'w',
      winnerProfit: 1_000n,
      rakeAmount: 0n,
      losers: [{ ownerId: 'a', contribution: 1_000n }],
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(receipt);
    expect(seen[0]!.roundId).toBe('evt-1');
    expect(seen[0]!.replayed).toBe(false);
  });

  it('does NOT fire `settled` when validation rejects the round', async () => {
    const seen: SettleRoundReceipt[] = [];
    settlementEvents.on('settled', (r) => {
      seen.push(r);
    });

    await expect(
      settleRound({
        roundId: '',
        tableId: 't',
        tableType: 'PLATFORM',
        winnerOwnerId: 'w',
        winnerProfit: 0n,
        rakeAmount: 0n,
        losers: [{ ownerId: 'a', contribution: 1n }],
      }),
    ).rejects.toThrow(/roundId/);

    expect(seen).toHaveLength(0);
  });

  it('does NOT fire `settled` when the tx aborts (insufficient balance)', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 50n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

    const seen: SettleRoundReceipt[] = [];
    settlementEvents.on('settled', (r) => {
      seen.push(r);
    });

    await expect(
      settleRound({
        roundId: 'abort-1',
        tableId: 't',
        tableType: 'PLATFORM',
        winnerOwnerId: 'w',
        winnerProfit: 100n,
        rakeAmount: 0n,
        losers: [{ ownerId: 'a', contribution: 100n }], // exceeds balance 50
      }),
    ).rejects.toThrow(/InsufficientBalance/);

    expect(seen).toHaveLength(0);
  });

  it('fires `replayed` (not `settled`) when the round was already settled', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 1_000n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

    // First call: emits `settled`.
    await settleRound({
      roundId: 'replay-1',
      tableId: 't',
      tableType: 'PLATFORM',
      winnerOwnerId: 'w',
      winnerProfit: 1_000n,
      rakeAmount: 0n,
      losers: [{ ownerId: 'a', contribution: 1_000n }],
    });

    const settled: SettleRoundReceipt[] = [];
    const replayed: SettleRoundReceipt[] = [];
    settlementEvents.on('settled', (r) => settled.push(r));
    settlementEvents.on('replayed', (r) => replayed.push(r));

    // Second call: should be a replay.
    const r = await settleRound({
      roundId: 'replay-1',
      tableId: 't',
      tableType: 'PLATFORM',
      winnerOwnerId: 'w',
      winnerProfit: 1_000n,
      rakeAmount: 0n,
      losers: [{ ownerId: 'a', contribution: 1_000n }],
    });

    expect(r.replayed).toBe(true);
    expect(settled).toHaveLength(0);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.roundId).toBe('replay-1');
  });

  it('multiple listeners all receive the event (worker fanout pattern)', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 1_000n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

    let rakeWorkerCalls = 0;
    let jackpotWorkerCalls = 0;
    let solanaWorkerCalls = 0;
    settlementEvents.on('settled', () => rakeWorkerCalls++);
    settlementEvents.on('settled', () => jackpotWorkerCalls++);
    settlementEvents.on('settled', () => solanaWorkerCalls++);

    await settleRound({
      roundId: 'fanout-1',
      tableId: 't',
      tableType: 'PLATFORM',
      winnerOwnerId: 'w',
      winnerProfit: 1_000n,
      rakeAmount: 50n,
      losers: [{ ownerId: 'a', contribution: 1_000n }],
    });

    expect(rakeWorkerCalls).toBe(1);
    expect(jackpotWorkerCalls).toBe(1);
    expect(solanaWorkerCalls).toBe(1);
  });

  it('a throwing listener does not break the settleRound caller', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 1_000n });
    await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

    settlementEvents.on('settled', () => {
      throw new Error('listener crashed');
    });

    // settleRound should still succeed; the listener error is logged.
    const r = await settleRound({
      roundId: 'throw-1',
      tableId: 't',
      tableType: 'PLATFORM',
      winnerOwnerId: 'w',
      winnerProfit: 1_000n,
      rakeAmount: 0n,
      losers: [{ ownerId: 'a', contribution: 1_000n }],
    });
    expect(r.replayed).toBe(false);
    expect(r.roundId).toBe('throw-1');
  });
});
