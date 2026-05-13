// FairPlay M1 Demo — vanilla JS (no build step). Hits the real /api/v1/.
// Money is BigInt cents over the wire (string in JSON); display in dollars.

(function () {
  'use strict';

  const API = '/api/v1';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /** @type {{token:string,user:{username:string,sub:string,roles:string[]},internal_token:string|null}|null} */
  let session = null;

  // ─── helpers ──────────────────────────────────────────────────────
  function fmtUsd(centsStrOrBigint) {
    if (centsStrOrBigint === null || centsStrOrBigint === undefined) return '—';
    const cents = typeof centsStrOrBigint === 'string' ? BigInt(centsStrOrBigint) : centsStrOrBigint;
    const negative = cents < 0n;
    const abs = negative ? -cents : cents;
    const dollars = abs / 100n;
    const fraction = (abs % 100n).toString().padStart(2, '0');
    return (negative ? '-' : '') + '$' + dollars.toLocaleString() + '.' + fraction;
  }

  function shortId(id) {
    return id ? id.slice(0, 8) + '…' : '—';
  }

  function nowHHMMSS() {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  function logActivity(level, verb, detail) {
    const row = document.createElement('div');
    row.className = 'activity-line ' + level;
    row.innerHTML =
      '<span class="ts">' +
      nowHHMMSS() +
      '</span><span class="verb">' +
      verb +
      '</span><span class="detail">' +
      detail +
      '</span>';
    const log = $('#activity-log');
    log.insertBefore(row, log.firstChild);
    // Cap at 50 lines.
    while (log.children.length > 50) log.removeChild(log.lastChild);
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (session && opts.auth !== 'internal' && opts.auth !== false) {
      headers['Authorization'] = 'Bearer ' + session.token;
    }
    if (opts.auth === 'internal') {
      if (!session || !session.internal_token) {
        throw new Error('No INTERNAL_API_TOKEN exposed to demo (server-side env not set).');
      }
      headers['X-Internal-Token'] = session.internal_token;
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const init = { method: opts.method || 'GET', headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    const res = await fetch(API + path, init);
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body };
  }

  // ─── login ────────────────────────────────────────────────────────
  async function detectEnv() {
    try {
      const h = await fetch(API + '/health');
      const j = await h.json();
      $('#env-pill').textContent = 'mongo: ' + j.mongo + ' · NODE_ENV: development';
    } catch {
      $('#env-pill').textContent = 'unable to reach FC';
    }
  }

  async function doLogin(e) {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    $('#login-error').textContent = '';
    const r = await api('/demo/login', {
      method: 'POST',
      auth: false,
      body: { username, password },
    });
    if (!r.ok) {
      $('#login-error').textContent = (r.body && r.body.detail) || 'login failed';
      return;
    }
    session = r.body;
    $('#login-section').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    onSignedIn();
  }

  function doLogout() {
    session = null;
    $('#dashboard').classList.add('hidden');
    $('#login-section').classList.remove('hidden');
    $('#login-error').textContent = '';
  }

  async function onSignedIn() {
    logActivity('info', 'SIGN-IN', 'as ' + session.user.username + ' (' + session.user.sub + ')');
    $('#user-name').textContent = session.user.username;
    $('#user-sub').textContent = session.user.sub;
    const rolesEl = $('#user-roles');
    rolesEl.innerHTML = '';
    for (const r of session.user.roles || []) {
      const pill = document.createElement('span');
      pill.className = 'role-pill';
      pill.textContent = r;
      rolesEl.appendChild(pill);
    }

    // Hide ops-only buttons for non-ops users.
    const isOps = (session.user.roles || []).some((r) => r === 'ops' || r === 'admin');
    $$('.ops-only').forEach((btn) => {
      btn.disabled = !isOps;
      btn.title = isOps ? '' : 'requires ops role — sign in as `ops`';
    });

    await Promise.all([refreshBalance(), refreshLedger(), refreshWithdrawals(), refreshCircuitBreakers()]);
  }

  // ─── refreshers ────────────────────────────────────────────────────
  async function refreshBalance() {
    const isPlayer = (session.user.roles || []).includes('player');
    if (!isPlayer) {
      $('#balance-amount').textContent = '—';
      $('#balance-detail').textContent = 'sign in as a player';
      return;
    }
    const r = await api('/me/balance');
    if (!r.ok) {
      $('#balance-amount').textContent = '—';
      $('#balance-detail').textContent = 'error: ' + (r.body && r.body.code);
      return;
    }
    const wallets = r.body.wallets || [];
    const platform = wallets.find((w) => w.walletScope === 'PLATFORM');
    if (!platform) {
      $('#balance-amount').textContent = fmtUsd('0');
      $('#balance-detail').textContent = 'no platform wallet yet — try Deposit';
    } else {
      $('#balance-amount').textContent = fmtUsd(platform.balance);
      $('#balance-detail').textContent = wallets.length + ' wallet(s) · ' + platform.currency;
    }
  }

  async function refreshLedger() {
    const isPlayer = (session.user.roles || []).includes('player');
    const tbody = $('#ledger-rows');
    if (!isPlayer) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">sign in as a player</td></tr>';
      return;
    }
    const r = await api('/me/transactions?limit=20');
    if (!r.ok) {
      tbody.innerHTML =
        '<tr class="empty-row"><td colspan="5">error: ' + (r.body && r.body.code) + '</td></tr>';
      return;
    }
    const items = r.body.items || [];
    if (items.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">no transactions yet</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const e of items) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' +
        new Date(e.created_at).toTimeString().slice(0, 8) +
        '</td>' +
        '<td class="mono">' +
        e.type +
        '</td>' +
        '<td class="amount ' +
        e.direction +
        '">' +
        (e.direction === 'out' ? '-' : '+') +
        fmtUsd(e.amount) +
        '</td>' +
        '<td>' +
        e.direction +
        '</td>' +
        '<td><span class="state-pill state-' +
        e.status +
        '">' +
        e.status +
        '</span></td>';
      tbody.appendChild(tr);
    }
  }

  async function refreshWithdrawals() {
    const tbody = $('#withdrawal-rows');
    const isOps = (session.user.roles || []).some((r) => r === 'ops' || r === 'admin');
    let path;
    if (isOps) {
      path = '/ops/withdrawals?limit=20';
    } else {
      // No GET-list endpoint for /me/withdrawals (per docs/api-v1.md).
      // Fall back to "request a single one we just created" — store the id locally.
      const ids = JSON.parse(localStorage.getItem('demo_withdrawal_ids_' + session.user.sub) || '[]');
      if (ids.length === 0) {
        tbody.innerHTML =
          '<tr class="empty-row"><td colspan="4">no withdrawals yet — try Request</td></tr>';
        return;
      }
      const items = [];
      for (const id of ids.slice(0, 10).reverse()) {
        const r = await api('/me/withdrawals/' + id);
        if (r.ok) items.push(r.body);
      }
      renderWithdrawals(tbody, items);
      return;
    }
    const r = await api(path);
    if (!r.ok) {
      tbody.innerHTML =
        '<tr class="empty-row"><td colspan="4">error: ' + (r.body && r.body.code) + '</td></tr>';
      return;
    }
    renderWithdrawals(tbody, r.body.items || []);
  }

  function renderWithdrawals(tbody, items) {
    if (items.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">no withdrawals yet</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    for (const w of items) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' +
        new Date(w.created_at).toTimeString().slice(0, 8) +
        '</td>' +
        '<td class="amount">' +
        fmtUsd(w.amount) +
        '</td>' +
        '<td><span class="state-pill state-' +
        w.state +
        '">' +
        w.state +
        '</span></td>' +
        '<td class="mono">' +
        shortId(w.id) +
        '</td>';
      tbody.appendChild(tr);
    }
  }

  async function refreshCircuitBreakers() {
    const list = $('#cb-list');
    const isAdmin = (session.user.roles || []).includes('admin');
    if (!isAdmin) {
      // Static fallback for non-admin sessions (status is well-known).
      const known = {
        CB1: 'STUB',
        CB2: 'STUB',
        CB3: 'STUB',
        CB4: 'STUB',
        CB5: 'STUB',
        CB6: 'ACTIVE',
        CB7: 'STUB',
      };
      renderCBs(list, known, true);
      return;
    }
    const r = await api('/admin/circuit-breakers');
    if (!r.ok) {
      list.innerHTML =
        '<div class="muted small">error: ' + (r.body && r.body.code) + '</div>';
      return;
    }
    renderCBs(list, r.body, false);
  }

  function renderCBs(list, status, fallback) {
    list.innerHTML = '';
    for (const cb of ['CB1', 'CB2', 'CB3', 'CB4', 'CB5', 'CB6', 'CB7']) {
      const v = status[cb];
      const div = document.createElement('div');
      div.className = 'cb-pill ' + (v === 'ACTIVE' ? 'active' : 'stub');
      div.textContent = cb + (fallback ? '' : '');
      div.title = cb + ': ' + v;
      list.appendChild(div);
    }
  }

  async function refreshAll() {
    await Promise.all([refreshBalance(), refreshLedger(), refreshWithdrawals(), refreshCircuitBreakers()]);
  }

  // ─── action handlers ──────────────────────────────────────────────
  async function doDeposit() {
    const txHash = 'demo-tx-' + Date.now();
    const r = await api('/internal/deposit/credit', {
      method: 'POST',
      auth: 'internal',
      body: {
        player_id: session.user.sub,
        amount: '10000', // $100
        tx_hash: txHash,
        contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        confirmations: 25,
        block_number: Math.floor(Date.now() / 1000),
      },
    });
    if (r.ok) {
      logActivity('success', 'DEPOSIT', '$100 credited (txHash: ' + txHash.slice(-8) + ')');
    } else {
      logActivity('error', 'DEPOSIT', 'failed: ' + (r.body && r.body.code));
    }
    await refreshAll();
  }

  async function doSettleRound() {
    // Player wins $50 from bob. Caller computes amounts; we set winner_profit = pot.
    const roundId = 'demo-round-' + Date.now();
    // Make sure bob has chips first (ensure he's been deposited to).
    await api('/internal/deposit/credit', {
      method: 'POST',
      auth: 'internal',
      body: {
        player_id: 'demo-player-bob',
        amount: '5000',
        tx_hash: 'demo-bob-fund-' + Date.now(),
        contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        confirmations: 25,
      },
    });
    const r = await api('/internal/settle-round', {
      method: 'POST',
      auth: 'internal',
      body: {
        round_id: roundId,
        table_id: 'demo-table-1',
        table_type: 'PLATFORM',
        winner_owner_id: session.user.sub,
        winner_profit: '5000',
        rake_amount: '250',
        losers: [{ owner_id: 'demo-player-bob', contribution: '5000' }],
      },
    });
    if (r.ok) {
      const j = r.body.amounts.jackpot;
      logActivity(
        'success',
        'SETTLE',
        'won ' +
          fmtUsd('5000') +
          ' (rake ' +
          fmtUsd(r.body.amounts.rake) +
          ', jackpot total ' +
          fmtUsd(j.total) +
          ')',
      );
    } else {
      logActivity(
        'error',
        'SETTLE',
        (r.body && r.body.code) +
          ' — ' +
          ((r.body && r.body.detail) || 'failed'),
      );
    }
    await refreshAll();
  }

  async function doIllegalFlow() {
    const r = await api('/internal/transfer', {
      method: 'POST',
      auth: 'internal',
      idempotencyKey: 'demo-illegal-' + Date.now(),
      body: {
        from: { type: 'PLAYER', owner_id: session.user.sub },
        to: { type: 'REINSURANCE', owner_id: 'PLATFORM' },
        amount: '100',
        ledger_type: 'BET',
      },
    });
    if (r.status === 422 && r.body && r.body.code === 'ILLEGAL_FUND_FLOW') {
      logActivity(
        'success',
        'CB6 FIRED',
        'PLAYER → REINSURANCE blocked. ClearingRules rejected as expected. TG alert dispatched.',
      );
    } else {
      logActivity(
        'error',
        'CB6',
        'unexpected response: status=' + r.status + ' code=' + (r.body && r.body.code),
      );
    }
    await refreshCircuitBreakers();
  }

  async function doCreateWithdrawal() {
    const r = await api('/me/withdrawals', {
      method: 'POST',
      body: { amount: '2500', destination_address: 'TR-demo-' + Date.now() },
    });
    if (r.ok) {
      // Persist for non-ops viewing.
      const key = 'demo_withdrawal_ids_' + session.user.sub;
      const ids = JSON.parse(localStorage.getItem(key) || '[]');
      ids.push(r.body.id);
      localStorage.setItem(key, JSON.stringify(ids));
      logActivity('success', 'WITHDRAW', '$25 requested → ' + r.body.state + ' (' + shortId(r.body.id) + ')');
    } else {
      logActivity('error', 'WITHDRAW', (r.body && r.body.code) || 'failed');
    }
    await refreshWithdrawals();
  }

  async function findOldestWithdrawal(predicate) {
    const r = await api('/ops/withdrawals?limit=50');
    if (!r.ok) return null;
    const items = (r.body.items || []).filter(predicate);
    if (items.length === 0) return null;
    // Oldest first.
    items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return items[0];
  }

  async function doApproveWithdrawal() {
    const w = await findOldestWithdrawal((x) => x.state === 'REQUESTED');
    if (!w) {
      logActivity('error', 'OPS', 'no REQUESTED withdrawals to approve');
      return;
    }
    const r = await api('/ops/withdrawals/' + w.id + '/approve', { method: 'POST' });
    if (r.ok) {
      logActivity(
        'success',
        'APPROVED',
        shortId(w.id) + ' → APPROVED. Balance deducted; WITHDRAW ledger entry PENDING.',
      );
    } else {
      logActivity('error', 'APPROVE', (r.body && r.body.code) || 'failed');
    }
    await refreshAll();
  }

  async function doBroadcastWithdrawal() {
    const w = await findOldestWithdrawal((x) => x.state === 'APPROVED');
    if (!w) {
      logActivity('error', 'OPS', 'no APPROVED withdrawals to broadcast');
      return;
    }
    const r = await api('/ops/withdrawals/' + w.id + '/broadcast', {
      method: 'POST',
      body: { tx_hash: 'demo-onchain-' + Date.now() },
    });
    if (r.ok) {
      logActivity('success', 'BROADCASTING', shortId(w.id) + ' → BROADCASTING. tx_hash recorded.');
    } else {
      logActivity('error', 'BROADCAST', (r.body && r.body.code) || 'failed');
    }
    await refreshWithdrawals();
  }

  async function doConfirmWithdrawal() {
    const w = await findOldestWithdrawal((x) => x.state === 'BROADCASTING');
    if (!w) {
      logActivity('error', 'OPS', 'no BROADCASTING withdrawals to confirm');
      return;
    }
    const r = await api('/ops/withdrawals/' + w.id + '/confirm', { method: 'POST' });
    if (r.ok) {
      logActivity('success', 'CONFIRMED', shortId(w.id) + ' → CONFIRMED. Ledger flipped PENDING → SETTLED.');
    } else {
      logActivity('error', 'CONFIRM', (r.body && r.body.code) || 'failed');
    }
    await refreshAll();
  }

  async function doFailWithdrawal() {
    const w = await findOldestWithdrawal((x) => x.state === 'BROADCASTING');
    if (!w) {
      logActivity('error', 'OPS', 'no BROADCASTING withdrawals to fail');
      return;
    }
    const r = await api('/ops/withdrawals/' + w.id + '/fail', {
      method: 'POST',
      body: { reason: 'demo: simulated on-chain rejection' },
    });
    if (r.ok) {
      logActivity(
        'success',
        'FAILED→ROLLED_BACK',
        shortId(w.id) + ' refunded via WITHDRAW_REFUND ledger entry.',
      );
    } else {
      logActivity('error', 'FAIL', (r.body && r.body.code) || 'failed');
    }
    await refreshAll();
  }

  // ─── wire it up ───────────────────────────────────────────────────
  function bindActions() {
    const handlers = {
      'refresh-balance': refreshBalance,
      deposit: doDeposit,
      'settle-round': doSettleRound,
      'illegal-flow': doIllegalFlow,
      'create-withdrawal': doCreateWithdrawal,
      'approve-withdrawal': doApproveWithdrawal,
      'broadcast-withdrawal': doBroadcastWithdrawal,
      'confirm-withdrawal': doConfirmWithdrawal,
      'fail-withdrawal': doFailWithdrawal,
    };
    document.body.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-action]');
      if (!t || t.disabled) return;
      const fn = handlers[t.dataset.action];
      if (!fn) return;
      t.disabled = true;
      try {
        await fn();
      } catch (err) {
        logActivity('error', 'CLIENT', String(err && err.message ? err.message : err));
      } finally {
        t.disabled = false;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    detectEnv();
    $('#login-form').addEventListener('submit', doLogin);
    $('#logout-btn').addEventListener('click', doLogout);
    bindActions();
  });
})();
