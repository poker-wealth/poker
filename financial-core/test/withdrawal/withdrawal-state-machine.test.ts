import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { Account } from '../../src/wallet/account.model';
import { InsufficientBalanceError } from '../../src/wallet/errors';
import { Ledger } from '../../src/wallet/ledger.model';
import {
  ALLOWED_NEXT,
  HUMAN_REVIEW_THRESHOLD,
  IllegalWithdrawalTransitionError,
  WithdrawalNotFoundError,
  approveWithdrawal,
  cancelWithdrawal,
  createWithdrawal,
  markBroadcasting,
  markConfirmed,
  markFailedAndRollback,
} from '../../src/withdrawal/withdrawal-state-machine';
import { Withdrawal } from '../../src/withdrawal/withdrawal.model';

describe('withdrawal/state-machine — spec §3.6', () => {
  let rs: MongoMemoryReplSet;

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
  // Transition table sanity
  // ───────────────────────────────────────────────────────────────────
  it('matches the spec §3.6 transition table exactly', () => {
    expect([...ALLOWED_NEXT.REQUESTED]).toEqual(['APPROVED', 'ROLLED_BACK']);
    expect([...ALLOWED_NEXT.APPROVED]).toEqual(['BROADCASTING']);
    expect([...ALLOWED_NEXT.BROADCASTING]).toEqual(['CONFIRMED', 'FAILED']);
    expect([...ALLOWED_NEXT.CONFIRMED]).toEqual([]); // terminal
    expect([...ALLOWED_NEXT.FAILED]).toEqual(['ROLLED_BACK']);
    expect([...ALLOWED_NEXT.ROLLED_BACK]).toEqual([]); // terminal
  });

  // ───────────────────────────────────────────────────────────────────
  // createWithdrawal
  // ───────────────────────────────────────────────────────────────────
  it('createWithdrawal puts the request in REQUESTED state with no balance change', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
    const w = await createWithdrawal({
      playerId: 'p1',
      amount: 50_000n,
      destinationAddress: 'TR-test-address',
    });
    expect(w.state).toBe('REQUESTED');
    expect(w.ledger_entry_id).toBeNull();
    expect(w.state_history).toHaveLength(1);
    expect(w.state_history[0]!.state).toBe('REQUESTED');

    const player = await Account.findOne({ owner_id: 'p1' });
    expect(player?.balance).toBe(100_000n); // unchanged
    expect(await Ledger.countDocuments()).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // approveWithdrawal
  // ───────────────────────────────────────────────────────────────────
  describe('approveWithdrawal', () => {
    it('REQUESTED → APPROVED deducts balance and writes WITHDRAW ledger entry (status=PENDING)', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
      const w = await createWithdrawal({
        playerId: 'p1',
        amount: 50_000n,
        destinationAddress: 'TR-x',
      });

      const approved = await approveWithdrawal({ withdrawalId: w._id });
      expect(approved.state).toBe('APPROVED');
      expect(approved.ledger_entry_id).toBeTruthy();

      const player = await Account.findOne({ owner_id: 'p1' });
      expect(player?.balance).toBe(50_000n);

      const ledger = await Ledger.findById(approved.ledger_entry_id);
      expect(ledger?.type).toBe('WITHDRAW');
      expect(ledger?.status).toBe('PENDING');
      expect(ledger?.amount).toBe(50_000n);
      expect(ledger?.to_account).toBeNull();
    });

    it('rejects approval with InsufficientBalance (no state change, no ledger entry)', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100n });
      const w = await createWithdrawal({
        playerId: 'p1',
        amount: 50_000n,
        destinationAddress: 'TR-x',
      });

      await expect(approveWithdrawal({ withdrawalId: w._id })).rejects.toBeInstanceOf(
        InsufficientBalanceError,
      );

      const reloaded = await Withdrawal.findById(w._id);
      expect(reloaded?.state).toBe('REQUESTED'); // unchanged
      expect(await Ledger.countDocuments()).toBe(0);
    });

    it('amounts > $10K require a reviewer', async () => {
      await Account.create({
        account_type: 'PLAYER',
        owner_id: 'p1',
        balance: 100_000_000n,
      });
      const w = await createWithdrawal({
        playerId: 'p1',
        amount: HUMAN_REVIEW_THRESHOLD + 1n,
        destinationAddress: 'TR-x',
      });
      await expect(approveWithdrawal({ withdrawalId: w._id })).rejects.toThrow(
        /reviewer/,
      );

      // With reviewer it succeeds.
      const approved = await approveWithdrawal({
        withdrawalId: w._id,
        reviewer: 'ops-jane',
      });
      expect(approved.state).toBe('APPROVED');
      expect(approved.reviewed_by).toBe('ops-jane');
    });

    it('cannot APPROVE a non-REQUESTED withdrawal', async () => {
      await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
      const w = await createWithdrawal({
        playerId: 'p1',
        amount: 50_000n,
        destinationAddress: 'TR-x',
      });
      await approveWithdrawal({ withdrawalId: w._id });
      await expect(approveWithdrawal({ withdrawalId: w._id })).rejects.toBeInstanceOf(
        IllegalWithdrawalTransitionError,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // markBroadcasting
  // ───────────────────────────────────────────────────────────────────
  it('APPROVED → BROADCASTING records tx_hash and keeps ledger PENDING', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
    const w = await createWithdrawal({
      playerId: 'p1',
      amount: 50_000n,
      destinationAddress: 'TR-x',
    });
    const approved = await approveWithdrawal({ withdrawalId: w._id });
    const broadcasting = await markBroadcasting({
      withdrawalId: approved._id,
      txHash: '0xtxhash-abc',
    });
    expect(broadcasting.state).toBe('BROADCASTING');
    expect(broadcasting.tx_hash).toBe('0xtxhash-abc');

    // Ledger entry still PENDING.
    const ledger = await Ledger.findById(broadcasting.ledger_entry_id);
    expect(ledger?.status).toBe('PENDING');
  });

  // ───────────────────────────────────────────────────────────────────
  // markConfirmed (happy path terminal)
  // ───────────────────────────────────────────────────────────────────
  it('BROADCASTING → CONFIRMED flips ledger entry PENDING → SETTLED', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
    const w = await createWithdrawal({
      playerId: 'p1',
      amount: 50_000n,
      destinationAddress: 'TR-x',
    });
    await approveWithdrawal({ withdrawalId: w._id });
    await markBroadcasting({ withdrawalId: w._id, txHash: '0xtx' });
    const confirmed = await markConfirmed({ withdrawalId: w._id });
    expect(confirmed.state).toBe('CONFIRMED');

    const ledger = await Ledger.findById(confirmed.ledger_entry_id);
    expect(ledger?.status).toBe('SETTLED');

    // CONFIRMED is terminal: no further transitions.
    await expect(
      markConfirmed({ withdrawalId: w._id }),
    ).rejects.toBeInstanceOf(IllegalWithdrawalTransitionError);
  });

  // ───────────────────────────────────────────────────────────────────
  // markFailedAndRollback (failure terminal)
  // ───────────────────────────────────────────────────────────────────
  it('BROADCASTING → FAILED → ROLLED_BACK refunds balance via WITHDRAW_REFUND ledger entry', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
    const w = await createWithdrawal({
      playerId: 'p1',
      amount: 50_000n,
      destinationAddress: 'TR-x',
    });
    await approveWithdrawal({ withdrawalId: w._id });
    await markBroadcasting({ withdrawalId: w._id, txHash: '0xtx' });

    const before = await Account.findOne({ owner_id: 'p1' });
    expect(before?.balance).toBe(50_000n); // deducted

    const rolledBack = await markFailedAndRollback({
      withdrawalId: w._id,
      reason: 'on-chain broadcast rejected by node',
    });
    expect(rolledBack.state).toBe('ROLLED_BACK');
    expect(rolledBack.failure_reason).toMatch(/broadcast rejected/);
    expect(rolledBack.refund_ledger_entry_id).toBeTruthy();

    const after = await Account.findOne({ owner_id: 'p1' });
    expect(after?.balance).toBe(100_000n); // refunded

    // Original WITHDRAW ledger entry → FAILED.
    const orig = await Ledger.findById(rolledBack.ledger_entry_id);
    expect(orig?.status).toBe('FAILED');

    // Refund WITHDRAW_REFUND ledger entry → SETTLED.
    const refund = await Ledger.findById(rolledBack.refund_ledger_entry_id);
    expect(refund?.type).toBe('WITHDRAW_REFUND');
    expect(refund?.status).toBe('SETTLED');
    expect(refund?.amount).toBe(50_000n);
    expect(refund?.from_account).toBeNull();

    // ROLLED_BACK is terminal — state_history reflects the full path.
    const states = rolledBack.state_history.map((h) => h.state);
    expect(states).toEqual(['REQUESTED', 'APPROVED', 'BROADCASTING', 'FAILED', 'ROLLED_BACK']);
  });

  // ───────────────────────────────────────────────────────────────────
  // cancelWithdrawal (REQUESTED → ROLLED_BACK direct)
  // ───────────────────────────────────────────────────────────────────
  it('cancelWithdrawal moves REQUESTED → ROLLED_BACK with no balance change', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
    const w = await createWithdrawal({
      playerId: 'p1',
      amount: 50_000n,
      destinationAddress: 'TR-x',
    });
    const cancelled = await cancelWithdrawal(w._id, 'risk-control', 'KYC mismatch');
    expect(cancelled.state).toBe('ROLLED_BACK');
    expect(cancelled.failure_reason).toBe('KYC mismatch');

    const player = await Account.findOne({ owner_id: 'p1' });
    expect(player?.balance).toBe(100_000n); // unchanged
    expect(await Ledger.countDocuments()).toBe(0); // no ledger entries
  });

  // ───────────────────────────────────────────────────────────────────
  // Negative paths
  // ───────────────────────────────────────────────────────────────────
  it('throws WithdrawalNotFoundError when target id does not exist', async () => {
    await expect(approveWithdrawal({ withdrawalId: 'ghost-id' })).rejects.toBeInstanceOf(
      WithdrawalNotFoundError,
    );
  });

  it('rejects createWithdrawal with bad inputs', async () => {
    await expect(
      createWithdrawal({ playerId: '', amount: 1n, destinationAddress: 'TR-x' }),
    ).rejects.toThrow(/playerId/);
    await expect(
      createWithdrawal({ playerId: 'p', amount: 0n, destinationAddress: 'TR-x' }),
    ).rejects.toThrow(/positive BigInt/);
    await expect(
      createWithdrawal({ playerId: 'p', amount: 1n, destinationAddress: '' }),
    ).rejects.toThrow(/destinationAddress/);
  });

  it('cannot APPROVE → CONFIRMED (skipping BROADCASTING)', async () => {
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 100_000n });
    const w = await createWithdrawal({
      playerId: 'p1',
      amount: 1_000n,
      destinationAddress: 'TR-x',
    });
    await approveWithdrawal({ withdrawalId: w._id });
    await expect(markConfirmed({ withdrawalId: w._id })).rejects.toBeInstanceOf(
      IllegalWithdrawalTransitionError,
    );
  });
});
