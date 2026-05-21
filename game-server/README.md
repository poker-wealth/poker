# @fairplay/game-server

The game runtime: the Unified State Machine, the 9 game engines, and the
Commit-Reveal provably-fair system. Talks to `financial-core` over its
`/api/v1/internal/*` HTTP API for all money movements — game-server never
touches a database balance directly.

> Iron rule (spec §7): the client only displays and sends requests; all game
> state changes go through the StateMachine; all money goes through the
> Financial Core API.

## What lives here (M2 in progress)

- `cards/` — 52-card primitives, deterministic seeded shuffle, 7-card best-5 evaluation.
- `provably-fair/` — Commit-Reveal: server_seed → commitment → drand+KMS triple-mix → verifiable deck.
- `state-machine/` — BaseGame, StateMachine, TurnManager, EventBus, RoomManager.
- `games/texas/` — Texas Hold'em (M2). Other games land in M3–M5.
- `jackpot/` — per-table trigger logic (FC handles the actual fund injection).
- `insurance/` — Underwriting Engine (Texas-only MVP).
- `fc-client/` — typed HTTP client for financial-core `/internal/*`.

## Stack

- Node.js 20 LTS, TypeScript 5 (strict), Jest + ts-jest.
- `@noble/hashes` for SHA-256 (Commit-Reveal, deck DRBG, receipt hashing).
- No database — game-server is stateless w.r.t. money; all state goes through FC.

## Quick start

```bash
cp .env.example .env
npm install
npm test            # pure-logic tests, no infrastructure needed
```

## Provably-fair, in one paragraph

When a hand starts, the server generates a `server_seed`, publishes
`server_commit = SHA256(server_seed)` BEFORE dealing, then mixes the seed
with public `drand` randomness and AWS KMS randomness to derive `final_seed`.
The deck is a deterministic Fisher-Yates shuffle of `final_seed`. After the
hand, the server reveals `server_seed`. Anyone can verify:
`SHA256(server_seed) == server_commit`, that the drand value matches the
public drand network, and that re-shuffling with `final_seed` reproduces the
exact deck that was dealt. No one — not even us — can predict or alter cards.
