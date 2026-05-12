import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { loadEnv } from '../../src/config/env';
import { connectDB, disconnectDB } from '../../src/db/connection';
import {
  InsufficientConfirmationsError,
  UnauthorizedContractError,
  creditDeposit,
} from '../../src/deposit/deposit-credit';
import { Account } from '../../src/wallet/account.model';
import { Ledger } from '../../src/wallet/ledger.model';

const env = loadEnv();
const OFFICIAL_USDT = env.TRON_USDT_CONTRACT;
const REQUIRED_CONFIRMATIONS = env.TRON_DEPOSIT_CONFIRMATIONS;

describe('deposit/creditDeposit (TRC20, spec §3.7)', () => {
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
  // Acceptance: Mempool no-credit + 20-block confirm credits + txHash dup rejected
  // ───────────────────────────────────────────────────────────────────

  it('Mempool detection (0 confirmations) does NOT credit', async () => {
    await expect(
      creditDeposit({
        playerId: 'p1',
        amount: 1_000_000n,
        txHash: 'tx-mempool-1',
        contractAddress: OFFICIAL_USDT,
        confirmations: 0,
      }),
    ).rejects.toBeInstanceOf(InsufficientConfirmationsError);

    expect(await Account.countDocuments()).toBe(0); // no player account upserted
    expect(await Ledger.countDocuments()).toBe(0); // no ledger entry
  });

  it('confirmations between 1 and required-1 do NOT credit', async () => {
    for (const conf of [1, 5, 10, REQUIRED_CONFIRMATIONS - 1]) {
      await expect(
        creditDeposit({
          playerId: 'p1',
          amount: 1_000_000n,
          txHash: `tx-pending-${conf}`,
          contractAddress: OFFICIAL_USDT,
          confirmations: conf,
        }),
      ).rejects.toBeInstanceOf(InsufficientConfirmationsError);
    }
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it('exactly REQUIRED_CONFIRMATIONS credits the player', async () => {
    const result = await creditDeposit({
      playerId: 'p1',
      amount: 1_000_000n, // $10,000 in cents
      txHash: 'tx-confirmed-1',
      contractAddress: OFFICIAL_USDT,
      confirmations: REQUIRED_CONFIRMATIONS,
      blockNumber: 12_345_678,
      fromTronAddress: 'TXSender123',
    });

    expect(result.replayed).toBe(false);
    expect(result.toAccount?.balance).toBe(1_000_000n);
    expect(result.ledgerEntry.type).toBe('DEPOSIT');
    expect(result.ledgerEntry.status).toBe('SETTLED');
    expect(result.ledgerEntry.from_account).toBeNull();
    expect(result.ledgerEntry.metadata).toMatchObject({
      tx_hash: 'tx-confirmed-1',
      contract_address: OFFICIAL_USDT,
      confirmations: REQUIRED_CONFIRMATIONS,
      block_number: 12_345_678,
      from_tron_address: 'TXSender123',
    });
  });

  it('greater than REQUIRED_CONFIRMATIONS still credits exactly once', async () => {
    const result = await creditDeposit({
      playerId: 'p1',
      amount: 500n,
      txHash: 'tx-deep-confirm',
      contractAddress: OFFICIAL_USDT,
      confirmations: REQUIRED_CONFIRMATIONS + 100,
    });
    expect(result.replayed).toBe(false);
    const player = await Account.findOne({ owner_id: 'p1' });
    expect(player?.balance).toBe(500n);
  });

  it('txHash duplicate rejected via idempotency — second call returns replayed=true', async () => {
    const first = await creditDeposit({
      playerId: 'p1',
      amount: 100_000n,
      txHash: 'tx-dup',
      contractAddress: OFFICIAL_USDT,
      confirmations: REQUIRED_CONFIRMATIONS,
    });
    const second = await creditDeposit({
      playerId: 'p1',
      amount: 100_000n,
      txHash: 'tx-dup',
      contractAddress: OFFICIAL_USDT,
      confirmations: REQUIRED_CONFIRMATIONS + 5,
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.ledgerEntry._id).toBe(first.ledgerEntry._id);

    // Balance moved exactly once.
    const player = await Account.findOne({ owner_id: 'p1' });
    expect(player?.balance).toBe(100_000n);
    expect(await Ledger.countDocuments()).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────
  // Contract whitelist
  // ───────────────────────────────────────────────────────────────────

  it('Non-official contract attempts are rejected (logged + NOT credited)', async () => {
    await expect(
      creditDeposit({
        playerId: 'p1',
        amount: 100_000n,
        txHash: 'tx-fake-contract',
        contractAddress: 'TFakeContract000000000000000000000',
        confirmations: REQUIRED_CONFIRMATIONS,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedContractError);

    expect(await Account.countDocuments()).toBe(0);
    expect(await Ledger.countDocuments()).toBe(0);
  });

  it('confirmation check happens BEFORE balance write (contract check first)', async () => {
    // Non-official contract + insufficient confirmations: contract error wins.
    await expect(
      creditDeposit({
        playerId: 'p1',
        amount: 100_000n,
        txHash: 'tx-fake-and-pending',
        contractAddress: 'TFakeContract',
        confirmations: 5,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedContractError);
  });

  // ───────────────────────────────────────────────────────────────────
  // Input validation
  // ───────────────────────────────────────────────────────────────────

  describe('input validation', () => {
    const ok = {
      playerId: 'p1',
      amount: 100n,
      txHash: 'tx-x',
      contractAddress: OFFICIAL_USDT,
      confirmations: REQUIRED_CONFIRMATIONS,
    };

    it('rejects empty playerId', async () => {
      await expect(creditDeposit({ ...ok, playerId: '' })).rejects.toThrow(/playerId/);
    });
    it('rejects empty txHash', async () => {
      await expect(creditDeposit({ ...ok, txHash: '' })).rejects.toThrow(/txHash/);
    });
    it('rejects zero / negative amount', async () => {
      await expect(creditDeposit({ ...ok, amount: 0n })).rejects.toThrow(/positive BigInt/);
      await expect(creditDeposit({ ...ok, amount: -1n })).rejects.toThrow(/positive BigInt/);
    });
    it('rejects negative / non-integer confirmations', async () => {
      await expect(creditDeposit({ ...ok, confirmations: -1 })).rejects.toThrow(/non-negative integer/);
      await expect(creditDeposit({ ...ok, confirmations: 1.5 })).rejects.toThrow(/non-negative integer/);
    });
    it('rejects empty contractAddress', async () => {
      await expect(creditDeposit({ ...ok, contractAddress: '' })).rejects.toThrow(/contractAddress/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // BigInt preservation
  // ───────────────────────────────────────────────────────────────────

  it('preserves BigInt precision for very large deposit amounts', async () => {
    const huge = 100_000_000_000_000n; // $1B in cents
    await creditDeposit({
      playerId: 'whale-1',
      amount: huge,
      txHash: 'tx-whale',
      contractAddress: OFFICIAL_USDT,
      confirmations: REQUIRED_CONFIRMATIONS,
    });
    const player = await Account.findOne({ owner_id: 'whale-1' });
    expect(typeof player?.balance).toBe('bigint');
    expect(player?.balance).toBe(huge);
  });
});
