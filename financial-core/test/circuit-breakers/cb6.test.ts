import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { IllegalFundFlowError } from '../../src/clearing/clearing-rules';
import { registerCB6, unregisterCB6 } from '../../src/circuit-breakers/cb6-illegal-fund-flow';
import { CIRCUIT_BREAKER_STATUS, registerAllCircuitBreakers } from '../../src/circuit-breakers/registry';
import { securityEvents } from '../../src/circuit-breakers/security-events';
import { connectDB, disconnectDB } from '../../src/db/connection';
import { clearTgAlerts, getRecordedTgAlerts } from '../../src/lib/tg-bot';
import { Account } from '../../src/wallet/account.model';
import { Ledger } from '../../src/wallet/ledger.model';
import { transfer } from '../../src/wallet/transfer';

describe('circuit-breakers/CB6 — illegal fund flow → TG alert', () => {
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
    securityEvents.removeAllListeners();
    clearTgAlerts();
    unregisterCB6();
  });

  it('registry reports CB6 as ACTIVE and the others as STUB', () => {
    expect(CIRCUIT_BREAKER_STATUS.CB6).toBe('ACTIVE');
    expect(CIRCUIT_BREAKER_STATUS.CB1).toBe('STUB');
    expect(CIRCUIT_BREAKER_STATUS.CB2).toBe('STUB');
    expect(CIRCUIT_BREAKER_STATUS.CB3).toBe('STUB');
    expect(CIRCUIT_BREAKER_STATUS.CB4).toBe('STUB');
    expect(CIRCUIT_BREAKER_STATUS.CB5).toBe('STUB');
    expect(CIRCUIT_BREAKER_STATUS.CB7).toBe('STUB');
  });

  it('non-whitelist transfer attempt fires CB6 TG alert within 5 seconds (acceptance)', async () => {
    registerAllCircuitBreakers();

    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });
    await Account.create({ account_type: 'REINSURANCE', owner_id: 'PLATFORM' });

    const t0 = Date.now();
    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'REINSURANCE', ownerId: 'PLATFORM' },
        amount: 100n,
        ledgerType: 'BET',
        idempotencyKey: 'cb6-test-1',
      }),
    ).rejects.toBeInstanceOf(IllegalFundFlowError);

    const alerts = getRecordedTgAlerts();
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    const elapsed = alert.ts - t0;
    expect(elapsed).toBeLessThan(5_000); // spec acceptance criterion
    expect(alert.text).toMatch(/CB6/);
    expect(alert.text).toMatch(/PLAYER/);
    expect(alert.text).toMatch(/REINSURANCE/);
    expect(alert.text).toMatch(/BET/);
  });

  it('legitimate (whitelisted) transfers do NOT fire CB6', async () => {
    registerCB6();
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });

    await transfer({
      from: { type: 'PLAYER', ownerId: 'p1' },
      to: { type: 'TREASURY', ownerId: 'PLATFORM' },
      amount: 100n,
      ledgerType: 'RAKE',
      idempotencyKey: 'whitelist-ok',
    });

    expect(getRecordedTgAlerts()).toHaveLength(0);
  });

  it('CB6 is idempotent — registerCB6() called twice keeps a single handler', async () => {
    registerCB6();
    registerCB6(); // second call should be no-op
    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });
    await Account.create({ account_type: 'REINSURANCE', owner_id: 'PLATFORM' });

    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'REINSURANCE', ownerId: 'PLATFORM' },
        amount: 1n,
        ledgerType: 'BET',
        idempotencyKey: 'idem-cb6-2',
      }),
    ).rejects.toBeInstanceOf(IllegalFundFlowError);

    // Exactly one alert despite two register calls.
    expect(getRecordedTgAlerts()).toHaveLength(1);
  });

  it('the security event carries fromType, toType, ledgerType, idempotencyKey, amount', async () => {
    let captured: unknown = null;
    securityEvents.on('illegal_fund_flow', (evt) => {
      captured = evt;
    });

    await Account.create({ account_type: 'PLAYER', owner_id: 'p1', balance: 10_000n });
    await Account.create({ account_type: 'REINSURANCE', owner_id: 'PLATFORM' });

    await expect(
      transfer({
        from: { type: 'PLAYER', ownerId: 'p1' },
        to: { type: 'REINSURANCE', ownerId: 'PLATFORM' },
        amount: 999n,
        ledgerType: 'BET',
        idempotencyKey: 'evt-shape-test',
      }),
    ).rejects.toBeInstanceOf(IllegalFundFlowError);

    expect(captured).not.toBeNull();
    const e = captured as {
      error: IllegalFundFlowError;
      idempotencyKey: string;
      amount: bigint;
    };
    expect(e.error.fromType).toBe('PLAYER');
    expect(e.error.toType).toBe('REINSURANCE');
    expect(e.error.ledgerType).toBe('BET');
    expect(e.idempotencyKey).toBe('evt-shape-test');
    expect(e.amount).toBe(999n);
  });
});
