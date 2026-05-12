// Set required env vars for the test runner BEFORE any module that imports
// src/config/env.ts is loaded. The actual MONGO_URI is overwritten per-test
// using mongodb-memory-server's MongoMemoryReplSet.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/placeholder?replicaSet=rs0';
process.env.MONGO_DB_NAME ??= 'fairplay-fc-test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret';
process.env.LOG_LEVEL ??= 'warn';
