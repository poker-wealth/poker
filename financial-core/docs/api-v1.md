# Financial Core API v1 — Interface Contract

> Status: M1 W1 Day 3 publish. Frontend and game-server begin parallel
> development against this contract using Mock implementations from Day 4.
> The actual HTTP layer in `src/` is scaffolded but not yet wired (in
> progress through M1 W2). The schemas, endpoints, and error model below
> are **frozen** for M1 — changes require schema review.

All FC API endpoints are mounted at the prefix `/api/v1/`.

---

## 1. Authentication

All endpoints require a Bearer JWT via the `Authorization` header.

```
Authorization: Bearer eyJhbGc...
```

JWTs are HS256-signed, with the following required claims:

| Claim | Type | Notes |
|---|---|---|
| `sub` | string | The userId. |
| `iss` | string | Must match `JWT_ISSUER` (default `fairplay`). |
| `aud` | string | Must match `JWT_AUDIENCE` (default `fairplay-fc`). |
| `exp` | number | Unix seconds. Default TTL 1h. |
| `leagueId` | string \| omitted | League context. **Iron rule §11.1: this is the ONLY source of truth for league scope.** Body/query/params `leagueId` is stripped server-side. |
| `roles` | string[] \| omitted | One of `player`, `agent`, `league_admin`, `ops`, `admin`. |

Failure modes:

- Missing/malformed `Authorization` → `401 missing bearer token`.
- Invalid signature / wrong issuer / wrong audience / expired → `401 invalid token`.
- Endpoint requires a role the token doesn't have → `403 forbidden`.

---

## 2. Error model

All error responses use `application/problem+json` (RFC 7807) shape:

```json
{
  "type":     "https://fairplay.app/errors/insufficient-balance",
  "title":    "InsufficientBalance",
  "status":   409,
  "detail":   "account 0192... has 5000 cents, requested 10000",
  "instance": "/api/v1/withdrawals/0192f1c...",
  "code":     "INSUFFICIENT_BALANCE",
  "extra":    { "accountId": "0192...", "requested": "10000", "available": "5000" }
}
```

| `code` | HTTP | Source |
|---|---|---|
| `MISSING_BEARER_TOKEN` | 401 | dataScopeMiddleware |
| `INVALID_TOKEN` | 401 | dataScopeMiddleware |
| `FORBIDDEN` | 403 | requireRole |
| `VALIDATION_FAILED` | 400 | zod schema rejection |
| `ACCOUNT_NOT_FOUND` | 404 | AccountNotFoundError |
| `INSUFFICIENT_BALANCE` | 409 | InsufficientBalanceError |
| `ILLEGAL_FUND_FLOW` | 422 | IllegalFundFlowError (also triggers CB6 alert) |
| `IDEMPOTENT_REPLAY` | 200 | Returned alongside the original result, NOT an error per se. |
| `WITHDRAWAL_NOT_FOUND` | 404 | WithdrawalNotFoundError |
| `ILLEGAL_WITHDRAWAL_TRANSITION` | 409 | IllegalWithdrawalTransitionError |
| `INTERNAL_ERROR` | 500 | Catch-all. |

**Money is always serialized as a string** (`"10000"` not `10000`) to preserve BigInt precision through JSON.

---

## 3. Idempotency

Endpoints that mutate state accept an idempotency key via the `Idempotency-Key` request header. The first call is processed; subsequent calls with the same key return the original result with `X-Idempotent-Replay: true` in response headers.

For settlement and transfer operations, the idempotency key is **required**. For others it's optional but strongly recommended.

```
Idempotency-Key: round-0192f1c8:rake
```

Internal idempotency keys for system-generated operations follow these patterns:

| Operation | Key format |
|---|---|
| `WIN_PAYOUT` (settleRound) | `${roundId}:payout:${loserOwnerId}` |
| `JACKPOT_INJECT` (settleRound) | `${roundId}:jackpot:${tier}` |
| `RAKE` (settleRound) | `${roundId}:rake` |
| `WITHDRAW` (approveWithdrawal) | `withdraw:${withdrawalId}` |
| `WITHDRAW_REFUND` (markFailedAndRollback) | `withdraw-refund:${withdrawalId}` |
| `DEPOSIT` (TRC20 listener) | `deposit:${txHash}` |

---

## 4. Domain endpoints

### 4.1 Player APIs (role: `player`)

#### `GET /api/v1/me/balance`

Returns the authenticated player's balance(s).

**Query params:**
- `scope` (optional) — `PLATFORM` (default) or a leagueId. The middleware also strips this from body/query if attacker-supplied; only the JWT or this explicit scope query is honored.

**Response 200:**
```json
{
  "userId":      "user-0192f1c8...",
  "wallets": [
    {
      "walletScope": "PLATFORM",
      "balance":     "12345600",
      "currency":    "USDT-cents"
    }
  ]
}
```

#### `GET /api/v1/me/transactions`

Player's ledger history (read-only view of `ledger`).

**Query params:** `from`, `to` (ISO datetimes), `type` (LedgerType filter), `limit` (default 50, max 500), `cursor` (opaque).

