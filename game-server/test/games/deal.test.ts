import { sha256 } from '@noble/hashes/sha256';
import { cardId } from '../../src/cards/card';
import { freshDeck, shuffleDeck } from '../../src/cards/deck';
import { dealHoldem } from '../../src/games/texas/deal';

const seed = sha256(new TextEncoder().encode('deal-test'));

describe('games/texas/deal', () => {
  it('deals 2 hole cards per player + 5 board cards, all distinct', () => {
    const deck = shuffleDeck(freshDeck(), seed);
    const d = dealHoldem(deck, 6);
    expect(d.holeCards).toHaveLength(6);
    for (const hc of d.holeCards) expect(hc).toHaveLength(2);
    expect(d.flop).toHaveLength(3);
    expect(d.board).toHaveLength(5);

    const all = [...d.holeCards.flat(), ...d.board].map(cardId);
    expect(new Set(all).size).toBe(all.length); // no duplicates
    expect(all.length).toBe(6 * 2 + 5);
  });

  it('is deterministic — same deck → same deal', () => {
    const deck = shuffleDeck(freshDeck(), seed);
    const a = dealHoldem(deck, 4);
    const b = dealHoldem(deck, 4);
    expect(a.holeCards.flat().map(cardId)).toEqual(b.holeCards.flat().map(cardId));
    expect(a.board.map(cardId)).toEqual(b.board.map(cardId));
  });

  it('round-robin: player p gets deck[p] and deck[p+N]', () => {
    const deck = shuffleDeck(freshDeck(), seed);
    const n = 3;
    const d = dealHoldem(deck, n);
    for (let p = 0; p < n; p++) {
      expect(cardId(d.holeCards[p]![0]!)).toBe(cardId(deck[p]!));
      expect(cardId(d.holeCards[p]![1]!)).toBe(cardId(deck[p + n]!));
    }
    // board starts at 2N.
    expect(cardId(d.flop[0])).toBe(cardId(deck[2 * n]!));
    expect(cardId(d.river)).toBe(cardId(deck[2 * n + 4]!));
  });

  it('rejects bad deck size and player counts', () => {
    expect(() => dealHoldem(freshDeck().slice(0, 40), 4)).toThrow(/52-card/);
    expect(() => dealHoldem(freshDeck(), 1)).toThrow(/2\.\.10/);
    expect(() => dealHoldem(freshDeck(), 11)).toThrow(/2\.\.10/);
  });

  it('supports the max 10 players (25 cards used, ≤ 52)', () => {
    const deck = shuffleDeck(freshDeck(), seed);
    const d = dealHoldem(deck, 10);
    const used = d.holeCards.flat().length + d.board.length;
    expect(used).toBe(25);
  });
});
