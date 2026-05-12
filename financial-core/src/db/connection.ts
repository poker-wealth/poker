import mongoose from 'mongoose';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDB(uriOverride?: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  const env = loadEnv();
  const uri = uriOverride ?? env.MONGO_URI;

  connecting = mongoose
    .connect(uri, {
      dbName: env.MONGO_DB_NAME,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 45_000,
      autoIndex: env.NODE_ENV !== 'production',
    })
    .then((m) => {
      logger.info({ uri: redact(uri), db: env.MONGO_DB_NAME }, 'mongoose connected');
      return m;
    })
    .catch((err) => {
      connecting = null;
      logger.error({ err, uri: redact(uri) }, 'mongoose connection failed');
      throw err;
    });

  return connecting;
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  connecting = null;
  logger.info('mongoose disconnected');
}

function redact(uri: string): string {
  return uri.replace(/\/\/[^@]+@/, '//***@');
}
