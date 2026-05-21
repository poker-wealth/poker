import {
  RANKS,
  SUITS,
  cardId,
  compareCardsHighFirst,
  makeCard,
  parseCardId,
  rankValueOf,
} from '../../src/cards/card';

describe('cards/card', () => {
  it('exports 13 ranks and 4 suits', () => {
    expect(RANKS).toHaveLength(13);
    expect(SUITS).toHaveLength(4);
  });

  it('rankValueOf maps low to high (2..14, A=14)', () => {
    expect(rankValueOf('2')).toBe(2);
    expect(rankValueOf('T')).toBe(10);
    expect(rankValueOf('A')).toBe(14);
  });

  it('makeCard + cardId round-trip', () => {
    expect(cardId(makeCard('A', 'h'))).toBe('Ah');
    expect(parseCardId('Ah')).toEqual(makeCard('A', 'h'));
  });

  it('parseCardId rejects malformed ids', () => {
    expect(() => parseCardId('A')).toThrow();
    expect(() => parseCardId('Ahx')).toThrow();
    expect(() => parseCardId('1h')).toThrow(/rank/);
    expect(() => parseCardId('Ax')).toThrow(/suit/);
  });

  it('compareCardsHighFirst sorts by rank desc then suit', () => {
    const cards = [makeCard('2', 'c'), makeCard('A', 'h'), makeCard('A', 's'), makeCard('K', 'd')];
    cards.sort(compareCardsHighFirst);
    expect(cards.map(cardId)).toEqual(['As', 'Ah', 'Kd', '2c']);
  });
});
