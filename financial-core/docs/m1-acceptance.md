# M1 Acceptance Checklist

Single-page status of every M1 acceptance criterion + every M1 deliverable,
with the evidence trail (test name / commit / runbook step).

> When every row is **PASS** or **APPROVED-DEFERRED**, M1 is officially complete.

## Spec acceptance criteria (12-week W1)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Schema review PASSED by all team leads | ⏳ AWAITING | [docs/m1-schema-review.md](m1-schema-review.md) — mark each section |
| 2 | `transfer()` rejects non-whitelist flows; `IllegalFundFlowError` + security log | ✅ PASS | `test/clearing/clearing-rules.test.ts` (45 tests), `test/wallet/transfer.test.ts` (14 tests), `test/circuit-breakers/cb6.test.ts` (5 tests), `npm run smoke` ▶ CB6 |
| 3 | 50-table concurrent settlement: all local tx ≤50ms, zero TransientTransactionError | ⚠️ CORRECTNESS PASS | `test/acceptance/m1-50-table-concurrent.test.ts` (2 scenarios). Production p99 requires Phase 2 batch aggregation — see [docs/m1-deferred-items.md](m1-deferred-items.md) §2 |
| 4 | Idempotency key: duplicate settleRound returns already-processed | ✅ PASS | `test/settlement/settlement-engine.test.ts` ▶ idempotency, `npm run smoke` ▶ "replay the same round → idempotent" |
| 5 | CB6: non-whitelist transfer attempt → TG Bot alert fires within 5 seconds | ✅ PASS | `test/circuit-breakers/cb6.test.ts` ▶ acceptance test (measured), `npm run smoke` ▶ "rejected in Xms" |
| 6 | TRC20: Mempool no-credit; 20-block confirm credits; txHash duplicate rejected | ✅ PASS | `test/deposit/deposit-credit.test.ts` (12 tests), `npm run smoke` ▶ Player journey |
| 7 | Bare Workflow: root/jailbreak detection SDK runs on physical iOS+Android | ⏳ USER TASK | [docs/m1-runbook.md](m1-runbook.md) §2 |
| 8 | nmap scan on Singapore server IP: zero open ports | ⏳ USER TASK | [docs/m1-runbook.md](m1-runbook.md) §5 |

## Spec W1 deliverables (code)

| Deliverable | Status | Files |
|---|---|---|
| `accounts` schema with all indexes | ✅ DONE | [src/wallet/account.model.ts](../src/wallet/account.model.ts) |
| `ledger` schema with all indexes | ✅ DONE | [src/wallet/ledger.model.ts](../src/wallet/ledger.model.ts) |
| `transfer()` with ClearingRules whitelist | ✅ DONE | [src/wallet/transfer.ts](../src/wallet/transfer.ts), [src/clearing/clearing-rules.ts](../src/clearing/clearing-rules.ts) |
| Settlement Engine Phase 1 | ✅ DONE | [src/settlement/settlement-engine.ts](../src/settlement/settlement-engine.ts) |
| Settlement Engine Phase 2 (workers) | ⚠️ EVENT BUS ONLY | [src/settlement/events.ts](../src/settlement/events.ts). Real workers deferred — [m1-deferred-items.md](m1-deferred-items.md) §2 |
| Withdrawal state machine (5 states) | ✅ DONE (6 states; FAILED→ROLLED_BACK auto) | [src/withdrawal/withdrawal-state-machine.ts](../src/withdrawal/withdrawal-state-machine.ts) |
| Seven circuit breakers (CB1–CB7) | ⚠️ CB6 ACTIVE; CB1-5/7 STUB | [src/circuit-breakers/registry.ts](../src/circuit-breakers/registry.ts). Each stub mapped to landing milestone — [m1-deferred-items.md](m1-deferred-items.md) §3 |
| `dataScopeMiddleware` | ✅ DONE | [src/security/data-scope-middleware.ts](../src/security/data-scope-middleware.ts) |
| HD wallet derivation paths | ✅ DONE (paths only; address derivation deferred to HSM service) | [src/wallet/hd-derivation.ts](../src/wallet/hd-derivation.ts), [m1-deferred-items.md](m1-deferred-items.md) §4 |
| TRC20 deposit listener | ⚠️ CREDIT PRIMITIVE DONE; LISTENER DEFERRED | [src/deposit/deposit-credit.ts](../src/deposit/deposit-credit.ts), [m1-deferred-items.md](m1-deferred-items.md) §1 |
| Financial Core API interface document | ✅ DONE | [docs/api-v1.md](api-v1.md) |
| CI/CD pipeline + 2-reviewer enforcement on FC repo | ⚠️ WORKFLOW DONE; BRANCH PROTECTION USER TASK | [.github/workflows/financial-core-ci.yml](../../.github/workflows/financial-core-ci.yml), [docs/m1-runbook.md](m1-runbook.md) §1 |

## Spec W1 deliverables (infra — outside FC code)

| Deliverable | Status | Notes |
|---|---|---|
| Cloudflare Zero Trust tunnel for Singapore node | ⏳ USER TASK | [docs/m1-runbook.md](m1-runbook.md) §3 |
| MongoDB TLS + SCRAM-SHA-256 | ⏳ USER TASK | [docs/m1-runbook.md](m1-runbook.md) §4 |
| Redis TLS + rename-command | ⏳ USER TASK | [docs/m1-runbook.md](m1-runbook.md) §4 |
| Three-region deployment (Singapore + Tokyo + HK) | ⏳ DEFERRED to M1 W2 / "M1b" | [m1-deferred-items.md](m1-deferred-items.md) §8 |

## Bonus: M1 W2 (HTTP layer + demo)

| Deliverable | Status | Files |
|---|---|---|
| Express HTTP layer per `docs/api-v1.md` | ✅ DONE | [src/http/](../src/http/) |
| End-to-end supertest suite | ✅ DONE (24 tests) | [test/http/app.test.ts](../test/http/app.test.ts) |
| Demo login endpoint | ✅ DONE | [src/http/routes/demo.ts](../src/http/routes/demo.ts) |
| Demo UI (single-page dashboard) | ✅ DONE | [public/index.html](../public/index.html), [public/app.js](../public/app.js) |
| `npm run smoke` end-to-end script | ✅ DONE (34 steps) | [scripts/smoke.ts](../scripts/smoke.ts) |

## Test stats

| Category | Count |
|---|---|
| Jest tests (unit + integration + e2e supertest) | 217 |
| Smoke test steps (live HTTP) | 34 |
| Test suites | 17 |
| Test coverage (lines) | run `npm run test:coverage` |

## Final sign-off

When the **two ⏳ USER TASKS** above are complete (schema review approved + branch protection on), and the deferred items are formally accepted via the schema-review packet, M1 is done.

- [ ] **M1 schema review APPROVED** (signature line in [docs/m1-schema-review.md](m1-schema-review.md))
- [ ] **GitHub branch protection ENABLED** on `main` ([runbook §1](m1-runbook.md))
- [ ] **Bare Workflow / nmap / Cloudflare ZT / MongoDB+Redis TLS** — done OR formally deferred to "M1b infrastructure" ([runbook §2-5](m1-runbook.md))
- [ ] **`git tag M1-COMPLETE`** — commit the tag and push it

After tag: rest. M2 W3 starts cleanly with no skeletons in the closet.
