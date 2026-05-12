import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { logger } from '../lib/logger.js';
import { dataScopeMiddleware } from '../security/data-scope-middleware.js';
import { bigIntJsonReplacer, toProblemDetails } from './error-model.js';
import { internalAuthMiddleware } from './internal-auth-middleware.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';
import { internalRouter } from './routes/internal.js';
import { meRouter } from './routes/me.js';
import { opsRouter } from './routes/ops.js';

/**
 * Builds the FC HTTP application. Pure factory — no listen() side effect.
 * Exported so the boot path AND supertest can both consume it.
 *
 * Mount tree (under /api/v1):
 *   /health            (no auth)
 *   /me/*              (player JWT)
 *   /ops/*             (ops/admin role JWT)
 *   /admin/*           (admin role JWT)
 *   /internal/*        (X-Internal-Token shared secret)
 */
export function buildApp(): Express {
  const app = express();

  // BigInt-safe JSON serialization (per docs/api-v1.md §2: money is string).
  app.set('json replacer', bigIntJsonReplacer);

  // Body parsing — JSON only, 1MB cap (settlement payloads are small).
  app.use(express.json({ limit: '1mb' }));

  // Lightweight request id + log line (we don't pull in pino-http to keep
  // the dep surface small; this is sufficient for M1).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug({ method: req.method, path: req.path }, 'http request');
    next();
  });

  const v1 = express.Router();

  v1.use('/health', healthRouter);

  // Authenticated player paths.
  v1.use('/me', dataScopeMiddleware, meRouter);
  v1.use('/ops', dataScopeMiddleware, opsRouter);
  v1.use('/admin', dataScopeMiddleware, adminRouter);

  // Server-to-server.
  v1.use('/internal', internalAuthMiddleware, internalRouter);

  app.use('/api/v1', v1);

  // 404 fallback.
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      type: 'https://fairplay.app/errors/not-found',
      title: 'NotFound',
      status: 404,
      detail: `${req.method} ${req.path} is not a route on this service`,
      code: 'NOT_FOUND',
    });
  });

  // Central error handler — converts known errors to RFC 7807 problem details.
  // The 4-arg signature is required for Express to recognize this as an error
  // middleware, even though `next` isn't used.
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const problem = toProblemDetails(err, req.originalUrl);
    if (problem.status >= 500) {
      logger.error({ err, path: req.originalUrl }, 'unhandled error');
    } else {
      logger.warn({ code: problem.code, path: req.originalUrl }, 'request failed');
    }
    res.status(problem.status).type('application/problem+json').json(problem);
  };
  app.use(errorHandler);

  return app;
}
