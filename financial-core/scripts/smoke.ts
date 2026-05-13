#!/usr/bin/env tsx
// FairPlay M1 — smoke test
// Boots MongoMemoryReplSet + the FC app in-process, then walks the full
// player + ops journey via real HTTP. Prints per-step PASS/FAIL.
//
// Run: npm run smoke
//
// This is the "human eyeball" verification — separate from the jest tests.
// If this passes, every M1 deliverable is exercised end-to-end on a real
// HTTP server with real Mongo (in-process Replica Set).

// MUST be the first import — sets env defaults before any FC module loads.
import './_smoke-env.js';

import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { registerAllCircuitBreakers } from '../src/circuit-breakers/registry.js';
import { connectDB, disconnectDB } from '../src/db/connection.js';
import { buildApp } from '../src/http/app.js';
import { Account } from '../src/wallet/account.model.js';
import { Ledger } from '../src/wallet/ledger.model.js';
import { Withdrawal } from '../src/withdrawal/withdrawal.model.js';

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let pass = 0;
let fail = 0;
let baseUrl = '';
let server: Server | null = null;
let rs: MongoMemoryReplSet | null = null;

function step(name: string): void {
  process.stdout.write(`  ${colors.dim('• ')}${name}${colors.dim(' ... ')}`);
}
function ok(detail = ''): void {
  pass++;
  console.log(colors.green('PASS') + (detail ? colors.dim(`  ${detail}`) : ''));
}
function ko(reason: string): void {
  fail++;
  console.log(colors.red('FAIL') + colors.dim(`  ${reason}`));
}
function section(title: string): void {
  console.log(`\n${colors.bold(colors.cyan(`▶ ${title}`))}`);
}

interface ApiOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface ApiResult {
  status: number;
  body: any;
}

