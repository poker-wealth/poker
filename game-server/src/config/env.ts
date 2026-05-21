import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  FC_BASE_URL: z.string().url().default('http://127.0.0.1:3000'),
  FC_INTERNAL_TOKEN: z.string().min(16).optional(),

  DRAND_URLS: z
    .string()
    .default('https://api.drand.sh,https://api2.drand.sh,https://api3.drand.sh'),
  DRAND_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  KMS_KEY_ID: z.string().optional(),
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
