#!/usr/bin/env tsx
// FairPlay — Texas Hold'em demo
//
//   npm run texas:demo
//
// Plays a full 3-handed hand with unequal stacks so an all-in produces a
// SIDE POT, then shows the showdown and the exact settlement plan that would
// post to the Financial Core (net deltas, rake, jackpot). No FC or network
// needed — uses the provably-fair seed (offline → KMS fallback) and the pure
// engine + settlement adapter.

process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'error';

import type { Card } from '../src/cards/card.js';
import { buildSettlePotsRequest } from '../src/fc-client/settlement-adapter.js';
import { TexasHoldem } from '../src/games/texas/texas-holdem.js';
import { localCsprng } from '../src/provably-fair/kms.js';
import { beginRound } from '../src/provably-fair/round-randomness.js';
import type { DrandClientOptions } from '../src/provably-fair/drand.js';

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const drand: DrandClientOptions = { urls: ['https://drand.invalid'], timeoutMs: 50, fetchFn: async () => { throw new Error('offline'); } };
const usd = (cents: bigint): string => `$${(Number(cents) / 100).toFixed(2)}`;
function pc(card: Card): string {
  const sym = { c: '♣', d: '♦', h: '♥', s: '♠' }[card.suit]!;
  const f = `${card.rank}${sym}`;
  return card.suit === 'h' || card.suit === 'd' ? c.red(f) : f;
}
function section(t: string): void {
  console.log(`\n${c.bold(c.cyan(`▶ ${t}`))}`);
}

async function main(): Promise<void> {
  console.log(c.bold("\nFairPlay — Texas Hold'em Demo (3-handed, side pot)"));
  console.log(c.dim('======================================================'));

  const game = new TexasHoldem({
    tableId: 'demo-table',
    tableType: 'PLATFORM',
    minPlayers: 2,
    maxPlayers: 6,
    smallBlind: 50n,
    bigBlind: 100n,
  });

  // Unequal stacks → guarantees a side pot when all go all-in.
  const players: Array<[string, bigint]> = [
    ['Alice', 2_000n], // $20 short stack
    ['Bob', 10_000n], // $100
    ['Carol', 10_000n], // $100
  ];
  players.forEach(([name, stack], i) => {
    game.join(name, i);
    game.buyIn(name, stack);
  });

  section('Step 1 — Commit + deal (provably fair)');
  const seed = await beginRound('texas-demo-1', { drand, cloud: localCsprng });
  game.startHand({ roundId: 'texas-demo-1', finalSeed: seed.finalSeed });
  console.log(`  server commit: ${c.yellow(seed.serverCommit)}  ${c.dim('(published before the deal)')}`);
  console.log(`  randomness:    ${c.yellow(seed.randomSource)}  ${c.dim('(offline demo → KMS fallback)')}`);
  console.log('');
  for (const [name] of players) {
    const view = game.getPrivateView(name) as { holeCards: string[] };
    const cards = view.holeCards.map((id) => pc({ rank: id[0] as never, suit: id[1] as never, rankValue: 0 }));
    const stack = (game.getPublicState() as { players: Array<{ playerId: string; stack: string }> }).players.find((p) => p.playerId === name)!;
    console.log(`  ${name.padEnd(6)} ${cards.join(' ')}   ${c.dim('stack ' + usd(BigInt(stack.stack)))}`);
  }

  section('Step 2 — Everyone goes all-in (preflop)');
  let guard = 0;
  while (game.state !== 'SETTLED' && guard++ < 60) {
    const pub = game.getPublicState() as {
      actor: string | null;
      currentBet: string;
      players: Array<{ playerId: string; stack: string; streetCommitted: string }>;
    };
    const actor = pub.actor;
    if (!actor) break;
    const me = pub.players.find((p) => p.playerId === actor)!;
    const target = BigInt(me.stack) + BigInt(me.streetCommitted);
    const toCall = BigInt(pub.currentBet) - BigInt(me.streetCommitted);
    let r = game.applyAction(actor, { type: 'raise', payload: { amount: target.toString() } });
    if (!r.ok) r = game.applyAction(actor, { type: toCall === 0n ? 'check' : 'call' });
    if (r.ok) console.log(`  ${c.dim(actor + ' all-in/calls')}`);
  }

  const result = game.getHandResult()!;
  section('Step 3 — Board + showdown');
  console.log(`  Board: ${result.board.map((id) => pc({ rank: id[0] as never, suit: id[1] as never, rankValue: 0 })).join(' ')}`);
  console.log('');
  console.log(`  ${c.bold('Pot awards (main + side pots):')}`);
  for (const award of result.potAwards) {
    console.log(`    ${usd(award.amount)} → ${c.green(award.winners.join(', '))}`);
  }
  console.log(`\n  ${c.bold('Per-player net:')}`);
  for (const p of result.players) {
    const net = p.net >= 0n ? c.green('+' + usd(p.net)) : c.red('-' + usd(-p.net));
    console.log(`    ${p.playerId.padEnd(6)} ${net}${p.bestHand ? c.dim('  ' + p.bestHand.replace(/_/g, ' ').toLowerCase()) : ''}`);
  }

  section('Step 4 — Settlement plan (what posts to the Financial Core)');
  const rakeCents = (() => {
    const r = (result.potTotal * 5n) / 100n;
    return r > 300n ? 300n : r;
  })();
  const req = buildSettlePotsRequest(result, { tableType: 'PLATFORM', rakeCents });
  console.log(`  POST /api/v1/internal/settle-pots`);
  console.log(`  ${c.dim('rake:')} ${usd(BigInt(req.rake_amount))}  ${c.dim('(5% capped at $3)')}`);
  console.log(`  ${c.dim('net deltas (sum to 0 — engine conserves chips):')}`);
  for (const d of req.net_deltas) {
    console.log(`    ${d.owner_id.padEnd(6)} ${d.net}`);
  }
  const sum = req.net_deltas.reduce((s, d) => s + BigInt(d.net), 0n);
  console.log(`    ${c.dim('sum = ' + sum.toString())}`);

  console.log(c.dim('\n======================================================'));
  console.log(
    c.bold('Takeaway: ') +
      'one short stack → a side pot only the bigger stacks can win. The engine\n' +
      'conserves every chip; the Financial Core applies rake + the 0.5% jackpot at\n' +
      'settlement. Verify the deal anytime at /verify.html with the round id.',
  );
}

main().catch((err) => {
  console.error(c.red(`\nfatal: ${err instanceof Error ? err.stack : String(err)}`));
  process.exit(1);
});
