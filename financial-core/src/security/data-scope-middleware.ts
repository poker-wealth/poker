import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { type JwtClaims, type Role, verifyToken } from './jwt.js';

/**
 * dataScopeMiddleware — extracts the authoritative scope from the Bearer JWT.
 *
 * Iron rule (spec §11.1): leagueId is taken from the JWT ONLY. Body- or
 * query-supplied leagueId is ignored AND stripped, so even a buggy handler
 * that reads `req.body.leagueId` will not bypass scope enforcement.
 *
 * Failures:
 *   - missing/malformed Authorization header → 401
 *   - invalid signature, wrong issuer/audience, expired → 401
 *   - body/query/params attempted to set leagueId → stripped (logged at WARN)
 */

export interface DataScope {
  userId: string;
  leagueId: string | null;
  roles: readonly Role[];
}

// Augment Express Request once for the whole app.
declare module 'express-serve-static-core' {
  interface Request {
    scope?: DataScope;
  }
}

const SCOPE_KEYS = ['leagueId', 'league_id', 'LeagueId'] as const;

function stripScopeKeysFromUserInput(
  source: Record<string, unknown> | undefined,
  where: 'body' | 'query' | 'params',
  req: Request,
): void {
  if (!source || typeof source !== 'object') return;
  for (const key of SCOPE_KEYS) {
    if (key in source) {
      logger.warn(
        {
          path: req.path,
          method: req.method,
          where,
          key,
          stripped: source[key],
        },
        'dataScopeMiddleware: stripping user-supplied scope key (server uses JWT only)',
      );
      delete source[key];
    }
  }
}

export function dataScopeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'empty bearer token' });
    return;
  }

  let claims: JwtClaims;
  try {
    claims = verifyToken(token);
  } catch (err) {
    logger.warn({ err: (err as Error).message, path: req.path }, 'jwt verify failed');
    res.status(401).json({ error: 'invalid token' });
    return;
  }

  // Strip body/query/params leagueId BEFORE attaching scope so downstream
  // handlers cannot accidentally read attacker-controlled values.
  stripScopeKeysFromUserInput(req.body as Record<string, unknown> | undefined, 'body', req);
  stripScopeKeysFromUserInput(req.query as Record<string, unknown> | undefined, 'query', req);
  stripScopeKeysFromUserInput(req.params as Record<string, unknown> | undefined, 'params', req);

  req.scope = {
    userId: claims.sub,
    leagueId: claims.leagueId ?? null,
    roles: claims.roles ?? [],
  };
  next();
}

/** Convenience guard for handlers — throws if scope is missing. */
export function requireScope(req: Request): DataScope {
  if (!req.scope) {
    throw new Error(
      'requireScope: req.scope is undefined — did you forget to mount dataScopeMiddleware?',
    );
  }
  return req.scope;
}

/** Convenience guard — require one of the given roles, else 403. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const scope = req.scope;
    if (!scope) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const has = scope.roles.some((r) => allowed.includes(r));
    if (!has) {
      res.status(403).json({ error: 'forbidden', required_roles: allowed });
      return;
    }
    next();
  };
}
