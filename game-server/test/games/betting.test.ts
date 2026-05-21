import {
  awardPots,
  computePots,
  totalPot,
  type PlayerChips,
} from '../../src/games/texas/betting';

describe('games/texas/betting — computePots', () => {
  it('single pot when everyone contributes equally', () => {
    const players: PlayerChips[] = [
      { playerId: 'a', committed: 100n, folded: false },
      { playerId: 'b', committed: 100n, folded: false },
      { playerId: 'c', committed: 100n, folded: false },
    ];
    const pots = computePots(players);
    expect(pots).toHaveLength(1);
    expect(pots[0]!.amount).toBe(300n);
    expect(pots[0]!.eligible.sort()).toEqual(['a', 'b', 'c']);
  });

  it('folded players contribute chips but are not eligible', () => {
    const players: PlayerChips[] = [
      { playerId: 'a', committed: 100n, folded: false },
      { playerId: 'b', committed: 100n, folded: true }, // folded but money in
      { playerId: 'c', committed: 100n, folded: false },
    ];
    const pots = computePots(players);
    expect(pots).toHaveLength(1);
    expect(pots[0]!.amount).toBe(300n); // b's chips still counted
    expect(pots[0]!.eligible.sort()).toEqual(['a', 'c']); // b not eligible
  });

  it('one all-in short → main pot + side pot', () => {
    // a all-in for 50, b and c continue to 200.
    const players: PlayerChips[] = [
      { playerId: 'a', committed: 50n, folded: false },
      { playerId: 'b', committed: 200n, folded: false },
      { playerId: 'c', committed: 200n, folded: false },
    ];
    const pots = computePots(players);
    expect(pots).toHaveLength(2);
    // Main pot: 50 from each of 3 = 150, all eligible.
    expect(pots[0]!.amount).toBe(150n);
    expect(pots[0]!.eligible.sort()).toEqual(['a', 'b', 'c']);
    // Side pot: 150 from each of b,c = 300, only b,c eligible.
    expect(pots[1]!.amount).toBe(300n);
    expect(pots[1]!.eligible.sort()).toEqual(['b', 'c']);
    expect(totalPot(pots)).toBe(450n);
  });

  it('two all-ins at different levels → three pots', () => {
    // a all-in 50, b all-in 120, c covers 200.
    const players: PlayerChips[] = [
      { playerId: 'a', committed: 50n, folded: false },
      { playerId: 'b', committed: 120n, folded: false },
      { playerId: 'c', committed: 200n, folded: false },
    ];
    const pots = computePots(players);
    expect(pots).toHaveLength(3);
    // Layer 1: 50 × 3 = 150, eligible a,b,c
    expect(pots[0]!.amount).toBe(150n);
    expect(pots[0]!.eligible.sort()).toEqual(['a', 'b', 'c']);
    // Layer 2: 70 × 2 (b,c) = 140, eligible b,c
    expect(pots[1]!.amount).toBe(140n);
    expect(pots[1]!.eligible.sort()).toEqual(['b', 'c']);
    // Layer 3: 80 × 1 (c) = 80, eligible c (c's uncalled bet returns to them)
    expect(pots[2]!.amount).toBe(80n);
    expect(pots[2]!.eligible).toEqual(['c']);
    expect(totalPot(pots)).toBe(370n); // 50 + 120 + 200
  });

  it('heads-up uneven all-in', () => {
    const players: PlayerChips[] = [
      { playerId: 'a', committed: 30n, folded: false },
      { playerId: 'b', committed: 100n, folded: false },
    ];
    const pots = computePots(players);
    // Layer 1: 30×2=60 (a,b). Layer 2: 70×1=70 (b only — uncalled, returns).
    expect(pots).toHaveLength(2);
    expect(pots[0]!.amount).toBe(60n);
    expect(pots[0]!.eligible.sort()).toEqual(['a', 'b']);
    expect(pots[1]!.amount).toBe(70n);
    expect(pots[1]!.eligible).toEqual(['b']);
  });

  it('no contributions → no pots', () => {
    expect(computePots([{ playerId: 'a', committed: 0n, folded: false }])).toEqual([]);
  });
});

describe('games/texas/betting — awardPots', () => {
  const seatOrder = ['a', 'b', 'c'];

  it('awards a single pot to the highest hand', () => {
    const pots = computePots([
      { playerId: 'a', committed: 100n, folded: false },
      { playerId: 'b', committed: 100n, folded: false },
      { playerId: 'c', committed: 100n, folded: false },
    ]);
    const strengths = new Map([
      ['a', 500],
      ['b', 999], // b best
      ['c', 100],
    ]);
    const { payouts } = awardPots(pots, strengths, seatOrder);
    expect(payouts.get('b')).toBe(300n);
    expect(payouts.has('a')).toBe(false);
  });

  it('splits a tied pot evenly, odd chip to earliest seat', () => {
    const pots = computePots([
      { playerId: 'a', committed: 50n, folded: false },
      { playerId: 'b', committed: 50n, folded: false },
      { playerId: 'c', committed: 1n, folded: false },
    ]);
    // total = 101. a and b tie for best.
    const strengths = new Map([
      ['a', 999],
      ['b', 999],
      ['c', 100],
    ]);
    const { payouts } = awardPots(pots, strengths, seatOrder);
    // Main pot: 1×3 = 3 (a,b,c eligible) → a,b tie → 1 each + odd chip to a → a=2,b=1
    // Side pot: 49×2 = 98 (a,b) → 49 each
    // a = 2 + 49 = 51, b = 1 + 49 = 50. Total 101.
    expect((payouts.get('a') ?? 0n) + (payouts.get('b') ?? 0n)).toBe(101n);
    expect(payouts.get('a')).toBe(51n);
    expect(payouts.get('b')).toBe(50n);
  });

  it('side pot: short all-in player can only win the main pot', () => {
    // a all-in 50 with the best hand; b,c continue to 200. b has 2nd best.
    const pots = computePots([
      { playerId: 'a', committed: 50n, folded: false },
      { playerId: 'b', committed: 200n, folded: false },
      { playerId: 'c', committed: 200n, folded: false },
    ]);
    const strengths = new Map([
      ['a', 999], // best hand, but only eligible for main pot
      ['b', 800],
      ['c', 100],
    ]);
    const { payouts } = awardPots(pots, strengths, seatOrder);
    // Main pot 150 → a (best). Side pot 300 → b (best of b,c).
    expect(payouts.get('a')).toBe(150n);
    expect(payouts.get('b')).toBe(300n);
    expect(payouts.has('c')).toBe(false);
  });

  it('conserves chips: sum of payouts equals total pot', () => {
    const players: PlayerChips[] = [
      { playerId: 'a', committed: 50n, folded: false },
      { playerId: 'b', committed: 120n, folded: false },
      { playerId: 'c', committed: 200n, folded: false },
    ];
    const pots = computePots(players);
    const strengths = new Map([
      ['a', 300],
      ['b', 999],
      ['c', 500],
    ]);
    const { payouts } = awardPots(pots, strengths, ['a', 'b', 'c']);
    const totalOut = [...payouts.values()].reduce((s, v) => s + v, 0n);
    expect(totalOut).toBe(totalPot(pots));
    expect(totalOut).toBe(370n); // 50+120+200
  });
});
