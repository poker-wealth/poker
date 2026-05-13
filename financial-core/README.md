# @fairplay/financial-core

The single source of truth for all fund movements on the FairPlay platform.
All games and services interact with money exclusively through `/api/v1/`.
Direct DB writes to balance fields are prohibited.

**API contract:** [docs/api-v1.md](docs/api-v1.md) — frontend / game-server build Mocks against this.

**M1 close-out documents:**
- [docs/m1-acceptance.md](docs/m1-acceptance.md) — single-page status of every M1 acceptance item.
- [docs/m1-schema-review.md](docs/m1-schema-review.md) — schema-review packet (your sign-off goes here).
- [docs/m1-deferred-items.md](docs/m1-deferred-items.md) — what we knowingly punted to later milestones.
- [docs/m1-runbook.md](docs/m1-runbook.md) — step-by-step for the user-side tasks.

> Iron rule from spec: **NO module may bypass `transfer()`. NO `UPDATE accounts SET balance = ...`. ALL flows go through the hardcoded `ClearingRules` whitelist.**

## What lives here

- 9 account types: `PLAYER`, `TREASURY`, `INSURANCE`, `REINSURANCE`, `LEAGUE_INVENTORY`, `JACKPOT_MINI`, `JACKPOT_MINOR`, `JACKPOT_MAJOR`, `JACKPOT_GRAND`.
- `accounts` collection (balance + optimistic-lock version) and `ledger` collection (single source of truth, append-only).
- `ClearingRules` whitelist (hardcoded — not admin-configurable).
- `transfer()` — the only mutator. Whitelist + idempotency key + atomic MongoDB transaction (≤50ms local).
- Settlement Engine (Phase 1 strong consistency, Phase 2 async workers).
- Settlement Domain — rake routing hub (Platform → Treasury / League → League Inventory).
- Withdrawal state machine (5 states).
- 7 circuit breakers (CB1–CB7).
- HD wallet derivation (BIP-44) per account type.
- TRC20-USDT deposit listener (20-block confirm, official contract whitelist, no Mempool credit).

## Stack

- Node.js 20 LTS, TypeScript 5 (strict).
- MongoDB 7.0 Replica Set (single-node RS for local dev — Replica Set is required for transactions).
- Redis (Sentinel in prod, single instance for local dev).
- Express + pino + zod + Mongoose 8.

## Quick start

```bash
cp .env.example .env                   # fill in secrets (JWT_SECRET, etc.)
npm install
```

### Run tests

Tests use `mongodb-memory-server`'s in-process Replica Set — no Docker or local Mongo required. The first run downloads a Mongo binary (~120 MB) and caches it.

```bash
npm test                               # runs the full suite (217 tests across 17 suites)
npm run test:coverage
```

### Run the smoke test (end-to-end demo)

```bash
npm run smoke                          # boots in-process Mongo + HTTP server, walks the full M1 journey
```

Output: 34 PASS/FAIL steps covering deposit, settlement, CB6 illegal-flow detection, full withdrawal lifecycle (approve → broadcast → confirm), and the failure → rollback path. Takes ~5 seconds.

### Open the demo UI

```bash
npm run mongo:rs:start                 # bring up Mongo + Redis (requires Docker)
npm run dev                            # boots the FC server on http://localhost:3000
```

Open <http://localhost:3000> in a browser. Sign in as `alice` / `demo` (player), `ops` / `demo` (ops), or `admin` / `demo`. Click the buttons to exercise every M1 capability live.

### Run the dev server (needs MongoDB + Redis)

The dev server connects to a real Replica Set. Two paths to bring one up locally:

**Path A — Docker (recommended):** install [Docker Desktop](https://www.docker.com/products/docker-desktop/), then from the `poker/` umbrella:

```bash
cd ../                                 # poker/
docker compose up -d mongodb redis     # or just `npm run mongo:rs:start` from financial-core/
cd financial-core
npm run mongo:rs:start                 # idempotent: starts containers + initiates rs0
npm run dev                            # tsx watch on src/index.ts
npm run mongo:rs:stop                  # tears down containers (data persists in named volumes)
```

**Path B — Native MongoDB 7.0:** install MongoDB Community 7.0, then start it with `--replSet rs0` and run `rs.initiate()` manually in `mongosh`. Update `MONGO_URI` in `.env`.

## CI gates

Every PR runs `lint + typecheck + test`. Merge to `main` requires:

1. CI green.
2. ≥2 CODEOWNERS approvals (spec mandate).
3. No direct push to `main` — branch protection enforced.

## Hard rules (PR rejection criteria)

- Direct `Account.updateOne({ ... balance ... })` outside `transfer()` → reject.
- Cross-pool flow not in `ClearingRules` whitelist → reject.
- MongoDB transaction touching multiple shards or running >50ms (local time) → reject.
- Floating-point money math → reject. All amounts are `BigInt` cents.
- Mempool deposit credited before 20-block confirmation → reject.
