# M1 Schema Review Packet

> Spec §15 (12-week W1 Day 5 gate): "All team leads present. Review: accounts table, ledger table, ClearingRules, transfer() function, all 7 circuit breakers. **MUST PASS before W2 starts.**"

This document walks every M1 deliverable that needs sign-off. For each section: **what was built**, the **iron rules** it enforces, the **acceptance evidence** (test names + commits), and a **decision marker** for you to fill in.

How to use:
1. Read each section.
2. Mark the decision: **APPROVE** / **CHANGES REQUESTED** (with notes).
3. Commit the marked-up version.
4. The "CHANGES REQUESTED" items become the W2-blocker punch list.

---

## 1. `accounts` schema (spec §3.1, §3.2)

**Files:** [src/domain/account-types.ts](../src/domain/account-types.ts), [src/wallet/account.model.ts](../src/wallet/account.model.ts)
**Tests:** [test/wallet/account.model.test.ts](../test/wallet/account.model.test.ts) (11 tests)

### What was built

- 9 account_type enums: `PLAYER`, `TREASURY`, `INSURANCE`, `REINSURANCE`, `LEAGUE_INVENTORY`, `JACKPOT_MINI`, `JACKPOT_MINOR`, `JACKPOT_MAJOR`, `JACKPOT_GRAND`.
- Mongoose schema for `accounts` collection:
  - `_id`: UUID v7 string (time-sortable)
  - `account_type`: enum (immutable post-create)
  - `owner_id`: string (immutable; validated against per-type rules)
  - `wallet_scope`: string (default `'PLATFORM'`; enables PLAYER's two-wallet model)
  - `balance`: BigInt cents (validated ≥ 0)
  - `version`: int (optimistic-lock counter; managed manually, not by Mongoose `__v`)
  - `created_at`, `updated_at`
- Compound unique index on `(account_type, owner_id, wallet_scope)`.
- Reverse index `by_owner` on `(owner_id, account_type)`.
- Cross-field validation in `pre('validate')`: TREASURY must have `owner_id='PLATFORM'`; LEAGUE_INVENTORY must NOT.

### Iron rules enforced

- `UPDATE accounts SET balance = ...` is impossible: balance is BigInt-validated and only `transfer()` writes to it.
- Each `(type, owner, scope)` combination is unique by index — no duplicate accounts possible.
- `account_type` and `owner_id` are immutable post-create — schema enforces.
- BigInt balance survives roundtrip through `.lean()` thanks to `useBigInt64: true` on the connection.

### Open questions for review

- **`wallet_scope` field** — I added this to the spec. The spec mentions "Player balance (Platform Wallet and League Wallet as separate accounts)" but doesn't specify the discriminator. I picked `wallet_scope` (default `'PLATFORM'`, league-scoped wallets use the leagueId). **Approve, or do you want a different model?**
- **UUID v7 for `_id`** — spec says "UUID PRIMARY KEY" without specifying version. v7 is sortable by creation time. **Approve, or prefer v4?**

### Decision

- [ ] APPROVE
- [ ] CHANGES REQUESTED — notes:

---

## 2. `ledger` schema (spec §3.2)

**Files:** [src/domain/ledger-types.ts](../src/domain/ledger-types.ts), [src/wallet/ledger.model.ts](../src/wallet/ledger.model.ts)
**Tests:** [test/wallet/ledger.model.test.ts](../test/wallet/ledger.model.test.ts) (11 tests)

### What was built

- 16 LedgerTypes (14 from spec §3.2 + `AGENT_COMMISSION` + `AGENT_VIP_BONUS` from spec §13.5, added now to avoid M8 schema migration).
- 4 LedgerStatuses: `PENDING`, `SETTLED`, `FAILED`, `ROLLED_BACK`.
- Append-only schema:
  - `_id`: UUID v7
  - `from_account`, `to_account`: nullable strings (one is null for boundary types)
  - `amount`: BigInt cents (immutable, must be > 0; direction encoded by from/to)
  - `type`: enum (immutable)
  - `idempotency_key`: string with **UNIQUE INDEX**
  - `status`: enum (only mutable field — flips PENDING→SETTLED on confirm, →FAILED on broadcast failure)
  - `metadata`: Mixed (round_id, table_id, tx_hash, etc.)
- Direction validation: DEPOSIT/WITHDRAW_REFUND require `from_account=null`; WITHDRAW requires `to_account=null`; everything else requires both endpoints AND from≠to.
- Indexes: `uniq_idempotency_key`, `by_from_account`, `by_to_account`, `by_type`, `by_round_id` (sparse on `metadata.round_id`).

### Iron rules enforced

- Idempotency: duplicate `idempotency_key` → MongoDB E11000 → caught and returned as IdempotentReplay.
- Direction integrity: schema rejects ledger entries with wrong direction shape for the type.
- Append-only: `from_account`, `to_account`, `amount`, `type` immutable. Only `status` can flip.

### Open questions for review

- **`from_account` / `to_account` typed as nullable strings, not foreign-key references** — spec says "REFERENCES accounts(id)" but Mongoose doesn't enforce FKs in MongoDB. We rely on application-level invariants. **Approve, or do you want a periodic reconciliation cron to verify all FK targets exist?**
- **`metadata` as Mixed** — spec calls it JSONB. Mixed is the Mongoose equivalent. **Approve.**
- **`AGENT_COMMISSION`/`AGENT_VIP_BONUS` added in M1** — these are M8 features but I added them to the enum now to avoid a schema migration later. **Approve.**

### Decision

- [ ] APPROVE
- [ ] CHANGES REQUESTED — notes:

---

## 3. `ClearingRules` whitelist (spec §3.3)

**Files:** [src/clearing/clearing-rules.ts](../src/clearing/clearing-rules.ts)
**Tests:** [test/clearing/clearing-rules.test.ts](../test/clearing/clearing-rules.test.ts) (45 tests)

### What was built

- `ALLOWED_INTERNAL_FLOWS`: 9-source whitelist matching spec §3.3 table.
- `ALLOWED_INFLOW_TARGETS`: DEPOSIT → {PLAYER, TREASURY}, WITHDRAW_REFUND → {PLAYER}.
- `ALLOWED_OUTFLOW_SOURCES`: WITHDRAW → {PLAYER, TREASURY}.
- Frozen `Object`/`Map` so the whitelist cannot be mutated at runtime.
- `IllegalFundFlowError` carries `fromType`/`toType`/`ledgerType` for CB6 logging.
- `assertFlowAllowed(flow)` throws on violation.
- Pure function — no I/O, fully testable.

### Iron rules enforced

- Hardcoded in source (NOT admin-configurable per spec).
- Any non-whitelisted flow → `IllegalFundFlowError` → CB6 fires.
- Coverage tests verify every `AccountType` appears as a source.

### One spec deviation flagged

**PLAYER → PLAYER added explicitly.** Spec §3.3 summary table doesn't list this, but spec §3.5 settlement pseudocode does:
```
transfer(PLAYER_losers, PLAYER_winner, payout_amount, 'WIN_PAYOUT', key6, session)
```
I added PLAYER → PLAYER as allowed (used by WIN_PAYOUT). Without it, no settlement could ever pay out. **Approve, or do you want a different reading of the spec?**

### Other prohibited flows we explicitly reject (covered by tests)

- `TREASURY → INSURANCE` (must use multi-sig override path — not implemented in M1)
- `INSURANCE → TREASURY` (premium leakage prevention)
- `REINSURANCE → PLAYER` (must route through INSURANCE)
- `JACKPOT_* → anything except PLAYER` (out-only)
- `LEAGUE_INVENTORY → LEAGUE_INVENTORY` (cross-league prohibition)
- `JACKPOT` tier-to-tier (no internal jackpot rebalancing)

### Decision

- [ ] APPROVE
- [ ] CHANGES REQUESTED — notes:

---

## 4. `transfer()` function (spec §3.3)

**Files:** [src/wallet/transfer.ts](../src/wallet/transfer.ts), [src/wallet/transfer-types.ts](../src/wallet/transfer-types.ts), [src/wallet/errors.ts](../src/wallet/errors.ts)
**Tests:** [test/wallet/transfer.test.ts](../test/wallet/transfer.test.ts) (14 tests)

### What was built

Pipeline:
1. **ClearingRules check** — `assertFlowAllowed()`. Throws on violation; emits `securityEvents.illegal_fund_flow` for CB6.
2. **Per-type owner validation** — `validateOwnerForType()`.
3. **MongoDB session.withTransaction**:
   - 3a. Decrement `from`-account: `findOneAndUpdate` with `balance ≥ amount` filter + version `$inc`. If no match: distinguish `AccountNotFoundError` vs `InsufficientBalanceError`.
   - 3b. Upsert+increment `to`-account (creates account on first contact).
   - 3c. Insert ledger entry. Duplicate `idempotency_key` → `IdempotentReplay` sentinel.
4. **Idempotent replay** path: catch sentinel, load original entry, return with `replayed: true`.
5. **Retry** on `TransientTransactionError` / `WriteConflict`: exponential backoff [50, 100, 200ms], max 3 retries.
6. **Duration tracking**: warn if local tx > 50ms (spec hard limit).

Two entry points:
- `transfer(input)` — owns its session, full retry loop. Use for single fund movements.
- `applyTransfer(input, session)` — caller provides session. Used by Settlement Engine to bundle N+5 transfers in one atomic transaction.

### Iron rules enforced

- ALL fund movements go through this function. No other code mutates `accounts.balance`.
- `from`-account decrement is atomic with balance-check (no overdraft possible).
- Both account updates and the ledger insert happen in one MongoDB transaction — all-or-nothing.
- Idempotency via unique `ledger.idempotency_key` index — duplicate calls return original result, no double-charge.

### Open questions for review

- **`from`-account decrement uses `balance: { $gte: amount }` as filter** instead of CAS on `version`. The spec pseudocode shows `version: expectedVersion` in the filter. I went with balance-check because:
  - Caller doesn't typically have an `expectedVersion` (they don't read first)
  - Balance-check is the actual safety property we care about
  - `version` still increments to invalidate concurrent reads' optimistic locks
  
  **Approve this interpretation, or do you want CAS-on-version with an explicit `expectedFromVersion` option?**

