import type { Card, Rank } from './card.js';
import { rankValueOf } from './card.js';

/**
 * 7-card best-5 hand evaluation for Texas Hold'em.
 *
 * Returns a `HandResult` whose `.rank` is a single integer comparable with
 * `>` — higher wins, equal ties. Encoding packs (category, 5 kickers) so
 * comparison is one subtraction.
 *
 *   rank = category·16^5 + k1·16^4 + k2·16^3 + k3·16^2 + k4·16 + k5
 *   category 0..8 (high card → straight flush); each kicker 2..14.
 *
 * Fits inside a JS-safe integer. Clear over clever — this is verifier code
 * replayed by untrusted clients.
 */

export const HAND_CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
} as const;

export type HandCategoryName = keyof typeof HAND_CATEGORY;
export type HandCategoryValue = (typeof HAND_CATEGORY)[HandCategoryName];

export interface HandResult {
  rank: number;
  category: HandCategoryValue;
  categoryName: HandCategoryName;
  bestFive: Card[];
  kickers: number[];
}

const SHIFT = 16;

const CATEGORY_NAME = Object.fromEntries(
  Object.entries(HAND_CATEGORY).map(([k, v]) => [v, k as HandCategoryName]),
) as Record<HandCategoryValue, HandCategoryName>;

function encode(category: HandCategoryValue, kickers: number[]): number {
  if (kickers.length !== 5) throw new Error('encode: expected 5 kickers');
  let v: number = category;
  for (const k of kickers) v = v * SHIFT + k;
  return v;
}

function result(category: HandCategoryValue, bestFive: Card[], kickers: number[]): HandResult {
  return { rank: encode(category, kickers), category, categoryName: CATEGORY_NAME[category], bestFive, kickers };
}

