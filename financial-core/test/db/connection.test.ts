import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../../src/db/connection';

describe('db/connection', () => {
  let rs: MongoMemoryReplSet;

  beforeAll(async () => {
    rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
  });

  afterAll(async () => {
    await disconnectDB();
    await rs.stop();
  });

  it('connects to a Replica Set and reaches readyState=1', async () => {
    const uri = rs.getUri();
    const m = await connectDB(uri);
    expect(m.connection.readyState).toBe(1);
  });

  it('admin ping returns ok=1', async () => {
    expect(mongoose.connection.db).toBeDefined();
    const ping = await mongoose.connection.db!.admin().ping();
    expect(ping.ok).toBe(1);
  });

  it('supports MongoDB transactions (Replica Set requirement)', async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await mongoose.connection.db!.collection('tx_smoke').insertOne(
        { key: 'tx-1', n: 1 },
        { session },
      );
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }
    const doc = await mongoose.connection.db!.collection('tx_smoke').findOne({ key: 'tx-1' });
    expect(doc).toMatchObject({ n: 1 });
  });

  it('connectDB is idempotent (re-call returns same connection)', async () => {
    const m1 = await connectDB(rs.getUri());
    const m2 = await connectDB(rs.getUri());
    expect(m1).toBe(m2);
    expect(m1.connection.readyState).toBe(1);
  });
});
