import {
  MAX_DAILY_PAYOUT_PCT,
  MAX_SINGLE_PAYOUT_PCT,
  RESERVE_THRESHOLD_CENTS,
  signRiskFactor,
  underwrite,
  validateRiskFactor,
  type UnderwritingRequest,
} from '../../src/insurance/underwriting';

const base: UnderwritingRequest = {
  system: 'PLATFORM',
  reserveCents: 100_000_000n, // $1,000,000 reserve
  requestedPayoutCents: 1_000_000n, // $10,000 payout
  reservedExposureCents: 0n,
  lossProbability: 0.2,
  riskFactor: 1.1,
};

describe('insurance/underwriting — constants', () => {
  it('matches spec thresholds and caps', () => {
    expect(RESERVE_THRESHOLD_CENTS).toEqual({ PLATFORM: 1_000_000n, LEAGUE: 100_000n });
    expect(MAX_SINGLE_PAYOUT_PCT).toBe(5n);
    expect(MAX_DAILY_PAYOUT_PCT).toBe(15n);
  });
});

describe('insurance/underwriting — 5-step pipeline', () => {
  it('approves a healthy request and returns a quote (no RiskFactor exposed)', () => {
    const r = underwrite(base);
    expect(r.approved).toBe(true);
    if (!r.approved) return;
    // premium = 1,000,000 × 0.2 × 1.1 = 220,000 cents, rounded up.
    expect(r.quote.premiumCents).toBe(220_000n);
    expect(r.quote.payoutCents).toBe(1_000_000n);
    // displayed odds = payout/premium = 1,000,000 / 220,000 ≈ 4.55
    expect(r.quote.displayedOdds).toBeCloseTo(4.55, 2);
    // RiskFactor must NOT appear anywhere in the quote.
    const serialized = JSON.stringify(r.quote, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toMatch(/riskFactor/i);
    expect(r.quote.budgetReservation.ttlMs).toBe(30_000);
  });

  it('step 1: rejects when reserve below threshold', () => {
    const r = underwrite({ ...base, reserveCents: 999_999n });
    expect(r).toEqual({ approved: false, step: 1, reason: expect.stringContaining('below threshold') });
  });

  it('step 1: LEAGUE has a lower ($1,000) threshold', () => {
    // $5,000 reserve passes step 1 for LEAGUE but would fail for PLATFORM.
    const league = underwrite({ ...base, system: 'LEAGUE', reserveCents: 500_000n, requestedPayoutCents: 10_000n });
    expect(league.approved).toBe(true);
    const platform = underwrite({ ...base, system: 'PLATFORM', reserveCents: 500_000n });
    expect(platform.approved).toBe(false);
    if (!platform.approved) expect(platform.step).toBe(1);
  });

  it('step 2: rejects when daily budget exhausted', () => {
    // dailyBudget = reserve × 15% = 15,000,000. Reserve all of it.
    const r = underwrite({ ...base, reservedExposureCents: 15_000_000n });
    expect(r).toEqual({ approved: false, step: 2, reason: expect.stringContaining('budget') });
  });

  it('step 3: rejects when payout exceeds single cap (reserve × 5%)', () => {
    // single cap = 5,000,000. Request 6,000,000.
    const r = underwrite({ ...base, requestedPayoutCents: 6_000_000n });
    expect(r).toEqual({ approved: false, step: 3, reason: expect.stringContaining('single cap') });
  });

  it('step 4: rejects when payout exceeds remaining daily budget', () => {
    // dailyBudget=15,000,000; reserve 14,500,000 → available 500,000.
    // Request 1,000,000 (passes single cap 5,000,000) but exceeds available.
    const r = underwrite({ ...base, reservedExposureCents: 14_500_000n });
    expect(r).toEqual({ approved: false, step: 4, reason: expect.stringContaining('daily budget') });
  });

  it('rejects invalid inputs', () => {
    expect(() => underwrite({ ...base, lossProbability: 1.5 })).toThrow(/lossProbability/);
    expect(() => underwrite({ ...base, riskFactor: 0 })).toThrow(/riskFactor/);
    expect(() => underwrite({ ...base, requestedPayoutCents: 0n })).toThrow(/requestedPayoutCents/);
  });

  it('higher riskFactor → higher premium → worse displayed odds (house margin)', () => {
    const lo = underwrite({ ...base, riskFactor: 1.0 });
    const hi = underwrite({ ...base, riskFactor: 1.5 });
    if (!lo.approved || !hi.approved) throw new Error('expected approvals');
    expect(hi.quote.premiumCents).toBeGreaterThan(lo.quote.premiumCents);
    expect(hi.quote.displayedOdds).toBeLessThan(lo.quote.displayedOdds);
  });
});

describe('insurance/underwriting — RiskFactor HMAC protection', () => {
  const secret = 'test-risk-secret';

  it('validates a correctly-signed risk factor', () => {
    const sig = signRiskFactor(1.25, secret);
    const r = validateRiskFactor(1.25, sig, secret);
    expect(r).toEqual({ value: 1.25, valid: true });
  });

  it('resets to 1.0 on signature mismatch (tamper)', () => {
    const sig = signRiskFactor(1.25, secret);
    // Attacker swaps the value to 2.0 but keeps the old signature.
    const r = validateRiskFactor(2.0, sig, secret);
    expect(r).toEqual({ value: 1.0, valid: false });
  });

  it('resets to 1.0 on wrong secret', () => {
    const sig = signRiskFactor(1.25, 'other-secret');
    const r = validateRiskFactor(1.25, sig, secret);
    expect(r.valid).toBe(false);
    expect(r.value).toBe(1.0);
  });
});
