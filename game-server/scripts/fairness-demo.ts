#!/usr/bin/env tsx
// FairPlay — provably-fair demo
//
//   npm run fairness:demo
//
// Deals one real Texas Hold'em hand, names the winner, then PROVES the deal
// was fair using the 5-step verification — and finally tampers with a card
// to show that verification CATCHES it.
//
// Uses the real public drand beacon if reachable (and re-fetches the exact
// round to verify independently). Falls back to the offline KMS-only path if
// there's no internet — the demo works either way.

process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'error'; // quiet the logger; this script prints its own output

import { cardId, type Card } from '../src/cards/card.js';
import { freshDeck, shuffleDeck } from '../src/cards/deck.js';
import { evaluateBestFive } from '../src/cards/hand-eval.js';
import { dealHoldem } from '../src/games/texas/deal.js';
import {
  fetchDrandRound,
  type DrandClientOptions,
  type FetchFn,
} from '../src/provably-fair/drand.js';
import { localCsprng } from '../src/provably-fair/kms.js';
import { beginRound } from '../src/provably-fair/round-randomness.js';
import { verifyReveal, type RevealReceipt } from '../src/provably-fair/verification.js';

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const DRAND_URLS = ['https://api.drand.sh', 'https://drand.cloudflare.com'];
const realFetch: FetchFn = (url, init) =>
  fetch(url, { signal: init?.signal }).then((r) => ({
    ok: r.ok,
    status: r.status,
    json: () => r.json(),
  }));

// Pretty card with suit symbol + color.
function pc(card: Card): string {
  const sym = { c: '♣', d: '♦', h: '♥', s: '♠' }[card.suit]!;
  const face = `${card.rank}${sym}`;
  return card.suit === 'h' || card.suit === 'd' ? c.red(face) : face;
}
function pcards(cards: Card[]): string {
  return cards.map(pc).join(' ');
}
function section(t: string): void {
  console.log(`\n${c.bold(c.cyan(`▶ ${t}`))}`);
}

const PLAYERS = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'];

