import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { Account } from '../../src/wallet/account.model';
import { Ledger } from '../../src/wallet/ledger.model';
import {
  computeJackpot,
  settleRound,
} from '../../src/settlement/settlement-engine';

describe('settlement/SettlementEngine — Phase 1', () => {
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
  // computeJackpot — pure function
  // ───────────────────────────────────────────────────────────────────
  describe('computeJackpot', () => {
    it('0.5% of winner profit split 20/30/25/25 with remainder to GRAND', () => {
      const r = computeJackpot(1_000_00n); // $1000 in cents
      // total = 1000_00 * 5 / 1000 = 500 cents = $5.00
      expect(r.total).toBe(500n);
      expect(r.mini).toBe(100n); //  20%
      expect(r.minor).toBe(150n); // 30%
      expect(r.major).toBe(125n); // 25%
      expect(r.grand).toBe(125n); // 25% (remainder)
      expect(r.mini + r.minor + r.major + r.grand).toBe(r.total);
    });

    it('rounding cents accrue to GRAND tier', () => {
      // Winner profit that produces a non-round jackpot total
      const r = computeJackpot(333n); // 333 * 5 / 1000 = 1 cent (integer floor)
      expect(r.total).toBe(1n);
      expect(r.mini).toBe(0n);
      expect(r.minor).toBe(0n);
      expect(r.major).toBe(0n);
      expect(r.grand).toBe(1n);
    });

    it('zero profit produces zero jackpot', () => {
      const r = computeJackpot(0n);
      expect(r.total).toBe(0n);
      expect(r.mini + r.minor + r.major + r.grand).toBe(0n);
    });

    it('rejects negative winnerProfit', () => {
      expect(() => computeJackpot(-1n)).toThrow(/>= 0/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Happy path
  // ───────────────────────────────────────────────────────────────────
  describe('heads-up PLATFORM table', () => {
    it('routes payout + jackpot + rake correctly', async () => {
      // Setup: loser has $100, winner has $0. Winner profit = $100.
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'alice',
        balance: 10_000n,
      });
      await Account.create({ account_type: 'PLAYER', owner_id: 'bob', balance: 0n });

      const receipt = await settleRound({
        roundId: 'round-1',
        tableId: 'table-1',
        tableType: 'PLATFORM',
        winnerOwnerId: 'bob',
        winnerProfit: 10_000n,
        rakeAmount: 500n, // $5 rake
        losers: [{ ownerId: 'alice', contribution: 10_000n }],
      });

      expect(receipt.replayed).toBe(false);
      expect(receipt.sequence).toEqual([
        'WIN_PAYOUT',
        'JACKPOT_INJECT',
        'JACKPOT_INJECT',
        'JACKPOT_INJECT',
        'JACKPOT_INJECT',
        'RAKE',
      ]);
      expect(receipt.amounts.payouts).toEqual([10_000n]);
      expect(receipt.amounts.rake).toBe(500n);
      expect(receipt.amounts.jackpot.total).toBe(50n); // 0.5% of 10000
      expect(receipt.amounts.jackpot.mini).toBe(10n);
      expect(receipt.amounts.jackpot.minor).toBe(15n);
      expect(receipt.amounts.jackpot.major).toBe(12n);
      // 50 - 10 - 15 - 12 = 13 → grand
      expect(receipt.amounts.jackpot.grand).toBe(13n);
      expect(receipt.hash).toMatch(/^[0-9a-f]{64}$/);

      // Balance check: alice 0, bob 10000 - 500 (rake) - 50 (jackpot) = 9450
      const alice = await Account.findOne({ owner_id: 'alice' });
      const bob = await Account.findOne({ owner_id: 'bob' });
      const treasury = await Account.findOne({ account_type: 'TREASURY' });
      expect(alice?.balance).toBe(0n);
      expect(bob?.balance).toBe(9_450n);
      expect(treasury?.balance).toBe(500n);

      // Jackpot pools
      const jpMini = await Account.findOne({ account_type: 'JACKPOT_MINI', owner_id: 'table-1' });
      const jpMinor = await Account.findOne({ account_type: 'JACKPOT_MINOR', owner_id: 'table-1' });
      const jpMajor = await Account.findOne({ account_type: 'JACKPOT_MAJOR', owner_id: 'table-1' });
      const jpGrand = await Account.findOne({ account_type: 'JACKPOT_GRAND', owner_id: 'table-1' });
      expect(jpMini?.balance).toBe(10n);
      expect(jpMinor?.balance).toBe(15n);
      expect(jpMajor?.balance).toBe(12n);
      expect(jpGrand?.balance).toBe(13n);

      // Ledger: 1 WIN_PAYOUT + 4 JACKPOT_INJECT + 1 RAKE = 6 entries
      expect(await Ledger.countDocuments({ 'metadata.round_id': 'round-1' })).toBe(6);
    });
  });

  describe('multi-loser PLATFORM table', () => {
    it('routes each loser independently and produces correct ledger entries', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 1_000n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'b', balance: 2_000n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'c', balance: 3_000n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'winner', balance: 0n });

      const receipt = await settleRound({
        roundId: 'multi-1',
        tableId: 'table-x',
        tableType: 'PLATFORM',
        winnerOwnerId: 'winner',
        winnerProfit: 6_000n, // total received
        rakeAmount: 200n,
        losers: [
          { ownerId: 'a', contribution: 1_000n },
          { ownerId: 'b', contribution: 2_000n },
          { ownerId: 'c', contribution: 3_000n },
        ],
      });

      expect(receipt.amounts.payouts).toEqual([1_000n, 2_000n, 3_000n]);
      expect(receipt.sequence.filter((s) => s === 'WIN_PAYOUT')).toHaveLength(3);
      expect(receipt.amounts.jackpot.total).toBe(30n); // 0.5% of 6000

      const a = await Account.findOne({ owner_id: 'a' });
      const b = await Account.findOne({ owner_id: 'b' });
      const c = await Account.findOne({ owner_id: 'c' });
      const w = await Account.findOne({ owner_id: 'winner' });
      expect(a?.balance).toBe(0n);
      expect(b?.balance).toBe(0n);
      expect(c?.balance).toBe(0n);
      // 6000 - 30 (jackpot) - 200 (rake) = 5770
      expect(w?.balance).toBe(5_770n);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // LEAGUE table routing
  // ───────────────────────────────────────────────────────────────────
  describe('LEAGUE table', () => {
    it('routes rake to LEAGUE_INVENTORY/{leagueId}, not TREASURY', async () => {
      const scope = 'league-7';
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'loser-1',
        wallet_scope: scope,
        balance: 5_000n,
      });
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'winner-1',
        wallet_scope: scope,
        balance: 0n,
      });

      const receipt = await settleRound({
        roundId: 'league-round-1',
        tableId: 'league-table-1',
        tableType: 'LEAGUE',
        leagueId: scope,
        winnerOwnerId: 'winner-1',
        winnerProfit: 5_000n,
        rakeAmount: 250n,
        losers: [{ ownerId: 'loser-1', contribution: 5_000n }],
      });

      expect(receipt.tableType).toBe('LEAGUE');
      expect(receipt.leagueId).toBe(scope);

      // Treasury should have ZERO rake — went to league inventory.
      const treasury = await Account.findOne({ account_type: 'TREASURY' });
      const leagueInv = await Account.findOne({
        account_type: 'LEAGUE_INVENTORY',
        owner_id: scope,
      });
      expect(treasury).toBeNull(); // never created
      expect(leagueInv?.balance).toBe(250n);

      // Winner's league-scope wallet should have the net winnings.
      const winnerLeagueWallet = await Account.findOne({
        account_type: 'PLAYER',
        owner_id: 'winner-1',
        wallet_scope: scope,
      });
      expect(winnerLeagueWallet?.balance).toBe(4_725n); // 5000 - 25 jackpot - 250 rake
    });

    it('requires leagueId for LEAGUE table', async () => {
      await expect(
        settleRound({
          roundId: 'r-bad',
          tableId: 't-bad',
          tableType: 'LEAGUE',
          winnerOwnerId: 'w',
          winnerProfit: 0n,
          rakeAmount: 0n,
          losers: [{ ownerId: 'a', contribution: 1n }],
        }),
      ).rejects.toThrow(/leagueId/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Idempotency
  // ───────────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('replay returns replayed=true with no double-charge', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 10_000n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

      const first = await settleRound({
        roundId: 'round-idem',
        tableId: 't',
        tableType: 'PLATFORM',
        winnerOwnerId: 'w',
        winnerProfit: 10_000n,
        rakeAmount: 500n,
        losers: [{ ownerId: 'a', contribution: 10_000n }],
      });
      const second = await settleRound({
        roundId: 'round-idem',
        tableId: 't',
        tableType: 'PLATFORM',
        winnerOwnerId: 'w',
        winnerProfit: 10_000n,
        rakeAmount: 500n,
        losers: [{ ownerId: 'a', contribution: 10_000n }],
      });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.hash).toBe(first.hash);
      expect(second.ledgerEntryIds.sort()).toEqual(first.ledgerEntryIds.sort());

      // Balances moved exactly once.
      const a = await Account.findOne({ owner_id: 'a' });
      const w = await Account.findOne({ owner_id: 'w' });
      expect(a?.balance).toBe(0n);
      expect(w?.balance).toBe(9_450n);
      expect(await Ledger.countDocuments({ 'metadata.round_id': 'round-idem' })).toBe(6);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // All-or-nothing atomicity
  // ───────────────────────────────────────────────────────────────────
  describe('atomicity', () => {
    it('aborts the entire round if any transfer fails (no partial state)', async () => {
      // Winner profit = $10000, jackpot = $50, rake = $500.
      // Loser only has $100 — first WIN_PAYOUT will fail with InsufficientBalance.
      await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 100n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

      await expect(
        settleRound({
          roundId: 'round-fail',
          tableId: 't',
          tableType: 'PLATFORM',
          winnerOwnerId: 'w',
          winnerProfit: 10_000n,
          rakeAmount: 500n,
          losers: [{ ownerId: 'a', contribution: 10_000n }],
        }),
      ).rejects.toThrow(/InsufficientBalance/);

      // No accounts mutated, no ledger entries.
      const a = await Account.findOne({ owner_id: 'a' });
      const w = await Account.findOne({ owner_id: 'w' });
      expect(a?.balance).toBe(100n);
      expect(w?.balance).toBe(0n);
      expect(await Ledger.countDocuments({ 'metadata.round_id': 'round-fail' })).toBe(0);
      // Jackpot accounts should not have been upserted either.
      expect(await Account.countDocuments({ account_type: 'JACKPOT_MINI' })).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Zero-amount edge cases
  // ───────────────────────────────────────────────────────────────────
  describe('zero-amount edge cases', () => {
    it('skips jackpot transfers when winner profit is 0 (jackpot total = 0)', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 1_000n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

      const receipt = await settleRound({
        roundId: 'r-zero-jp',
        tableId: 't',
        tableType: 'PLATFORM',
        winnerOwnerId: 'w',
        winnerProfit: 0n,
        rakeAmount: 50n,
        losers: [{ ownerId: 'a', contribution: 1_000n }],
      });

      expect(receipt.sequence).toEqual(['WIN_PAYOUT', 'RAKE']);
      expect(receipt.amounts.jackpot.total).toBe(0n);
      expect(await Account.countDocuments({ account_type: 'JACKPOT_MINI' })).toBe(0);
    });

    it('skips rake transfer when rakeAmount is 0', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'a', balance: 1_000n });
      await Account.create({ account_type: 'PLAYER', owner_id: 'w', balance: 0n });

      const receipt = await settleRound({
        roundId: 'r-zero-rake',
        tableId: 't',
        tableType: 'PLATFORM',
        winnerOwnerId: 'w',
        winnerProfit: 1_000n,
        rakeAmount: 0n,
        losers: [{ ownerId: 'a', contribution: 1_000n }],
      });

      expect(receipt.sequence).not.toContain('RAKE');
      const treasury = await Account.findOne({ account_type: 'TREASURY' });
      expect(treasury).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────────────────────────────
  describe('input validation', () => {
    const ok = {
      roundId: 'r',
      tableId: 't',
      tableType: 'PLATFORM' as const,
      winnerOwnerId: 'w',
      winnerProfit: 100n,
      rakeAmount: 5n,
      losers: [{ ownerId: 'a', contribution: 100n }],
    };

    it.each([
      ['roundId missing', { ...ok, roundId: '' }, /roundId/],
      ['tableId missing', { ...ok, tableId: '' }, /tableId/],
      ['winnerOwnerId missing', { ...ok, winnerOwnerId: '' }, /winnerOwnerId/],
      ['negative winnerProfit', { ...ok, winnerProfit: -1n }, />= 0/],
      ['negative rakeAmount', { ...ok, rakeAmount: -1n }, />= 0/],
      ['no losers', { ...ok, losers: [] }, /at least one loser/],
      [
        'winner appears as loser',
        { ...ok, losers: [{ ownerId: 'w', contribution: 100n }] },
        /winner cannot also appear/,
      ],
      [
        'loser contribution = 0',
        { ...ok, losers: [{ ownerId: 'a', contribution: 0n }] },
        /must be > 0/,
      ],
    ])('rejects: %s', async (_label, input, pattern) => {
      await expect(settleRound(input)).rejects.toThrow(pattern);
    });
  });
});
