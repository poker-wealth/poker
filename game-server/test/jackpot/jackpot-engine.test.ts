import {
  computeWeight,
  evaluateFrequencyTrigger,
  evaluateGrandTrigger,
  evaluateMajorTrigger,
  isGrandWindow,
  meetsThreshold,
  payoutAmount,
  pickRoundTarget,
  selectJackpotWinner,
  MIN_THRESHOLD_CENTS,
} from '../../src/jackpot/jackpot-engine';

describe('jackpot/payout + threshold', () => {
  it('payout percentages match spec (5/15/40/70)', () => {
    expect(payoutAmount('MINI', 1_000n)).toBe(50n); // 5% of $10
    expect(payoutAmount('MINOR', 10_000n)).toBe(1_500n); // 15%
    expect(payoutAmount('MAJOR', 10_000n)).toBe(4_000n); // 40%
    expect(payoutAmount('GRAND', 10_000n)).toBe(7_000n); // 70%
  });

  it('thresholds match spec ($10/$50/$200/$1000)', () => {
    expect(MIN_THRESHOLD_CENTS).toEqual({ MINI: 1_000n, MINOR: 5_000n, MAJOR: 20_000n, GRAND: 100_000n });
    expect(meetsThreshold('MINI', 999n)).toBe(false);
    expect(meetsThreshold('MINI', 1_000n)).toBe(true);
    expect(meetsThreshold('GRAND', 99_999n)).toBe(false);
  });
});

describe('jackpot/pickRoundTarget', () => {
  it('Mini targets land in 25..35', () => {
    expect(pickRoundTarget('MINI', 0)).toBe(25);
    expect(pickRoundTarget('MINI', 0.999999)).toBe(35);
    for (let i = 0; i < 100; i++) {
      const t = pickRoundTarget('MINI', i / 100);
      expect(t).toBeGreaterThanOrEqual(25);
      expect(t).toBeLessThanOrEqual(35);
    }
  });

  it('Minor targets land in 80..120', () => {
    expect(pickRoundTarget('MINOR', 0)).toBe(80);
    expect(pickRoundTarget('MINOR', 0.999999)).toBe(120);
  });

  it('is deterministic — same rng → same target', () => {
    expect(pickRoundTarget('MINI', 0.5)).toBe(pickRoundTarget('MINI', 0.5));
  });
});

describe('jackpot/frequency trigger (Mini/Minor)', () => {
  it('does not trigger before the target round', () => {
    const d = evaluateFrequencyTrigger({ tier: 'MINI', roundsSinceLastTrigger: 20, roundTarget: 30, poolCents: 5_000n });
    expect(d.triggered).toBe(false);
  });

  it('triggers at/after target when pool meets threshold', () => {
    const d = evaluateFrequencyTrigger({ tier: 'MINI', roundsSinceLastTrigger: 30, roundTarget: 30, poolCents: 5_000n });
    expect(d.triggered).toBe(true);
    expect(d.payoutCents).toBe(250n); // 5% of 5000
  });

  it('skips (counter continues) when below threshold even if round reached', () => {
    const d = evaluateFrequencyTrigger({ tier: 'MINI', roundsSinceLastTrigger: 40, roundTarget: 30, poolCents: 500n });
    expect(d.triggered).toBe(false);
    expect(d.reason).toMatch(/below threshold/);
  });
});

describe('jackpot/Major trigger', () => {
  const now = new Date('2026-05-13T10:00:00Z');
  it('skips if already triggered today', () => {
    const d = evaluateMajorTrigger({ poolCents: 50_000n, now, lastTriggerDate: now, rng01: 0, dailyChance: 1 });
    expect(d.triggered).toBe(false);
    expect(d.reason).toMatch(/already triggered today/);
  });
  it('skips below threshold', () => {
    const d = evaluateMajorTrigger({ poolCents: 100n, now, lastTriggerDate: null, rng01: 0, dailyChance: 1 });
    expect(d.triggered).toBe(false);
  });
  it('random gate: triggers when rng below dailyChance', () => {
    const d = evaluateMajorTrigger({ poolCents: 50_000n, now, lastTriggerDate: null, rng01: 0.001, dailyChance: 0.01 });
    expect(d.triggered).toBe(true);
    expect(d.payoutCents).toBe(20_000n); // 40% of 50000
  });
  it('random gate: does not trigger when rng above dailyChance', () => {
    const d = evaluateMajorTrigger({ poolCents: 50_000n, now, lastTriggerDate: null, rng01: 0.5, dailyChance: 0.01 });
    expect(d.triggered).toBe(false);
  });
});