**Response 200:**
```json
{
  "items": [
    {
      "id":         "0192f1c8...",
      "type":       "RAKE",
      "amount":     "500",
      "direction":  "out",
      "counterparty": { "type": "TREASURY" },
      "status":     "SETTLED",
      "metadata":   { "round_id": "...", "table_id": "..." },
      "created_at": "2026-05-12T...:..."
    }
  ],
  "next_cursor": "eyJ0Ijo..."
}
```

#### `POST /api/v1/me/withdrawals`

Create a withdrawal request. Goes to `REQUESTED` state. **Balance is NOT deducted at this step.**

**Request body:**
```json
{
  "amount":              "5000000",
  "destination_address": "T..." 
}
```

`Idempotency-Key` **required**.

**Response 201:**
```json
{
  "id":        "0192f1c8...",
  "state":     "REQUESTED",
  "amount":    "5000000",
  "destination_address": "T...",
  "created_at": "..."
}
```

#### `GET /api/v1/me/withdrawals/:id`

**Response 200:** the withdrawal doc (any state).

#### `POST /api/v1/me/withdrawals/:id/cancel`

Cancels a `REQUESTED` withdrawal. Player-initiated. → `ROLLED_BACK`. No balance change.

**Response 200:** updated withdrawal doc.

---

### 4.2 Internal server APIs (role: `service` — game-server only)

These endpoints are reachable **only from the game-server** over the internal network; not exposed publicly. Authenticated via a separate service JWT (different `aud`).

#### `POST /api/v1/internal/settle-round`

Settles a single hand atomically (Phase 1 strong consistency, ≤50ms local tx).

**Request body:**
```json
{
  "round_id":         "...",
  "table_id":         "...",
  "table_type":       "PLATFORM",
  "league_id":        null,
  "winner_owner_id":  "user-A",
  "winner_profit":    "10000",
  "rake_amount":      "500",
  "losers": [
    { "owner_id": "user-B", "contribution": "10000" }
  ]
}
```

`Idempotency-Key` **required** (recommended: `settle:${roundId}`).

**Response 200:**
```json
{
  "round_id":   "...",
  "table_id":   "...",
  "sequence":   ["WIN_PAYOUT", "JACKPOT_INJECT", "JACKPOT_INJECT", "JACKPOT_INJECT", "JACKPOT_INJECT", "RAKE"],
  "amounts": {
    "payouts": ["10000"],
    "rake":    "500",
    "jackpot": { "mini": "10", "minor": "15", "major": "12", "grand": "13", "total": "50" }
  },
  "accounts": {
    "winner":         "0192...",
    "losers":         ["0192..."],
    "rake_dest":      "0192...",
    "jackpot_mini":   "0192...",
    "jackpot_minor":  "0192...",
    "jackpot_major":  "0192...",
    "jackpot_grand":  "0192..."
  },
  "ledger_entry_ids": ["0192...", "0192...", "..."],
  "hash":     "<sha256 hex>",
  "duration_ms": 24,
  "replayed": false
}
```

Errors: `409 INSUFFICIENT_BALANCE`, `422 ILLEGAL_FUND_FLOW`.

#### `POST /api/v1/internal/transfer`

Generic transfer. **Restricted use** — most callers should use higher-level
endpoints (settle-round, withdrawal flow). Direct use is for league
top-up/cashout, agent commission (M8), insurance premium (M2), etc.

**Request body:**
```json
{
  "from":         { "type": "PLAYER", "owner_id": "user-A" },
  "to":           { "type": "TREASURY", "owner_id": "PLATFORM" },
  "amount":       "1000",
  "ledger_type":  "RAKE",
  "status":       "SETTLED",
  "metadata":     { }
}
```

`Idempotency-Key` **required**.

**Response 200:** `{ ledger_entry, from_account, to_account, duration_ms, replayed, retries }`.

---

### 4.3 Ops APIs (role: `ops` or `admin`)

#### `GET /api/v1/ops/withdrawals`

Withdrawal queue. Filterable by `state`, `min_amount`, `created_after`.

**Response 200:** paginated list of withdrawal docs.

#### `POST /api/v1/ops/withdrawals/:id/approve`

`REQUESTED → APPROVED`. Atomically deducts balance via the `WITHDRAW`
ledger entry (status `PENDING`).

**Request body (optional):** `{ "note": "..." }`.

Authenticated user is recorded as `reviewed_by`. Required for amounts > $10,000.

**Response 200:** updated withdrawal doc.

#### `POST /api/v1/ops/withdrawals/:id/reject`

`REQUESTED → ROLLED_BACK`. No balance change.

**Request body:** `{ "reason": "KYC mismatch" }`.

#### `POST /api/v1/ops/withdrawals/:id/broadcast`

`APPROVED → BROADCASTING`. Caller provides the on-chain `tx_hash`.

**Request body:** `{ "tx_hash": "0x..." }`.

#### `POST /api/v1/ops/withdrawals/:id/confirm`

`BROADCASTING → CONFIRMED`. Caller asserts 20-block confirmation has happened. Flips ledger entry `PENDING → SETTLED`.

