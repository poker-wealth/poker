# poker

FairPlay multi-game fair gaming platform — umbrella repo.

## Layout

```
poker/                          <- this repo (poker-wealth/poker)
  FairPlay_v5.9_FINAL_EN.docx
  FairPlay_12Week_Milestone_EN.docx
  README.md
  CODEOWNERS                    <- 2-reviewer rule scoped via paths
  .github/workflows/            <- CI per package, path-filtered
  financial-core/               <- /api/v1/, ledger, settlement, jackpot, insurance
  game-server/                  (later — W3+)
  client/                       (later — Expo Bare Workflow, W2+)
  contracts/                    (later — Solana + Anchor, W2+)
  infra/                        (later — Cloudflare, MongoDB, Redis configs)
```

## Spec source of truth

- [FairPlay_v5.9_FINAL_EN.docx](FairPlay_v5.9_FINAL_EN.docx) — full technical engineering spec (28 weeks / 14 milestones).
- [FairPlay_12Week_Milestone_EN.docx](FairPlay_12Week_Milestone_EN.docx) — accelerated 12-week milestone plan with daily tasks, deliverables, acceptance criteria, and the 51-item Master Acceptance gate.

## Active milestone — M1 / Week 1: Financial Core foundation

See [financial-core/README.md](financial-core/README.md). Current status: scaffolding complete, schema and `transfer()` next.
