import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import { signToken, type Role } from '../../security/jwt.js';

/**
 * Demo-only login endpoint. Issues a real JWT for one of three pre-baked
 * accounts so the in-browser demo UI can exercise the API end-to-end.
 *
 * SAFETY: This router is mounted ONLY when NODE_ENV !== 'production'.
 * The buildApp() factory enforces this. If anything ever causes the demo
 * router to mount in production, the GET /api/v1/demo/login also rejects
 * (defense in depth).
 */

export const demoRouter = Router();

const DEMO_ACCOUNTS: Record<string, { sub: string; roles: Role[] }> = {
  alice: { sub: 'demo-player-alice', roles: ['player'] },
  bob: { sub: 'demo-player-bob', roles: ['player'] },
  ops: { sub: 'demo-ops-jane', roles: ['ops'] },
  admin: { sub: 'demo-admin-root', roles: ['admin'] },
};

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const DEMO_PASSWORD = 'demo'; // hardcoded — non-production only

demoRouter.post('/login', (req: Request, res: Response) => {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    res.status(404).json({
      type: 'https://fairplay.app/errors/not-found',
      title: 'NotFound',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'demo router is disabled in production',
    });
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      type: 'https://fairplay.app/errors/validation-failed',
      title: 'ValidationFailed',
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'username and password required',
    });
    return;
  }
  const { username, password } = parsed.data;
  const account = DEMO_ACCOUNTS[username];
  if (!account || password !== DEMO_PASSWORD) {
    res.status(401).json({
      type: 'https://fairplay.app/errors/invalid-credentials',
      title: 'InvalidCredentials',
      status: 401,
      code: 'INVALID_CREDENTIALS',
      detail: `try one of: ${Object.keys(DEMO_ACCOUNTS).join(', ')} (password: "demo")`,
    });
    return;
  }
  const token = signToken({
    sub: account.sub,
    roles: account.roles,
    expiresInSeconds: 60 * 60, // 1h demo session
  });
  res.json({
    token,
    user: {
      username,
      sub: account.sub,
      roles: account.roles,
    },
    internal_token: env.INTERNAL_API_TOKEN ?? null,
  });
});

demoRouter.get('/info', (_req: Request, res: Response) => {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    res.status(404).json({ code: 'NOT_FOUND' });
    return;
  }
  res.json({
    accounts: Object.keys(DEMO_ACCOUNTS),
    password: DEMO_PASSWORD,
    note: 'Demo-only credentials. Disabled when NODE_ENV=production.',
  });
});
