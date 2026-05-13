import request from 'supertest';
import { buildApp } from '../../src/http/app';
import { verifyToken } from '../../src/security/jwt';

describe('http/demo — non-production demo router', () => {
  const app = buildApp();

  it('GET /api/v1/demo/info returns the available demo accounts', async () => {
    const r = await request(app).get('/api/v1/demo/info');
    expect(r.status).toBe(200);
    expect(r.body.accounts).toEqual(expect.arrayContaining(['alice', 'bob', 'ops', 'admin']));
    expect(r.body.password).toBe('demo');
  });

  it('POST /demo/login with valid credentials returns a real JWT + internal token', async () => {
    const r = await request(app)
      .post('/api/v1/demo/login')
      .send({ username: 'alice', password: 'demo' });
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe('string');
    const claims = verifyToken(r.body.token);
    expect(claims.sub).toBe('demo-player-alice');
    expect(claims.roles).toEqual(['player']);
    expect(r.body.user).toEqual({
      username: 'alice',
      sub: 'demo-player-alice',
      roles: ['player'],
    });
    expect(r.body.internal_token).toBe(process.env.INTERNAL_API_TOKEN);
  });

  it('POST /demo/login with wrong password returns 401', async () => {
    const r = await request(app)
      .post('/api/v1/demo/login')
      .send({ username: 'alice', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /demo/login with unknown user returns 401', async () => {
    const r = await request(app)
      .post('/api/v1/demo/login')
      .send({ username: 'mallory', password: 'demo' });
    expect(r.status).toBe(401);
  });

  it('POST /demo/login with malformed body returns 400', async () => {
    const r = await request(app).post('/api/v1/demo/login').send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');
  });

  it('demo-issued ops token can hit /api/v1/ops/withdrawals', async () => {
    const login = await request(app)
      .post('/api/v1/demo/login')
      .send({ username: 'ops', password: 'demo' });
    expect(login.status).toBe(200);
    // Real downstream call with demo-issued token.
    const r = await request(app)
      .get('/api/v1/ops/withdrawals')
      .set('Authorization', `Bearer ${login.body.token}`);
    // 200 (empty queue) or 500 if Mongo isn't connected — but auth must pass.
    expect([200, 500]).toContain(r.status);
    if (r.status !== 200) {
      // If we get an error, it must NOT be auth-related.
      expect(r.body.code).not.toBe('FORBIDDEN');
      expect(r.body.code).not.toBe('INVALID_TOKEN');
    }
  });

  it('serves the demo index.html at / when NODE_ENV != production', async () => {
    const r = await request(app).get('/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toMatch(/FairPlay/);
    expect(r.text).toMatch(/M1 Financial Core Demo/);
  });
});
