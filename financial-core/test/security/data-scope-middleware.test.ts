import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import {
  dataScopeMiddleware,
  requireRole,
  requireScope,
} from '../../src/security/data-scope-middleware';
import { signToken } from '../../src/security/jwt';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(dataScopeMiddleware);
  app.get('/me', (req: Request, res: Response) => {
    const scope = requireScope(req);
    res.json(scope);
  });
  app.post('/echo', (req: Request, res: Response) => {
    const scope = requireScope(req);
    res.json({ scope, bodyAfterStrip: req.body, queryAfterStrip: req.query });
  });
  app.get('/ops-only', requireRole('ops', 'admin'), (req: Request, res: Response) => {
    res.json({ ok: true, userId: req.scope!.userId });
  });
  return app;
}

describe('security/dataScopeMiddleware', () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  it('401 when Authorization header is missing', async () => {
    const r = await request(app).get('/me');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'missing bearer token' });
  });

  it('401 when bearer prefix is missing', async () => {
    const r = await request(app).get('/me').set('Authorization', 'not-a-bearer');
    expect(r.status).toBe(401);
  });

  it('401 when token is invalid', async () => {
    const r = await request(app).get('/me').set('Authorization', 'Bearer junk.token.here');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'invalid token' });
  });

  it('attaches scope from JWT claims (userId, leagueId, roles)', async () => {
    const token = signToken({ sub: 'user-1', leagueId: 'league-A', roles: ['player'] });
    const r = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      userId: 'user-1',
      leagueId: 'league-A',
      roles: ['player'],
    });
  });

  it('null leagueId when JWT has no leagueId claim', async () => {
    const token = signToken({ sub: 'user-2' });
    const r = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(r.body.leagueId).toBeNull();
  });

  it('strips leagueId from BODY (server uses JWT only)', async () => {
    const token = signToken({ sub: 'user-3', leagueId: 'real-league' });
    const r = await request(app)
      .post('/echo')
      .set('Authorization', `Bearer ${token}`)
      .send({ leagueId: 'attacker-controlled-league', amount: 1000 });
    expect(r.status).toBe(200);
    expect(r.body.scope.leagueId).toBe('real-league'); // from JWT
    expect(r.body.bodyAfterStrip).not.toHaveProperty('leagueId');
    expect(r.body.bodyAfterStrip).toEqual({ amount: 1000 });
  });

  it('strips leagueId from QUERY', async () => {
    const token = signToken({ sub: 'user-4', leagueId: 'real-league' });
    const r = await request(app)
      .post('/echo?leagueId=attacker-league&other=keepme')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(r.body.scope.leagueId).toBe('real-league');
    expect(r.body.queryAfterStrip).toEqual({ other: 'keepme' });
  });

  it('also strips snake_case `league_id` and PascalCase `LeagueId`', async () => {
    const token = signToken({ sub: 'user-5', leagueId: 'real-league' });
    const r = await request(app)
      .post('/echo')
      .set('Authorization', `Bearer ${token}`)
      .send({ league_id: 'attacker-1', LeagueId: 'attacker-2' });
    expect(r.body.bodyAfterStrip).not.toHaveProperty('league_id');
    expect(r.body.bodyAfterStrip).not.toHaveProperty('LeagueId');
  });

  it('requireRole — ops endpoint blocks regular players', async () => {
    const token = signToken({ sub: 'player-1', roles: ['player'] });
    const r = await request(app).get('/ops-only').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });

  it('requireRole — ops endpoint allows ops', async () => {
    const token = signToken({ sub: 'jane', roles: ['ops'] });
    const r = await request(app).get('/ops-only').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, userId: 'jane' });
  });

  it('expired tokens rejected', async () => {
    const token = signToken({ sub: 'expired-user', expiresInSeconds: -1 });
    const r = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
  });
});
