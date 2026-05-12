import { Router, type Request, type Response } from 'express';
import { CIRCUIT_BREAKER_STATUS } from '../../circuit-breakers/registry.js';
import { requireRole } from '../../security/data-scope-middleware.js';

/**
 * Admin endpoints (mounted at /api/v1/admin). Require role = admin.
 */
export const adminRouter = Router();

adminRouter.use(requireRole('admin'));

adminRouter.get('/circuit-breakers', (_req: Request, res: Response) => {
  res.json({ ...CIRCUIT_BREAKER_STATUS });
});