export function evaluateBestFive(cards: Card[]): HandResult {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluateBestFive: need 5..7 cards, got ${cards.length}`);
  }

  const sorted = [...cards].sort((a, b) => b.rankValue - a.rankValue);

  const cardsByRank = new Map<Rank, Card[]>();
  const rankCount = new Map<Rank, number>();
  let rankMask = 0;
  for (const c of sorted) {
    rankCount.set(c.rank, (rankCount.get(c.rank) ?? 0) + 1);
    const list = cardsByRank.get(c.rank) ?? [];
    list.push(c);
    cardsByRank.set(c.rank, list);
    rankMask |= 1 << (c.rankValue - 2);
  }

  const suitCards = new Map<string, Card[]>();
  const suitRankMask = new Map<string, number>();
  for (const c of sorted) {
    const list = suitCards.get(c.suit) ?? [];
    list.push(c);
    suitCards.set(c.suit, list);
    suitRankMask.set(c.suit, (suitRankMask.get(c.suit) ?? 0) | (1 << (c.rankValue - 2)));
  }

  // 1) Straight flush.
  for (const [suit, mask] of suitRankMask.entries()) {
    if ((suitCards.get(suit)?.length ?? 0) < 5) continue;
    const high = highestStraightFromMask(mask);
    if (high !== null) {
      const cs = pickStraightCards(suitCards.get(suit)!, high);
      return result(HAND_CATEGORY.STRAIGHT_FLUSH, cs, cs.map((c) => c.rankValue));
    }
  }

  const quadRanks = sortRanksDesc([...rankCount.entries()].filter(([, n]) => n === 4).map(([r]) => r));
  const tripRanks = sortRanksDesc([...rankCount.entries()].filter(([, n]) => n === 3).map(([r]) => r));
  const pairRanks = sortRanksDesc([...rankCount.entries()].filter(([, n]) => n === 2).map(([r]) => r));

  // 2) Quads.
  if (quadRanks.length > 0) {
    const q = quadRanks[0]!;
    const quadCards = cardsByRank.get(q)!;
    const kicker = sorted.find((c) => c.rank !== q)!;
    const qv = rankValueOf(q);
    return result(HAND_CATEGORY.QUADS, [...quadCards, kicker], [qv, qv, qv, qv, kicker.rankValue]);
  }

  // 3) Full house.
  if (tripRanks.length > 0 && (pairRanks.length > 0 || tripRanks.length > 1)) {
    const t = tripRanks[0]!;
    const p =
      pairRanks[0] !== undefined && (tripRanks.length < 2 || rankValueOf(pairRanks[0]!) > rankValueOf(tripRanks[1]!))
        ? pairRanks[0]!
        : tripRanks[1]!;
    const tripCards = cardsByRank.get(t)!;
    const pairCards = cardsByRank.get(p)!.slice(0, 2);
    const tv = rankValueOf(t);
    const pv = rankValueOf(p);
    return result(HAND_CATEGORY.FULL_HOUSE, [...tripCards, ...pairCards], [tv, tv, tv, pv, pv]);
  }

  // 4) Flush.
  for (const list of suitCards.values()) {
    if (list.length >= 5) {
      const top5 = list.slice(0, 5);
      return result(HAND_CATEGORY.FLUSH, top5, top5.map((c) => c.rankValue));
    }
  }

  // 5) Straight.
  const straightHigh = highestStraightFromMask(rankMask);
  if (straightHigh !== null) {
    const cs = pickStraightCards(sorted, straightHigh);
    return result(HAND_CATEGORY.STRAIGHT, cs, cs.map((c) => c.rankValue));
  }

  // 6) Trips.
  if (tripRanks.length > 0) {
    const t = tripRanks[0]!;
    const tripCards = cardsByRank.get(t)!;
    const kickers = sorted.filter((c) => c.rank !== t).slice(0, 2);
    const tv = rankValueOf(t);
    return result(HAND_CATEGORY.TRIPS, [...tripCards, ...kickers], [tv, tv, tv, kickers[0]!.rankValue, kickers[1]!.rankValue]);
  }

  // 7) Two pair.
  if (pairRanks.length >= 2) {
    const hi = pairRanks[0]!;
    const lo = pairRanks[1]!;
    const hiCards = cardsByRank.get(hi)!.slice(0, 2);
    const loCards = cardsByRank.get(lo)!.slice(0, 2);
    const kicker = sorted.find((c) => c.rank !== hi && c.rank !== lo)!;
    const hv = rankValueOf(hi);
    const lv = rankValueOf(lo);
    return result(HAND_CATEGORY.TWO_PAIR, [...hiCards, ...loCards, kicker], [hv, hv, lv, lv, kicker.rankValue]);
  }

  // 8) Pair.
  if (pairRanks.length === 1) {
    const p = pairRanks[0]!;
    const pairCards = cardsByRank.get(p)!.slice(0, 2);
    const kickers = sorted.filter((c) => c.rank !== p).slice(0, 3);
    const pv = rankValueOf(p);
    return result(
      HAND_CATEGORY.PAIR,
      [...pairCards, ...kickers],
      [pv, pv, kickers[0]!.rankValue, kickers[1]!.rankValue, kickers[2]!.rankValue],
    );
  }

  // 9) High card.
  const top5 = sorted.slice(0, 5);
  return result(HAND_CATEGORY.HIGH_CARD, top5, top5.map((c) => c.rankValue));
}

function sortRanksDesc(ranks: Rank[]): Rank[] {
  return [...ranks].sort((a, b) => rankValueOf(b) - rankValueOf(a));
}

/** Highest card value of a 5-card straight in `mask`, or null. Wheel (A2345) → 5. */
function highestStraightFromMask(mask: number): number | null {
  for (let high = 14; high >= 6; high--) {
    const lowBit = high - 2 - 4;
    const window = ((1 << 5) - 1) << lowBit;
    if ((mask & window) === window) return high;
  }
  const WHEEL = (1 << 12) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);
  if ((mask & WHEEL) === WHEEL) return 5;
  return null;
}

/** 5 cards forming the straight, one per required rank. Handles the wheel. */
function pickStraightCards(cardsHighFirst: Card[], straightHigh: number): Card[] {
  const wanted =
    straightHigh === 5
      ? [5, 4, 3, 2, 14]
      : [straightHigh, straightHigh - 1, straightHigh - 2, straightHigh - 3, straightHigh - 4];
  const picked: Card[] = [];
  for (const v of wanted) {
    const found = cardsHighFirst.find((c) => c.rankValue === v && !picked.includes(c));
    if (!found) throw new Error('pickStraightCards: missing expected rank — caller bug');
    picked.push(found);
  }
  return picked;
}

/** Positive if a beats b, negative if b beats a, 0 if tie. */
export function compareHands(a: HandResult, b: HandResult): number {
  return a.rank - b.rank;
}