describe('jackpot/Grand window', () => {
  it('isGrandWindow true Saturday 18–23 UTC+8', () => {
    // Saturday 2026-05-16 19:00 UTC+8 == 11:00 UTC.
    expect(isGrandWindow(new Date('2026-05-16T11:00:00Z'))).toBe(true);
    // Saturday 17:00 UTC+8 == 09:00 UTC — before window.
    expect(isGrandWindow(new Date('2026-05-16T09:00:00Z'))).toBe(false);
    // Sunday — wrong day.
    expect(isGrandWindow(new Date('2026-05-17T11:00:00Z'))).toBe(false);
  });

  it('triggers inside window when conditions met', () => {
    const now = new Date('2026-05-16T11:00:00Z'); // Sat 19:00 UTC+8
    const d = evaluateGrandTrigger({ poolCents: 200_000n, now, triggeredThisWindow: false, rng01: 0.0001, windowChance: 0.01 });
    expect(d.triggered).toBe(true);
    expect(d.payoutCents).toBe(140_000n); // 70% of 200000
  });

  it('does not trigger outside the window even if pool is huge', () => {
    const now = new Date('2026-05-13T10:00:00Z'); // a Wednesday
    const d = evaluateGrandTrigger({ poolCents: 999_999n, now, triggeredThisWindow: false, rng01: 0, windowChance: 1 });
    expect(d.triggered).toBe(false);
    expect(d.reason).toMatch(/outside/);
  });

  it('does not trigger twice in the same window', () => {
    const now = new Date('2026-05-16T11:00:00Z');
    const d = evaluateGrandTrigger({ poolCents: 200_000n, now, triggeredThisWindow: true, rng01: 0, windowChance: 1 });
    expect(d.triggered).toBe(false);
  });
});

describe('jackpot/weighting + selection', () => {
  it('computeWeight multiplies factors + VIP bonus', () => {
    expect(computeWeight({ baseWeight: 1, behaviorFactor: 1.0, nonCollusionFactor: 1.0 })).toBe(1);
    expect(computeWeight({ baseWeight: 1, behaviorFactor: 0.5, nonCollusionFactor: 1.0 })).toBe(0.5);
    expect(computeWeight({ baseWeight: 1, behaviorFactor: 1.0, nonCollusionFactor: 0.3 })).toBeCloseTo(0.3);
    expect(computeWeight({ baseWeight: 1, behaviorFactor: 1.0, nonCollusionFactor: 1.0, vipBonus: 0.25 })).toBe(1.25);
  });

  it('confirmed collusion (behaviorFactor 0) yields zero weight', () => {
    expect(computeWeight({ baseWeight: 10, behaviorFactor: 0.0, nonCollusionFactor: 1.0 })).toBe(0);
  });

  it('selectJackpotWinner picks proportionally and never picks weight-0 players', () => {
    const players = [
      { playerId: 'a', weight: 1 },
      { playerId: 'b', weight: 0 }, // confirmed collusion — never wins
      { playerId: 'c', weight: 3 },
    ];
    // rng cursor: total=4. [0,1)→a, [1,4)→c.
    expect(selectJackpotWinner(players, 0.0)).toBe('a');
    expect(selectJackpotWinner(players, 0.2)).toBe('a'); // 0.2*4=0.8 < 1
    expect(selectJackpotWinner(players, 0.5)).toBe('c'); // 0.5*4=2.0 → c
    expect(selectJackpotWinner(players, 0.99)).toBe('c');
  });

  it('returns null when no player has positive weight', () => {
    expect(selectJackpotWinner([{ playerId: 'a', weight: 0 }], 0.5)).toBeNull();
    expect(selectJackpotWinner([], 0.5)).toBeNull();
  });
});
