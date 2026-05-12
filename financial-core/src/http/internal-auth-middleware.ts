import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Gates /api/v1/internal/* — game-server → FC server-to-server traffic.
 *
 * For M1: shared secret in `X-Internal-Token` header, compared with
 * timingSafeEqual against env.INTERNAL_API_TOKEN. Spec docs/api-v1.md §4.2
 * notes M2 W3+ replaces this with a separate-audience service JWT.
 *
 * If INTERNAL_API_TOKEN is not configured, ALL /internal/* requests are
 * rejected with 503 (rather than failing open). This avoids the common
 * "forgot to set the secret in prod" foot-gun.
 */

export function internalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const env = loadEnv();

  if (!env.INTERNAL_API_TOKEN) {
    logger.error(
      { path: req.path },
      'INTERNAL_API_TOKEN not configured — refusing /internal request',
    );
    res.status(503).json({
      type: 'https://fairplay.app/errors/service-unavailable',
      title: 'ServiceUnavailable',
      status: 503,
      detail: 'INTERNAL_API_TOKEN not configured',
      code: 'INTERNAL_AUTH_NOT_CONFIGURED',
    });
    return;
  }

  const presented = req.header('x-internal-token') ?? '';
  // Length-checked timingSafeEqual to avoid leaking length info via timing.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(env.INTERNAL_API_TOKEN, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn({ path: req.path, ip: req.ip }, 'internal-auth: invalid token');
    res.status(401).json({
      type: 'https://fairplay.app/errors/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'invalid X-Internal-Token',
      code: 'INVALID_INTERNAL_TOKEN',
    });
    return;
  }
  next();
}
