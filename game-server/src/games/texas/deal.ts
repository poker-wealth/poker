import type { Card } from '../../cards/card.js';

/**
 * Texas Hold'em dealing protocol (deterministic — reproducible from the
 * provably-fair deck).
 *
 * Dealing order from the top of the shuffled deck (index 0 first):
 *   - 2 hole cards to each of N players: indices 0 .. 2N-1
 *     (player p gets indices p and p+N — i.e. one card per player per round,
 *      matching real round-robin dealing)
 *   - flop:  indices 2N, 2N+1, 2N+2
 *   - turn:  index 2N+3
 *   - river: index 2N+4
 *
 * No burn cards: with a provably-fair shuffle, burning adds nothing to
 * fairness and only complicates verification. The protocol is fixed and
 * public so any verifier re-derives the exact same deal from the seed.
 *
 * Requires a 52-card deck and 2..10 players (max 10 → 20 hole + 5 board = 25 ≤ 52).
 */

export interface HoldemDeal {
  /** Per-player hole cards, in player-index order. Each inner array has 2 cards. */
  holeCards: Card[][];
  flop: [Card, Card, Card];
  turn: Card;
  river: Card;
  /** flop + turn + river, the 5 community cards. */
  board: Card[];
}

export function dealHoldem(deck: readonly Card[], numPlayers: number): HoldemDeal {
  if (deck.length !== 52) throw new Error(`dealHoldem: expected 52-card deck, got ${deck.length}`);
  if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 10) {
    throw new Error('dealHoldem: numPlayers must be an integer in 2..10');
  }

  const holeCards: Card[][] = Array.from({ length: numPlayers }, () => []);
  // Round-robin: round 1 gives each player their first card, round 2 the second.
  for (let round = 0; round < 2; round++) {
    for (let p = 0; p < numPlayers; p++) {
      const idx = round * numPlayers + p;
      holeCards[p]!.push(deck[idx]!);
    }
  }

  const base = numPlayers * 2;
  const flop: [Card, Card, Card] = [deck[base]!, deck[base + 1]!, deck[base + 2]!];
  const turn = deck[base + 3]!;
  const river = deck[base + 4]!;

  return { holeCards, flop, turn, river, board: [...flop, turn, river] };
}