async function main(): Promise<void> {
  console.log(c.bold('\nFairPlay — Provably-Fair Hand Demo'));
  console.log(c.dim('======================================================'));

  const roundId = `demo-${Date.now()}`;
  const drandOpts: DrandClientOptions = { urls: DRAND_URLS, timeoutMs: 5000, fetchFn: realFetch };

  // ── 1. BEFORE dealing: commit ───────────────────────────────────
  section('Step 1 — Commit (happens BEFORE any card is dealt)');
  console.log(c.dim('  The server generates a secret seed and publishes its fingerprint (hash).'));
  console.log(c.dim('  It is now LOCKED IN — the server cannot change the seed after this point.'));

  const seed = await beginRound(roundId, { drand: drandOpts, cloud: localCsprng });

  console.log(`  round id:       ${c.yellow(roundId)}`);
  console.log(`  server commit:  ${c.yellow(seed.serverCommit)}  ${c.dim('← published now')}`);
  if (seed.randomSource === 'drand' && seed.drand) {
    console.log(
      `  drand round:    ${c.yellow(String(seed.drand.round))}  ${c.dim(`(public beacon: ${seed.drand.source})`)}`,
    );
  } else {
    console.log(
      `  drand:          ${c.yellow('offline')}  ${c.dim('(no internet — using KMS-only fallback path)')}`,
    );
  }
  console.log(c.dim('  server seed is still SECRET at this point.'));

  // ── 2. Deal ─────────────────────────────────────────────────────
  section('Step 2 — Deal the hand');
  console.log(c.dim('  The deck is shuffled deterministically from the final mixed seed,'));
  console.log(c.dim('  then dealt by the fixed public protocol (2 hole cards each, then board).'));

  const deck = shuffleDeck(freshDeck(), seed.finalSeed);
  const numPlayers = PLAYERS.length;
  const deal = dealHoldem(deck, numPlayers);

  console.log('');
  for (let p = 0; p < numPlayers; p++) {
    console.log(`  ${PLAYERS[p]!.padEnd(6)}  ${pcards(deal.holeCards[p]!)}`);
  }
  console.log(`\n  Board:  ${pcards(deal.flop)}  ${pc(deal.turn)}  ${pc(deal.river)}`);
  console.log(c.dim('          (flop)        (turn) (river)'));

  // ── 3. Showdown ─────────────────────────────────────────────────
  section('Step 3 — Showdown (best 5 of 7 for each player)');
  let best: { player: string; rankName: string; rank: number; cards: Card[] } | null = null;
  for (let p = 0; p < numPlayers; p++) {
    const seven = [...deal.holeCards[p]!, ...deal.board];
    const r = evaluateBestFive(seven);
    console.log(
      `  ${PLAYERS[p]!.padEnd(6)}  ${pcards(r.bestFive)}  ${c.dim(r.categoryName.replace(/_/g, ' ').toLowerCase())}`,
    );
    if (!best || r.rank > best.rank) {
      best = { player: PLAYERS[p]!, rankName: r.categoryName, rank: r.rank, cards: r.bestFive };
    }
  }
  console.log(
    `\n  ${c.bold(c.green(`Winner: ${best!.player}`))} with ${c.green(best!.rankName.replace(/_/g, ' ').toLowerCase())}  ${pcards(best!.cards)}`,
  );

  // ── 4. Reveal + verify ──────────────────────────────────────────
  section('Step 4 — Reveal the secret seed, then VERIFY the hand was fair');
  console.log(`  server seed (revealed):  ${c.magenta(seed.serverSeedHex)}`);

  const receipt: RevealReceipt = {
    roundId: seed.roundId,
    serverSeedHex: seed.serverSeedHex,
    serverCommit: seed.serverCommit,
    finalSeedHex: seed.finalSeedHex,
    randomSource: seed.randomSource,
    cloudRandomHex: seed.cloudRandomHex,
    drand: seed.drand,
    dealtDeck: deck.map(cardId),
  };

  // Independent V2: re-fetch the exact drand round and confirm it matches.
  let externalDrandHex: string | undefined;
  if (seed.randomSource === 'drand' && seed.drand) {
    try {
      const reFetched = await fetchDrandRound(seed.drand.round, drandOpts);
      externalDrandHex = reFetched.randomnessHex;
      console.log(
        c.dim(`  (independently re-fetched drand round ${seed.drand.round} for V2 verification)`),
      );
    } catch {
      console.log(c.dim('  (could not re-fetch drand round for V2; will report as skipped)'));
    }
  }

  const result = verifyReveal(receipt, externalDrandHex);
  console.log('');
  printCheck('V1  server seed matches the pre-published commit', result.checks.v1_commit);
  printCheck('V2  drand randomness matches the public beacon', result.checks.v2_drand);
  printCheck('V3  re-shuffling the revealed seed reproduces the EXACT deck', result.checks.v3_shuffle);
  printCheck('V4  Solana on-chain timestamp', result.checks.v4_onchain);
  printCheck('V5  probability-table hash', result.checks.v5_probability_table);
  console.log(
    `\n  ${result.ok ? c.bold(c.green('✓ HAND VERIFIED FAIR')) : c.bold(c.red('✗ VERIFICATION FAILED'))}`,
  );

  // ── 5. Tamper test ──────────────────────────────────────────────
  section('Step 5 — Tamper test: what if someone faked the cards?');
  console.log(c.dim('  We swap two cards in the "dealt" deck and re-run verification.'));
  const tampered: RevealReceipt = { ...receipt, dealtDeck: [...receipt.dealtDeck] };
  const t0 = tampered.dealtDeck[0]!;
  tampered.dealtDeck[0] = tampered.dealtDeck[1]!;
  tampered.dealtDeck[1] = t0;

  const tamperResult = verifyReveal(tampered, externalDrandHex);
  console.log('');
  printCheck('V3  re-shuffling the revealed seed reproduces the EXACT deck', tamperResult.checks.v3_shuffle);
  console.log(
    `\n  ${tamperResult.ok ? c.red('✗ tamper NOT detected (bug!)') : c.bold(c.green('✓ TAMPER DETECTED — verification correctly rejected the faked deck'))}`,
  );

  console.log(c.dim('\n======================================================'));
  console.log(
    c.bold('Takeaway: ') +
      'the cards are a pure function of a seed committed BEFORE the deal.\n' +
      'No one — not even the platform — can predict or change them. Anyone can verify.',
  );
}

function printCheck(label: string, status: 'pass' | 'fail' | 'skipped'): void {
  const tag =
    status === 'pass' ? c.green('PASS') : status === 'fail' ? c.red('FAIL') : c.dim('skipped');
  console.log(`  ${tag.padEnd(status === 'skipped' ? 16 : 13)} ${label}`);
}

main().catch((err) => {
  console.error(c.red(`\nfatal: ${err instanceof Error ? err.stack : String(err)}`));
  process.exit(1);
});
