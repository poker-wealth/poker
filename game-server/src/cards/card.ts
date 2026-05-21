/**
 * 52-card playing-card primitives. Shared by Texas Hold'em, Niu Niu,
 * Baccarat, Dou Di Zhu, and San Zhang.
 *
 * Encoding:
 *   - Suits: c, d, h, s   (clubs, diamonds, hearts, spades)
 *   - Ranks: 2..9, T, J, Q, K, A    (T = ten; single-char keeps deck strings short)
 *
 * Two representations:
 *   - `Card` object   — { suit, rank, rankValue } for game logic
 *   - `CardId` string — "Ah", "Td", "2c"  for serialization / receipts
 *
 * `rankValue` is the natural ordinal (2..14, A=14). Ace-low straights are
 * handled in hand-eval, not here.
 */

export const SUITS = ['c', 'd', 'h', 's'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export type Rank = (typeof RANKS)[number];

export type CardId = `${Rank}${Suit}`;

export interface Card {
  rank: Rank;
  suit: Suit;
  rankValue: number;
}

const RANK_VALUE: Readonly<Record<Rank, number>> = Object.freeze({
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
});

export function rankValueOf(rank: Rank): number {
  return RANK_VALUE[rank];
}

export function makeCard(rank: Rank, suit: Suit): Card {
  return { rank, suit, rankValue: RANK_VALUE[rank] };
}

export function cardId(card: Card): CardId {
  return `${card.rank}${card.suit}` as CardId;
}

export function parseCardId(id: string): Card {
  if (id.length !== 2) throw new Error(`parseCardId: expected 2 chars, got ${JSON.stringify(id)}`);
  const rank = id[0] as Rank;
  const suit = id[1] as Suit;
  if (!(RANKS as readonly string[]).includes(rank)) throw new Error(`parseCardId: invalid rank ${rank}`);
  if (!(SUITS as readonly string[]).includes(suit)) throw new Error(`parseCardId: invalid suit ${suit}`);
  return makeCard(rank, suit);
}

/** Stable ordering: by rankValue descending, then suit (s, h, d, c). */
export function compareCardsHighFirst(a: Card, b: Card): number {
  if (a.rankValue !== b.rankValue) return b.rankValue - a.rankValue;
  const order: Readonly<Record<Suit, number>> = { s: 0, h: 1, d: 2, c: 3 };
  return order[a.suit] - order[b.suit];
}
