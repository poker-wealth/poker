import { type Card, parseCardId } from '../../src/cards/card';
import { compareHands, evaluateBestFive } from '../../src/cards/hand-eval';

function hand(...ids: string[]): Card[] {
  return ids.map(parseCardId);
}
function evalIds(...ids: string[]) {
  return evaluateBestFive(hand(...ids));
}

describe('cards/hand-eval — category detection', () => {
  it('straight flush', () => {
    const r = evalIds('9h', '8h', '7h', '6h', '5h', '2c', '2d');
    expect(r.categoryName).toBe('STRAIGHT_FLUSH');
    expect(r.kickers[0]).toBe(9);
  });

  it('royal/broadway straight flush beats a lower straight flush', () => {
    const royal = evalIds('Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d');
    const lower = evalIds('9s', '8s', '7s', '6s', '5s', '2c', '3d');
    expect(royal.categoryName).toBe('STRAIGHT_FLUSH');
    expect(compareHands(royal, lower)).toBeGreaterThan(0);
  });

  it('quads', () => {
    const r = evalIds('9h', '9s', '9d', '9c', 'Kh', '2c', '3d');
    expect(r.categoryName).toBe('QUADS');
    expect(r.kickers).toEqual([9, 9, 9, 9, 13]);
  });

  it('full house — picks highest trips then highest pair', () => {
    const r = evalIds('Kh', 'Ks', 'Kd', 'Qc', 'Qh', '2c', '3d');
    expect(r.categoryName).toBe('FULL_HOUSE');
    expect(r.kickers).toEqual([13, 13, 13, 12, 12]);
  });

  it('full house from two sets of trips uses the lower trips as the pair', () => {
    const r = evalIds('Kh', 'Ks', 'Kd', 'Qc', 'Qh', 'Qd', '3d');
    expect(r.categoryName).toBe('FULL_HOUSE');
    expect(r.kickers).toEqual([13, 13, 13, 12, 12]);
  });

  it('flush', () => {
    const r = evalIds('Ah', 'Jh', '9h', '6h', '3h', 'Kc', 'Kd');
    expect(r.categoryName).toBe('FLUSH');
    expect(r.kickers).toEqual([14, 11, 9, 6, 3]);
  });

  it('straight', () => {
    const r = evalIds('9h', '8s', '7d', '6c', '5h', '2c', '3d');
    expect(r.categoryName).toBe('STRAIGHT');
    expect(r.kickers[0]).toBe(9);
  });

  it('wheel straight (A-2-3-4-5) ranks as a 5-high straight', () => {
    const r = evalIds('Ah', '2s', '3d', '4c', '5h', 'Kc', 'Qd');
    expect(r.categoryName).toBe('STRAIGHT');
    expect(r.kickers[0]).toBe(5); // 5-high, not ace-high
  });

  it('broadway straight A-K-Q-J-T', () => {
    const r = evalIds('Ah', 'Ks', 'Qd', 'Jc', 'Th', '2c', '3d');
    expect(r.categoryName).toBe('STRAIGHT');
    expect(r.kickers[0]).toBe(14);
  });

  it('trips', () => {
    const r = evalIds('9h', '9s', '9d', 'Kc', 'Qh', '2c', '3d');
    expect(r.categoryName).toBe('TRIPS');
    expect(r.kickers).toEqual([9, 9, 9, 13, 12]);
  });

  it('two pair', () => {
    const r = evalIds('Kh', 'Ks', 'Qd', 'Qc', '9h', '2c', '3d');
    expect(r.categoryName).toBe('TWO_PAIR');
    expect(r.kickers).toEqual([13, 13, 12, 12, 9]);
  });

  it('one pair', () => {
    const r = evalIds('Kh', 'Ks', 'Qd', '9c', '7h', '2c', '3d');
    expect(r.categoryName).toBe('PAIR');
    expect(r.kickers).toEqual([13, 13, 12, 9, 7]);
  });

  it('high card', () => {
    const r = evalIds('Kh', 'Js', '9d', '7c', '5h', '2c', '3d');
    expect(r.categoryName).toBe('HIGH_CARD');
    expect(r.kickers).toEqual([13, 11, 9, 7, 5]);
  });
});

describe('cards/hand-eval — category ordering', () => {
  it('respects the canonical ranking order', () => {
    const order = [
      evalIds('Kh', 'Js', '9d', '7c', '5h', '2c', '3d'), // high card
      evalIds('Kh', 'Ks', 'Qd', '9c', '7h', '2c', '3d'), // pair
      evalIds('Kh', 'Ks', 'Qd', 'Qc', '9h', '2c', '3d'), // two pair
      evalIds('9h', '9s', '9d', 'Kc', 'Qh', '2c', '3d'), // trips
      evalIds('9h', '8s', '7d', '6c', '5h', '2c', '3d'), // straight
      evalIds('Ah', 'Jh', '9h', '6h', '3h', 'Kc', 'Kd'), // flush
      evalIds('Kh', 'Ks', 'Kd', 'Qc', 'Qh', '2c', '3d'), // full house
      evalIds('9h', '9s', '9d', '9c', 'Kh', '2c', '3d'), // quads
      evalIds('9h', '8h', '7h', '6h', '5h', '2c', '2d'), // straight flush
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!.rank).toBeGreaterThan(order[i - 1]!.rank);
    }
  });

  it('kicker tiebreak: higher kicker wins same pair', () => {
    const a = evalIds('Kh', 'Ks', 'Ad', '9c', '7h', '2c', '3d'); // pair K, A kicker
    const b = evalIds('Kh', 'Ks', 'Qd', '9c', '7h', '2c', '3d'); // pair K, Q kicker
    expect(compareHands(a, b)).toBeGreaterThan(0);
  });

  it('identical hands tie (rank equal)', () => {
    const a = evalIds('Kh', 'Ks', 'Qd', 'Jc', '9h', '2c', '3d');
    const b = evalIds('Kd', 'Kc', 'Qh', 'Js', '9d', '4c', '5d');
    expect(compareHands(a, b)).toBe(0);
  });
});

describe('cards/hand-eval — input validation', () => {
  it('accepts 5, 6, and 7 cards', () => {
    expect(() => evalIds('Ah', 'Kh', 'Qh', 'Jh', 'Th')).not.toThrow();
    expect(() => evalIds('Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c')).not.toThrow();
    expect(() => evalIds('Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d')).not.toThrow();
  });

  it('rejects fewer than 5 or more than 7', () => {
    expect(() => evalIds('Ah', 'Kh', 'Qh', 'Jh')).toThrow(/5\.\.7/);
    expect(() => evalIds('Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d', '4d')).toThrow(/5\.\.7/);
  });

  it('bestFive always contains exactly 5 cards', () => {
    expect(evalIds('9h', '9s', '9d', '9c', 'Kh', '2c', '3d').bestFive).toHaveLength(5);
  });
});