async function api(path: string, opts: ApiOpts = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  const res = await fetch(baseUrl + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function bootstrap(): Promise<void> {
  section('Bootstrap');

  step('starting in-process MongoDB Replica Set');
  rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  ok();

  step('connecting Mongoose');
  await connectDB(rs.getUri());
  await Account.syncIndexes();
  await Ledger.syncIndexes();
  await Withdrawal.syncIndexes();
  ok();

  step('registering circuit breakers');
  registerAllCircuitBreakers();
  ok();

  step('starting HTTP server on a random port');
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}/api/v1`;
      resolve();
    });
  });
  ok(baseUrl);
}

async function teardown(): Promise<void> {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (rs) {
    await disconnectDB();
    await rs.stop();
  }
}

async function scenario(): Promise<void> {
  // ─── Health ──────────────────────────────────────────────────
  section('Health');
  step('GET /health');
  const h = await api('/health');
  if (h.status === 200 && h.body.status === 'ok' && h.body.mongo === 'connected') ok();
  else ko(`expected 200/ok/connected, got ${h.status} ${JSON.stringify(h.body)}`);

  // ─── Demo login ──────────────────────────────────────────────
  section('Demo login');
  let aliceToken = '';
  let opsToken = '';
  let internalToken = '';

  step('POST /demo/login (alice)');
  let r = await api('/demo/login', {
    method: 'POST',
    body: { username: 'alice', password: 'demo' },
  });
  if (r.status === 200 && r.body.token && r.body.internal_token) {
    aliceToken = r.body.token;
    internalToken = r.body.internal_token;
    ok(`user=${r.body.user.username}`);
  } else ko(`expected 200 with token, got ${r.status}`);

  step('POST /demo/login (ops)');
  r = await api('/demo/login', { method: 'POST', body: { username: 'ops', password: 'demo' } });
  if (r.status === 200 && r.body.token) {
    opsToken = r.body.token;
    ok(`user=${r.body.user.username}`);
  } else ko(`expected 200, got ${r.status}`);

  if (!aliceToken || !opsToken || !internalToken) {
    console.log(colors.red('\nfatal: login failed; aborting'));
    return;
  }

  const aliceAuth = { Authorization: `Bearer ${aliceToken}` };
  const opsAuth = { Authorization: `Bearer ${opsToken}` };
  const internalAuth = { 'X-Internal-Token': internalToken };

  // ─── Player journey ──────────────────────────────────────────
  section('Player journey — alice');

  step('balance starts empty');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.status === 200 && r.body.wallets.length === 0) ok();
  else ko(`expected wallets=[], got ${JSON.stringify(r.body)}`);

  step('deposit $100 via /internal/deposit/credit');
  r = await api('/internal/deposit/credit', {
    method: 'POST',
    headers: internalAuth,
    body: {
      player_id: 'demo-player-alice',
      amount: '10000',
      tx_hash: 'smoke-deposit-1',
      contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      confirmations: 25,
    },
  });
  if (r.status === 200 && r.body.replayed === false) ok(`balance=${r.body.to_account.balance}`);
  else ko(`expected 200 replayed=false, got ${r.status}`);

  step('balance reflects deposit');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.status === 200 && r.body.wallets[0]?.balance === '10000') ok('$100.00');
  else ko(`expected balance=10000, got ${JSON.stringify(r.body)}`);

  step('Mempool deposit (0 confirmations) is REJECTED');
  r = await api('/internal/deposit/credit', {
    method: 'POST',
    headers: internalAuth,
    body: {
      player_id: 'demo-player-alice',
      amount: '999',
      tx_hash: 'smoke-mempool-1',
      contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      confirmations: 0,
    },
  });
  if (r.status === 409 && r.body.code === 'INSUFFICIENT_CONFIRMATIONS') ok('CB blocked');
  else ko(`expected 409, got ${r.status} ${r.body?.code}`);

  step('non-official contract deposit is REJECTED');
  r = await api('/internal/deposit/credit', {
    method: 'POST',
    headers: internalAuth,
    body: {
      player_id: 'demo-player-alice',
      amount: '999',
      tx_hash: 'smoke-bad-contract-1',
      contract_address: 'TFakeContract',
      confirmations: 30,
    },
  });
  if (r.status === 422 && r.body.code === 'UNAUTHORIZED_CONTRACT') ok('CB blocked');
  else ko(`expected 422, got ${r.status} ${r.body?.code}`);

  step('duplicate txHash deposit returns idempotent replay');
  r = await api('/internal/deposit/credit', {
    method: 'POST',
    headers: internalAuth,
    body: {
      player_id: 'demo-player-alice',
      amount: '10000',
      tx_hash: 'smoke-deposit-1',
      contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      confirmations: 30,
    },
  });
  if (r.status === 200 && r.body.replayed === true) ok('balance unchanged');
  else ko(`expected replayed=true, got ${r.status} replayed=${r.body?.replayed}`);

  step('balance still $100 (no double-credit)');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.body.wallets[0]?.balance === '10000') ok();
  else ko(`got ${r.body.wallets[0]?.balance}`);

  // ─── Settle a hand ────────────────────────────────────────────
  section('Settlement — alice wins against bob');

  step('fund bob via deposit');
  r = await api('/internal/deposit/credit', {
    method: 'POST',
    headers: internalAuth,
    body: {
      player_id: 'demo-player-bob',
      amount: '5000',
      tx_hash: 'smoke-bob-fund',
      contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      confirmations: 25,
    },
  });
  if (r.status === 200) ok();
  else ko(`failed: ${r.status}`);

  step('settle PLATFORM round (alice wins $50, $2.50 rake)');
  r = await api('/internal/settle-round', {
    method: 'POST',
    headers: internalAuth,
    body: {
      round_id: 'smoke-round-1',
      table_id: 'smoke-table-1',
      table_type: 'PLATFORM',
      winner_owner_id: 'demo-player-alice',
      winner_profit: '5000',
      rake_amount: '250',
      losers: [{ owner_id: 'demo-player-bob', contribution: '5000' }],
    },
  });
  if (
    r.status === 200 &&
    r.body.replayed === false &&
    r.body.amounts.rake === '250' &&
    r.body.amounts.jackpot.total === '25'
  ) {
    ok('jackpot total=$0.25 (4 pools split 20/30/25/25)');
  } else {
    ko(`unexpected: ${JSON.stringify(r.body.amounts)}`);
  }

  step('replay the same round → idempotent');
  r = await api('/internal/settle-round', {
    method: 'POST',
    headers: internalAuth,
    body: {
      round_id: 'smoke-round-1',
      table_id: 'smoke-table-1',
      table_type: 'PLATFORM',
      winner_owner_id: 'demo-player-alice',
      winner_profit: '5000',
      rake_amount: '250',
      losers: [{ owner_id: 'demo-player-bob', contribution: '5000' }],
    },
  });
  if (r.status === 200 && r.body.replayed === true) ok();
  else ko(`expected replayed=true, got ${r.body?.replayed}`);

  step('alice = $100 + $50 - $0.25 jackpot - $2.50 rake = $147.25');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.body.wallets[0]?.balance === '14725') ok();
  else ko(`got ${r.body.wallets[0]?.balance}`);

  // ─── CB6 ─────────────────────────────────────────────────────
  section('CB6 — illegal fund flow detection');

  step('PLAYER → REINSURANCE returns 422 ILLEGAL_FUND_FLOW');
  const t0 = Date.now();
  r = await api('/internal/transfer', {
    method: 'POST',
    headers: { ...internalAuth, 'Idempotency-Key': 'smoke-illegal-1' },
    body: {
      from: { type: 'PLAYER', owner_id: 'demo-player-alice' },
      to: { type: 'REINSURANCE', owner_id: 'PLATFORM' },
      amount: '100',
      ledger_type: 'BET',
    },
  });
  const elapsed = Date.now() - t0;
  if (r.status === 422 && r.body.code === 'ILLEGAL_FUND_FLOW' && elapsed < 5000) {
    ok(`rejected in ${elapsed}ms (CB6 alert dispatched)`);
  } else {
    ko(`expected 422 ILLEGAL_FUND_FLOW <5s, got ${r.status} in ${elapsed}ms`);
  }

  step('alice balance unchanged');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.body.wallets[0]?.balance === '14725') ok();
  else ko(`balance changed: ${r.body.wallets[0]?.balance}`);

  // ─── Withdrawal flow ──────────────────────────────────────────
  section('Withdrawal flow — full lifecycle');

  step('alice creates $25 withdrawal');
  r = await api('/me/withdrawals', {
    method: 'POST',
    headers: aliceAuth,
    body: { amount: '2500', destination_address: 'TR-smoke-test' },
  });
  let withdrawalId = '';
  if (r.status === 201 && r.body.state === 'REQUESTED') {
    withdrawalId = r.body.id;
    ok(`id=${withdrawalId.slice(0, 8)}…`);
  } else ko(`expected 201 REQUESTED, got ${r.status}`);

  step('balance unchanged after request');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.body.wallets[0]?.balance === '14725') ok();
  else ko('balance changed prematurely');

  step('ops approves → APPROVED, balance deducted');
  r = await api(`/ops/withdrawals/${withdrawalId}/approve`, {
    method: 'POST',
    headers: opsAuth,
  });
  if (r.status === 200 && r.body.state === 'APPROVED' && r.body.reviewed_by === 'demo-ops-jane') ok();
  else ko(`expected APPROVED, got ${r.body?.state}`);

  step('balance now = $147.25 - $25 = $122.25');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.body.wallets[0]?.balance === '12225') ok();
  else ko(`got ${r.body.wallets[0]?.balance}`);

  step('ops broadcasts → BROADCASTING with tx_hash');
  r = await api(`/ops/withdrawals/${withdrawalId}/broadcast`, {
    method: 'POST',
    headers: opsAuth,
    body: { tx_hash: 'smoke-onchain-1' },
  });
  if (r.status === 200 && r.body.state === 'BROADCASTING' && r.body.tx_hash === 'smoke-onchain-1')
    ok();
  else ko(`expected BROADCASTING, got ${r.body?.state}`);

  step('ops confirms → CONFIRMED, ledger PENDING → SETTLED');
  r = await api(`/ops/withdrawals/${withdrawalId}/confirm`, {
    method: 'POST',
    headers: opsAuth,
  });
  if (r.status === 200 && r.body.state === 'CONFIRMED') ok();
  else ko(`expected CONFIRMED, got ${r.body?.state}`);

  step('double-confirm → 409 ILLEGAL_WITHDRAWAL_TRANSITION');
  r = await api(`/ops/withdrawals/${withdrawalId}/confirm`, {
    method: 'POST',
    headers: opsAuth,
  });
  if (r.status === 409 && r.body.code === 'ILLEGAL_WITHDRAWAL_TRANSITION') ok();
  else ko(`expected 409, got ${r.status}`);

  // ─── Failed withdrawal flow ───────────────────────────────────
  section('Withdrawal failure path → auto-refund');

  step('alice creates another $20 withdrawal');
  r = await api('/me/withdrawals', {
    method: 'POST',
    headers: aliceAuth,
    body: { amount: '2000', destination_address: 'TR-smoke-test-2' },
  });
  const failId: string = r.body.id;
  if (r.status === 201) ok();
  else ko(`failed: ${r.status}`);

  step('approve + broadcast');
  await api(`/ops/withdrawals/${failId}/approve`, { method: 'POST', headers: opsAuth });
  r = await api(`/ops/withdrawals/${failId}/broadcast`, {
    method: 'POST',
    headers: opsAuth,
    body: { tx_hash: 'smoke-onchain-2' },
  });
  if (r.body.state === 'BROADCASTING') ok();
  else ko('not in BROADCASTING');

  step('balance = $122.25 - $20 = $102.25');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.body.wallets[0]?.balance === '10225') ok();
  else ko(`got ${r.body.wallets[0]?.balance}`);

  step('ops marks failed → ROLLED_BACK + refund');
  r = await api(`/ops/withdrawals/${failId}/fail`, {
    method: 'POST',
    headers: opsAuth,
    body: { reason: 'smoke: simulated on-chain rejection' },
  });
  if (r.status === 200 && r.body.state === 'ROLLED_BACK' && r.body.refund_ledger_entry_id)
    ok(`refund_ledger_entry_id=${r.body.refund_ledger_entry_id.slice(0, 8)}…`);
  else ko(`expected ROLLED_BACK + refund, got ${r.body?.state}`);

  step('balance refunded back to $122.25');
  r = await api('/me/balance', { headers: aliceAuth });
  if (r.body.wallets[0]?.balance === '12225') ok();
  else ko(`got ${r.body.wallets[0]?.balance}`);

  // ─── Admin ───────────────────────────────────────────────────
  section('Admin');

  step('ops cannot read /admin (403)');
  r = await api('/admin/circuit-breakers', { headers: opsAuth });
  if (r.status === 403) ok();
  else ko(`expected 403, got ${r.status}`);

  step('admin token can read CB status');
  const adminLogin = await api('/demo/login', {
    method: 'POST',
    body: { username: 'admin', password: 'demo' },
  });
  r = await api('/admin/circuit-breakers', {
    headers: { Authorization: `Bearer ${adminLogin.body.token}` },
  });
  if (r.status === 200 && r.body.CB6 === 'ACTIVE') ok('CB6=ACTIVE; CB1-5,7=STUB');
  else ko(`expected CB6=ACTIVE, got ${JSON.stringify(r.body)}`);
}

async function main(): Promise<void> {
  console.log(colors.bold('\nFairPlay M1 Smoke Test'));
  console.log(colors.dim('===================================================='));

  const totalT0 = Date.now();
  try {
    await bootstrap();
    await scenario();
  } catch (err) {
    console.log(colors.red(`\nfatal: ${err instanceof Error ? err.stack : String(err)}`));
    fail++;
  } finally {
    await sleep(100);
    await teardown();
  }

  const elapsed = ((Date.now() - totalT0) / 1000).toFixed(1);
  console.log(colors.dim('\n===================================================='));
  console.log(
    `${colors.bold('Smoke result: ')}${colors.green(`${pass} passed`)}` +
      (fail ? colors.red(`, ${fail} failed`) : '') +
      colors.dim(`  (${elapsed}s)`),
  );
  process.exit(fail === 0 ? 0 : 1);
}

void main();
