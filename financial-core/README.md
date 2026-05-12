# @fairplay/financial-core

The single source of truth for all fund movements on the FairPlay platform.
All games and services interact with money exclusively through `/api/v1/`.
Direct DB writes to balance fields are prohibited.

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
cp .env.example .env       # fill in secrets
npm install
npm run mongo:rs:start     # bootstraps a local single-node Replica Set
npm run dev                # tsx watch on src/index.ts
```

Run tests:

```bash
npm test
npm run test:coverage
```

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