#### `POST /api/v1/ops/withdrawals/:id/fail`

`BROADCASTING → FAILED → ROLLED_BACK` in one call. Auto-creates the `WITHDRAW_REFUND` ledger entry. Balance refunded.

**Request body:** `{ "reason": "tx rejected by node" }`.

---

### 4.4 Health and observability

#### `GET /api/v1/health`

Public (no auth). Returns 200 with `{ status: "ok", mongo: "connected"|"disconnected" }`. Used by load balancers, Kubernetes probes, etc.

#### `GET /api/v1/admin/circuit-breakers`

Admin-only. Returns per-CB status:

```json
{
  "CB1": "STUB",
  "CB2": "STUB",
  "CB3": "STUB",
  "CB4": "STUB",
  "CB5": "STUB",
  "CB6": "ACTIVE",
  "CB7": "STUB"
}
```

---

## 5. Schemas

### 5.1 `AccountRef`

```json
{
  "type":         "PLAYER | TREASURY | INSURANCE | REINSURANCE | LEAGUE_INVENTORY | JACKPOT_MINI | JACKPOT_MINOR | JACKPOT_MAJOR | JACKPOT_GRAND",
  "owner_id":     "string",
  "wallet_scope": "PLATFORM | <leagueId>"
}
```

Validation rules (server-enforced):

| `type` | `owner_id` constraint |
|---|---|
| `PLAYER` | playerId (any non-empty string) |
| `TREASURY` | MUST be `'PLATFORM'` |
| `INSURANCE`, `REINSURANCE` | `'PLATFORM'` or a leagueId |
| `LEAGUE_INVENTORY` | leagueId (must NOT be `'PLATFORM'`) |
| `JACKPOT_MINI/MINOR/MAJOR/GRAND` | tableId |

### 5.2 `LedgerEntry`

```json
{
  "id":               "string (uuidv7)",
  "from_account":     "string | null",
  "to_account":       "string | null",
  "amount":           "string (BigInt cents)",
  "type":             "DEPOSIT | WITHDRAW | WITHDRAW_REFUND | BET | WIN_PAYOUT | RAKE | INSURANCE_PREMIUM | INSURANCE_PAYOUT | REINSURANCE_INJECT | REINSURANCE_PAYOUT | JACKPOT_INJECT | JACKPOT_PAYOUT | LEAGUE_TOPUP | LEAGUE_CASHOUT | AGENT_COMMISSION | AGENT_VIP_BONUS",
  "idempotency_key":  "string",
  "status":           "PENDING | SETTLED | FAILED | ROLLED_BACK",
  "metadata":         {},
  "created_at":       "ISO datetime",
  "updated_at":       "ISO datetime"
}
```

### 5.3 `WithdrawalDoc`

```json
{
  "id":                       "string",
  "player_id":                "string",
  "amount":                   "string (BigInt cents)",
  "destination_address":      "string",
  "state":                    "REQUESTED | APPROVED | BROADCASTING | CONFIRMED | FAILED | ROLLED_BACK",
  "ledger_entry_id":          "string | null",
  "refund_ledger_entry_id":   "string | null",
  "tx_hash":                  "string | null",
  "reviewed_by":              "string | null",
  "failure_reason":           "string | null",
  "state_history": [
    { "state": "REQUESTED", "at": "ISO", "actor": "system | <userId>", "note": "string | undefined" }
  ],
  "created_at":               "ISO",
  "updated_at":               "ISO"
}
```

---

## 6. Out of scope for M1

These endpoints land in later milestones — listed here so frontend/game-server
can plan their integration shape:

| Endpoint | Milestone | Notes |
|---|---|---|
| `POST /api/v1/internal/insurance/quote` | M2 | Underwriting Engine 5-step (pre-calc cache, RiskFactor NOT in response) |
| `POST /api/v1/internal/jackpot/trigger` | M5 | Drives Grand Saturday-window trigger |
| `POST /api/v1/internal/agent-commission/distribute` | M8 | Phase 2 RAKE_QUEUE worker output |
| `GET /api/v1/me/jackpot-history` | M5 | All-time queryable, default 30d |
| `GET /api/v1/me/vip` | M7 | VIP tier + Pro Tracker data (V3+) |
| `POST /api/v1/internal/deposit/credit` | M1 W1 Day 4 | TRC20 listener invokes after 20-block confirm |

---

## 7. Frontend / game-server Mock guidance

Until the HTTP layer is wired (M1 W2), downstream teams should:

1. Generate types from this doc (we'll publish a `.d.ts` package after Day 5).
2. Mock the endpoints above with predictable fixtures.
3. Treat all money as `string` (parse with `BigInt()`).
4. Respect `Idempotency-Key`: replay the original response if the key is seen
   twice within the mock session.
5. Wire CB6 alert subscription in the frontend admin dashboard against the
   eventual `GET /api/v1/admin/circuit-breakers` poll endpoint.

For internal calls (game-server → FC), service-to-service auth will use a
separate JWT issuer (`fairplay-internal`). Schema/details land in Day 5
infra hardening (mTLS + service JWT).
