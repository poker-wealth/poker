import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MONGO_URI: z.string().min(1),
  MONGO_DB_NAME: z.string().min(1),

  REDIS_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16),
  JWT_ISSUER: z.string().default('fairplay'),
  JWT_AUDIENCE: z.string().default('fairplay-fc'),

  TG_BOT_TOKEN: z.string().optional(),
  TG_OPS_CHAT_ID: z.string().optional(),

  // Shared secret guarding /api/v1/internal/* (game-server → FC).
  // M2 W3+ replaces this with a proper service JWT (separate aud).
  INTERNAL_API_TOKEN: z.string().min(16).optional(),

  TRON_FULLNODE_URL: z.string().url().default('https://api.trongrid.io'),
  TRON_USDT_CONTRACT: z.string().default('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  TRON_DEPOSIT_CONFIRMATIONS: z.coerce.number().int().positive().default(20),

  HD_MASTER_SEED_HEX: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