- **Retry policy**: spec Pitfall 1 mandates `[50ms, 100ms, 200ms]`. Implemented exactly. **Approve.**
- **`upsert: true` on the to-account** — creates the account on first contact (e.g., first JACKPOT_INJECT to a brand-new table creates that table's JACKPOT_MINI account). The pre-validate hook does NOT run on findOneAndUpdate, so owner_id-shape validation is enforced by the caller (`assertRefValid()` runs before the tx). **Approve.**

### Decision

- [ ] APPROVE
- [ ] CHANGES REQUESTED — notes:

---

## 5. Settlement Engine Phase 1 + Phase 2 (spec §3.5)

**Files:** [src/settlement/settlement-domain.ts](../src/settlement/settlement-domain.ts), [src/settlement/settlement-engine.ts](../src/settlement/settlement-engine.ts), [src/settlement/events.ts](../src/settlement/events.ts)
**Tests:** [test/settlement/](../test/settlement/) — 29 tests across 3 files

### What was built

**Settlement Domain** — `getRakeDestination(tableType, leagueId?)` and `getPlayerWalletScope(tableType, leagueId?)`. Pure functions, called by Settlement Engine for routing.

**Phase 1** (`settleRound`) — synchronous, atomic:
- Phase A: each loser → winner (`WIN_PAYOUT × N`)
- Phase B: winner → 4 JACKPOT pools (`JACKPOT_INJECT`, 0.5% of winner profit split 20/30/25/25; rounding remainder to GRAND)
- Phase C: winner → rake destination (`RAKE`)
- Idempotent (round_id-based keys); replay returns original receipt
- SHA-256 receipt hash (suitable for Solana commitment in M2)
- `setMaxListeners(32)` on the event bus (worker fanout)

**Phase 2** — event bus only:
- `settlementEvents` typed EventEmitter with `'settled'` and `'replayed'` events
- `'settled'` fires AFTER `session.withTransaction` commits
- `'replayed'` fires for idempotent re-calls (NOT `'settled'`)
- Listeners are non-throwing or their errors are swallowed (logged)

### Iron rules enforced

- All transfers within a single round happen in one MongoDB transaction.
- Validation rejects: empty round_id/table_id/winner_owner_id, negative amounts, no losers, winner appearing as loser, zero loser contribution.
- Atomic abort: if any transfer fails (e.g., insufficient balance), the entire round rolls back — no partial state.

### Spec gap — flagged for review

**Spec §3.5 says jackpot/rake/payout in that ledger order. Spec §3.9 says loser → JACKPOT, loser → TREASURY, loser → winner.** These are inconsistent.

I implemented §3.9's flow direction (losers → winner first; then winner → jackpot/rake) for two reasons:
1. Physically: winner needs the chips before they can pay jackpot/rake.
2. With our balance-as-truth model (no "in-play" chip pool), losers' chips must move first.

The ledger sequence ends up: `WIN_PAYOUT × N`, then `JACKPOT_INJECT × 4`, then `RAKE` — opposite of §3.5's documented order.

**Decisions needed:**
- Approve §3.9 interpretation? (recommended — the alternative requires modeling "in-play" chips separately)
- Or fix §3.5 in the spec to match?
- Or build the "in-play" chip model and ship §3.5's ordering?

### Phase 2 — knowingly stub for M1

**What's NOT built:**
- Real `RAKE_QUEUE Worker=5` process (spec §3.5 — async on-chain rake aggregation)
- Real `JACKPOT_QUEUE Worker=3` process (spec §3.5 — jackpot snapshot maintenance / on-chain commitJackpot)
- Solana `commitRound` upload (spec §6 — async settlement_receipt commitment)

**Why deferred:** all three require infrastructure that arrives in M2 (Solana integration, jackpot trigger logic, on-chain rake aggregation). The event bus is the architectural surface; M2 listeners plug in.

**Decision needed:** Approve the deferral? See `docs/m1-deferred-items.md`.

### Decision

- [ ] APPROVE (settlement engine + Phase 2 deferral)
- [ ] CHANGES REQUESTED — notes:

---

## 6. Withdrawal State Machine (spec §3.6)

**Files:** [src/withdrawal/withdrawal.model.ts](../src/withdrawal/withdrawal.model.ts), [src/withdrawal/withdrawal-state-machine.ts](../src/withdrawal/withdrawal-state-machine.ts)
**Tests:** [test/withdrawal/withdrawal-state-machine.test.ts](../test/withdrawal/withdrawal-state-machine.test.ts) (13 tests)

### What was built

- 6 states: REQUESTED, APPROVED, BROADCASTING, CONFIRMED, FAILED, ROLLED_BACK.
- `ALLOWED_NEXT` transition table matches spec §3.6 exactly:
  - `REQUESTED → {APPROVED, ROLLED_BACK}`
  - `APPROVED → {BROADCASTING}`
  - `BROADCASTING → {CONFIRMED, FAILED}`
  - `FAILED → {ROLLED_BACK}`
  - `CONFIRMED, ROLLED_BACK` (terminal)
- API:
  - `createWithdrawal()` — REQUESTED, no balance change
  - `approveWithdrawal()` — REQUESTED → APPROVED, atomic balance deduct via WITHDRAW (status PENDING)
  - `markBroadcasting()` — APPROVED → BROADCASTING, records tx_hash
  - `markConfirmed()` — BROADCASTING → CONFIRMED, flips ledger PENDING → SETTLED
  - `markFailedAndRollback()` — BROADCASTING → FAILED → ROLLED_BACK, refund via WITHDRAW_REFUND
  - `cancelWithdrawal()` — REQUESTED → ROLLED_BACK (no balance change)
- All transitions use CAS (`findOneAndUpdate({ _id, state: expected })`) to prevent double-execution.
- `state_history` array for audit (append-only).
- HUMAN_REVIEW_THRESHOLD = $10,000 in cents = `1_000_000n`. Amounts above this require a `reviewer` argument.

### Iron rules enforced

- Balance is deducted at APPROVED, refunded at ROLLED_BACK (after FAILED).
- Atomic deduction via `transfer(PLAYER → null, WITHDRAW, status='PENDING')`.
- Status flips PENDING → SETTLED on CONFIRMED.
- Status flips PENDING → FAILED + new WITHDRAW_REFUND entry on ROLLED_BACK.
- Cannot skip BROADCASTING (APPROVED → CONFIRMED is rejected).
- Concurrent transition attempts: CAS fails on the second one → `IllegalWithdrawalTransitionError`.

### Open questions for review

- **Reviewer required for amounts > $10K** — spec §3.6 says human review "> $10K". Implemented as required `reviewer` parameter. **Approve.**
- **48-hour broadcast timeout** — spec mentions this for FAILED state but I haven't built the timer. **Defer to M10 ops?** (M10 is "Operations + Withdrawal review queue" per spec.)
- **Address modification cooldown (48h)** — spec §10.2. Not built. **Defer to M10.**

### Decision

- [ ] APPROVE
- [ ] CHANGES REQUESTED — notes:

---

## 7. Circuit Breakers — CB6 active, CB1-5 + CB7 stubs (spec §3.8)

**Files:** [src/circuit-breakers/](../src/circuit-breakers/), [src/lib/tg-bot.ts](../src/lib/tg-bot.ts)
**Tests:** [test/circuit-breakers/cb6.test.ts](../test/circuit-breakers/cb6.test.ts) (5 tests)

### What was built

- `securityEvents` typed EventEmitter with `'illegal_fund_flow'` event.
- `transfer()` emits `'illegal_fund_flow'` BEFORE re-throwing `IllegalFundFlowError`.
- **CB6** (`registerCB6`) — listener that:
  1. Logs at ERROR level with structured event=CB6_ILLEGAL_FUND_FLOW.
  2. Fires `sendTgAlert()` (5-second timeout).
- `sendTgAlert()` — POSTs to Telegram Bot API when `TG_BOT_TOKEN` + `TG_OPS_CHAT_ID` are set; logs at WARN otherwise. Records all alerts in-process for tests.
- `CIRCUIT_BREAKER_STATUS` reports per-CB state (`ACTIVE` / `STUB`).

### CB6 acceptance verified

- Test: `non-whitelist transfer attempt fires CB6 TG alert within 5 seconds (acceptance)` — passes.
- HTTP layer test: POST `/internal/transfer` with PLAYER → REINSURANCE returns 422 + CB6 alert fires.

### CB1-5 + CB7 — knowingly stubs

| CB | Trigger | Why stub for M1 |
|---|---|---|
| CB1 | Insurance pool < threshold | Insurance pool created in M2 (Underwriting) |
| CB2 | Daily payout rate > 15% | Same — needs Insurance |
| CB3 | Jackpot 3+ Mini triggers / 1h same table | Trigger logic is M5 (Jackpot polish) |
| CB4 | Single account: withdrawals/hour > limit | Withdrawal rate metrics are M10 |
| CB5 | Platform total withdrawals/hour > threshold | Same — M10 |
| CB7 | On-chain tx address mismatch | Needs M2 Solana / M1 W2+ Tron listener |

**Decision needed:** Approve the stubs for M1, with each CB landing in its tracked milestone? See `docs/m1-deferred-items.md`.

### Decision

- [ ] APPROVE (CB6 active + CB1-5/7 stubbed-with-tracked-deferral)
- [ ] CHANGES REQUESTED — notes:

---

## 8. dataScopeMiddleware (spec §11.1)

**Files:** [src/security/data-scope-middleware.ts](../src/security/data-scope-middleware.ts), [src/security/jwt.ts](../src/security/jwt.ts)
**Tests:** [test/security/data-scope-middleware.test.ts](../test/security/data-scope-middleware.test.ts) (11 tests)

### What was built

- Verifies HS256 JWT (issuer/audience-bound).
- Attaches `req.scope = { userId, leagueId, roles }`.
- **Strips `leagueId` / `league_id` / `LeagueId` from request body, query, AND params** before the handler sees them — server reads scope from JWT only.
- Each strip logs at WARN level for security audit.
- `requireScope(req)` and `requireRole(...allowed)` convenience guards.

### Iron rule enforced

- `leagueId` in JWT is the only source of truth. Body/query/params variants stripped, can't bypass authorization.

### HTTP layer integration verified

- E2E test: POST `/me/withdrawals` with body `{leagueId: "attacker-league"}` → JWT's `leagueId="real-league"` is what gets used; body version is stripped. Tested.

### Decision

- [ ] APPROVE
- [ ] CHANGES REQUESTED — notes:

---

## 9. HD wallet derivation paths (spec §3.4)

**Files:** [src/wallet/hd-derivation.ts](../src/wallet/hd-derivation.ts)
**Tests:** [test/wallet/hd-derivation.test.ts](../test/wallet/hd-derivation.test.ts) (11 tests)

### What was built

- BIP-44 path mapping per spec §3.4 table:
  - TREASURY hot/warm/cold → `m/44'/195'/0'/0/{0,1,2}`
  - INSURANCE → `m/44'/195'/0'/1/{leagueIdx}`
  - REINSURANCE → `m/44'/195'/0'/2/{leagueIdx}`
  - LEAGUE_INVENTORY → `m/44'/195'/0'/3/{leagueIdx}` (leagueIdx > 0; 0 reserved for platform pools)
  - JACKPOT_* → `m/44'/195'/0'/4/{tableIdx}/{tier}` (tier: 0=MINI, 1=MINOR, 2=MAJOR, 3=GRAND)
  - PLAYER deposit → `m/44'/195'/0'/5/{playerIdx}`
- Index validation: non-negative integer, < 2^31 (BIP-32 non-hardened max).

### Out of scope for M1 (deferred)

- Actual address derivation: path → secp256k1 → Tron base58check. Lives in the HSM-signing service. **Defer to the HSM integration milestone (likely M2).**
- HSM key storage. **Defer.**

### Decision

- [ ] APPROVE (paths only; address derivation deferred)
- [ ] CHANGES REQUESTED — notes:

---

## 10. TRC20 deposit credit (spec §3.7)

**Files:** [src/deposit/deposit-credit.ts](../src/deposit/deposit-credit.ts)
**Tests:** [test/deposit/deposit-credit.test.ts](../test/deposit/deposit-credit.test.ts) (12 tests)

### What was built

`creditDeposit({ playerId, amount, txHash, contractAddress, confirmations, ... })`:
- Iron rule 1: official contract whitelist (`TRON_USDT_CONTRACT` env). Non-official → `UnauthorizedContractError`, ZERO credit, structured log.
- Iron rule 2: confirmations >= `TRON_DEPOSIT_CONFIRMATIONS` (default 20). Mempool (0 conf) → `InsufficientConfirmationsError`, ZERO credit.
- Iron rule 3: `idempotency_key = 'deposit:${txHash}'`. Replay returns original entry.
- Iron rule 4: BigInt cents (no float).

### Acceptance verified

- Test: `Mempool detection (0 confirmations) does NOT credit` — passes.
- Test: `exactly REQUIRED_CONFIRMATIONS credits the player` — passes.
- Test: `txHash duplicate rejected via idempotency` — passes.

### Out of scope for M1 (deferred)

- Real Tron node listener (websocket / poll loop watching player deposit addresses). **Defer to M1 W2+** per `docs/m1-deferred-items.md`.

### Decision

- [ ] APPROVE (credit primitive + listener deferral)
- [ ] CHANGES REQUESTED — notes:

---

## 11. Treasury hot/warm/cold thresholds (spec §3.4 + §3.7)

**Files:** [src/wallet/treasury-thresholds.ts](../src/wallet/treasury-thresholds.ts)
**Tests:** [test/wallet/treasury-thresholds.test.ts](../test/wallet/treasury-thresholds.test.ts) (12 tests)

### What was built

- Constants exact-from-spec: HOT_CAP $50K, WARM_CAP $500K, COLD floor 70% of total.
- `evaluateTreasuryAllocation({ hot, warm, cold })` returns:
  - `HOT_OVER_CAP_AUTO_AGGREGATE` (hot → warm, no human approval)
  - `WARM_OVER_CAP_HUMAN_APPROVE` (warm → cold, 2/3 → 3/5 multi-sig)
  - `COLD_UNDER_FLOOR_HUMAN_APPROVE` (warm → cold, top up)
  - `OK`

### Pure logic; M1 doesn't wire it

The function exists; nothing calls it yet. Per-block balance polling and the actual rebalancing transfers are M10 (Operations).

### Decision

- [ ] APPROVE (logic only; orchestration deferred to M10)
- [ ] CHANGES REQUESTED — notes:

---

## 12. HTTP API layer (spec docs/api-v1.md)

**Files:** [src/http/](../src/http/), [docs/api-v1.md](api-v1.md)
**Tests:** [test/http/app.test.ts](../test/http/app.test.ts) (24 tests)

### What was built

Mount tree under `/api/v1`:
- `/health` (no auth)
- `/me/*` (player JWT) — balance, transactions, withdrawal create/get/cancel
- `/internal/*` (X-Internal-Token) — settle-round, transfer, deposit/credit
- `/ops/*` (role: ops/admin) — withdrawal queue + 5 transition endpoints
- `/admin/*` (role: admin) — circuit-breakers status

Cross-cutting:
- BigInt JSON serializer (money is string per docs/api-v1.md §2)
- RFC 7807 problem-details for every known error class
- `x-idempotent-replay: true` header on replays
- Internal-auth fails closed (503 if `INTERNAL_API_TOKEN` not set)

### Decision

- [ ] APPROVE
- [ ] CHANGES REQUESTED — notes:

---

## 13. M1 acceptance criteria — overall status

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | transfer() rejects non-whitelist flows | ✅ PASS | clearing-rules + transfer + cb6 tests |
| 2 | 50-table concurrent settlement | ⚠️ CORRECTNESS PASS | 50 settlements correct under WriteConflict storm; production p99 ≤50ms requires Phase 2 batch aggregation (deferred) |
| 3 | Idempotency key duplicate returns already-processed | ✅ PASS | settlement-engine test |
| 4 | CB6 TG Bot alert fires within 5 seconds | ✅ PASS | cb6 test (measured) |
| 5 | TRC20 Mempool no-credit + 20-block confirm + dup rejected | ✅ PASS | deposit-credit tests |
| 6 | Schema review PASSED by all team leads | ⏳ THIS DOCUMENT | mark each section above |
| 7 | Bare Workflow on physical iOS+Android | ⏳ USER TASK | runbook in docs/m1-runbook.md |
| 8 | nmap zero open ports on Singapore server | ⏳ USER TASK | runbook in docs/m1-runbook.md |

---

## Final sign-off

When all 12 sections above are marked APPROVE (or CHANGES REQUESTED items are resolved):

- [ ] **M1 schema review COMPLETE** — date: ____________ — signed: ____________

After this is signed, M1 is officially gate-cleared and W2 can start.
