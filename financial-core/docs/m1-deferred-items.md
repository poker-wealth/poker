# M1 Deferred Items

What we knowingly punted out of M1, with the milestone where it lands.
Sign-off on `docs/m1-schema-review.md` implies acceptance of these deferrals.

---

## 1. Real Tron node listener

**What's deferred:** the websocket / poll loop that watches player deposit
addresses on the Tron blockchain and invokes `creditDeposit()` once a tx
hits 20 confirmations.

**What's done:** `creditDeposit()` itself — the credit primitive — with
all four iron rules (contract whitelist, 20-block confirm, mempool no-credit,
txHash idempotency) and 12 tests.

**Lands in:** M1 W2 (originally "M1b" infrastructure in the 28-week spec).
Requires a Tron node connection (`TRON_FULLNODE_URL` env, default
`https://api.trongrid.io`) and per-player address tracking.

**Risk:** zero — `creditDeposit()` is testable today via `POST /api/v1/internal/deposit/credit`.
The listener just calls it.

---

## 2. Real Phase 2 workers (RAKE_QUEUE / JACKPOT_QUEUE)

**What's deferred:** the `RAKE_QUEUE Worker=5` and `JACKPOT_QUEUE Worker=3`
processes that spec §3.5 mandates. These do on-chain rake aggregation and
jackpot snapshot maintenance.

**What's done:** the event surface (`settlementEvents` typed EventEmitter
with `'settled'` / `'replayed'` events). Real workers register as listeners.

**Lands in:** M2 (depends on Solana integration for `commitRound` and on
M5 for jackpot trigger logic). The event bus is the architectural seam.

**Risk:** medium — the spec promises ≤50ms p99 under 50-table contention,
which requires the batch aggregation worker (spec Pitfall 1 Fix 3). Without
it, direct concurrent TREASURY writes block on WriteConflicts. The 50-table
acceptance test demonstrates the system stays CORRECT under contention but
takes ~30 seconds wall-clock for 50 simultaneous settlements on a memory
Replica Set. Production performance must be re-measured after the Phase 2
worker lands.

---

## 3. Circuit Breakers CB1, CB2, CB3, CB4, CB5, CB7

**What's deferred:** active handlers for 6 of the 7 circuit breakers.
The framework is in place; status reports `STUB` for each.

**What's done:** CB6 (illegal fund flow → TG Bot alert within 5s) — the
spec calls this "MOST IMPORTANT" and it's the only one with infrastructure
available in M1.

| CB | Trigger | Lands in |
|---|---|---|
| CB1 | Insurance pool < threshold | M2 — needs Insurance pool to exist |
| CB2 | Daily payout rate > 15% | M2 — same |
| CB3 | Same table: 3+ Mini triggers / 1h | M5 — needs jackpot trigger logic |
| CB4 | Single account: withdrawals/hour > limit | M10 — needs per-account rate metrics |
| CB5 | Platform total withdrawals/hour > threshold | M10 — needs platform-wide metrics |
| CB7 | On-chain tx address mismatch | M2 — needs Solana + Tron integration |

**Risk:** low — each CB lands in the milestone where its trigger condition
becomes meaningful. There's no value in shipping CB1 before there's an
Insurance pool to monitor.

---

## 4. HD wallet address derivation + HSM signing service

**What's deferred:** the actual `path → secp256k1 → Tron base58check`
derivation, and the HSM-backed signing service that holds the master key.

**What's done:** the BIP-44 path mapping per spec §3.4. Pure path-builder
with 11 tests covering every account_type's derivation rule.

**Lands in:** M2 (Solana / on-chain integration milestone). The HSM
signing service is a separate operational component; spec §3.4 is explicit
that "Master private key stored in HSM. Never online. Never in code."

**Risk:** zero — paths are stable; address derivation is mechanical
crypto over those paths.

---

## 5. Hot/warm/cold treasury orchestration

**What's deferred:** the actual rebalancing transfers (hot → warm,
warm → cold) that execute the recommendations from
`evaluateTreasuryAllocation()`.

**What's done:** the threshold evaluator with 12 tests. Pure function;
returns a list of `Recommendation` objects with `requiresHumanApproval`
flags.

**Lands in:** M10 (Operations + ops dashboard). The orchestrator is a
cron + ops UI that polls on-chain balances, calls
`evaluateTreasuryAllocation()`, and either auto-executes or queues for
multi-sig approval.

**Risk:** zero — evaluator is pure and tested.

---

## 6. 48-hour broadcast timeout / address-modification cooldown

**What's deferred:** the cron that flips stuck `BROADCASTING` withdrawals
to `FAILED` after 48h, and the 48h cooldown enforcement on withdrawal
address modifications.

**What's done:** the state machine itself supports `BROADCASTING → FAILED`
explicitly via `markFailedAndRollback()`.

**Lands in:** M10 (Operations).

---

## 7. Solana smart contracts

**What's deferred:** all on-chain code — `commitRound`, `commitJackpot`,
`settlement_receipt`, the Anchor (Rust) programs themselves.

**What's done:** nothing on-chain. Settlement receipts have a SHA-256
`hash` field designed for future Solana commitment, but the upload path
isn't wired.

**Lands in:** M2 (Texas Hold'em + Commit-Reveal). Spec §6 calls out the
full provably-fair flow.

---

## 8. Three-region multi-node deployment

**What's deferred:** deployment to Singapore + Tokyo + Hong Kong.
WAL degradation, dynamic optimal node routing, table migration.

**What's done:** code is region-agnostic; MongoDB Replica Set works.
`docker-compose.yml` runs single-node Mongo for local dev.

**Lands in:** M1 W2 (originally "M1b" infrastructure).

---

## Summary

Every deferred item has:
1. The M1 piece that's done (most are interfaces / primitives).
2. The milestone it lands in.
3. A risk assessment.

Approving the schema-review packet implies acceptance of these deferrals.
If you want any of them pulled into M1 instead, mark "CHANGES REQUESTED"
on the relevant schema-review section.
