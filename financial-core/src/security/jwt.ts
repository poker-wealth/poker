import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

/**
 * JWT helpers — used by dataScopeMiddleware to extract authoritative scope
 * (leagueId, userId, roles) from the Bearer token. Body-supplied scope is
 * NEVER trusted (spec §11.1 dataScopeMiddleware rule).
 */

export type Role = 'player' | 'agent' | 'league_admin' | 'ops' | 'admin';

export interface JwtClaims {
  /** Subject — the userId. */
  sub: string;
  /** League membership for league-context requests. Absent for lobby-only users. */
  leagueId?: string;
  /** Permissions — for ops/admin endpoints, etc. */
  roles?: Role[];
}

const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60; // 1h

export interface SignTokenInput extends JwtClaims {
  expiresInSeconds?: number;
}

export function signToken(input: SignTokenInput): string {
  const env = loadEnv();
  const { expiresInSeconds = DEFAULT_TOKEN_TTL_SECONDS, ...claims } = input;
  return jwt.sign(claims, env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: expiresInSeconds,
  });
}

export function verifyToken(token: string): JwtClaims {
  const env = loadEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('verifyToken: payload is not an object');
  }
  const payload = decoded as Record<string, unknown>;
  const sub = typeof payload['sub'] === 'string' ? payload['sub'] : null;
  if (!sub) throw new Error('verifyToken: missing sub claim');
  const out: JwtClaims = { sub };
  if (typeof payload['leagueId'] === 'string') out.leagueId = payload['leagueId'];
  if (Array.isArray(payload['roles'])) {
    out.roles = (payload['roles'] as unknown[]).filter(
      (r): r is Role =>
        typeof r === 'string' &&
        (['player', 'agent', 'league_admin', 'ops', 'admin'] as const).includes(r as Role),
    );
  }
  return out;
}
