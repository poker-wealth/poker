import {
  COLD_FLOOR_DEN,
  COLD_FLOOR_NUM,
  HOT_CAP_CENTS,
  WARM_CAP_CENTS,
  evaluateTreasuryAllocation,
  needsRebalance,
} from '../../src/wallet/treasury-thresholds';

describe('wallet/treasury-thresholds (spec §3.4 + §3.7)', () => {
  it('constants match spec exactly ($50K hot, $500K warm, ≥70% cold)', () => {
    expect(HOT_CAP_CENTS).toBe(5_000_000n);
    expect(WARM_CAP_CENTS).toBe(50_000_000n);
    expect(COLD_FLOOR_NUM).toBe(70n);
    expect(COLD_FLOOR_DEN).toBe(100n);
  });

  describe('OK cases', () => {
    it('zero balances are within policy', () => {
      const r = evaluateTreasuryAllocation({ hot: 0n, warm: 0n, cold: 0n });
      expect(r.total).toBe(0n);
      expect(r.recommendations).toHaveLength(1);
      expect(r.recommendations[0]!.kind).toBe('OK');
    });

    it('hot $30K, warm $200K, cold $800K — well within all caps and floor', () => {
      const r = evaluateTreasuryAllocation({
        hot: 3_000_000n,
        warm: 20_000_000n,
        cold: 80_000_000n,
      });
      expect(r.total).toBe(103_000_000n);
      expect(r.recommendations).toHaveLength(1);
      expect(r.recommendations[0]!.kind).toBe('OK');
      expect(needsRebalance({ hot: 3_000_000n, warm: 20_000_000n, cold: 80_000_000n })).toBe(false);
    });
  });

  describe('HOT_OVER_CAP_AUTO_AGGREGATE', () => {
    it('hot $60K → aggregate $10K to warm (auto, no approval)', () => {
      const r = evaluateTreasuryAllocation({
        hot: 6_000_000n,
        warm: 10_000_000n,
        cold: 50_000_000n,
      });
      const rec = r.recommendations.find((x) => x.kind === 'HOT_OVER_CAP_AUTO_AGGREGATE');
      expect(rec).toBeDefined();
      expect(rec!.amount).toBe(1_000_000n);
      expect(rec!.from).toBe('hot');
      expect(rec!.to).toBe('warm');
      expect(rec!.requiresHumanApproval).toBe(false);
    });
  });

  describe('WARM_OVER_CAP_HUMAN_APPROVE', () => {
    it('warm $600K → move $100K to cold (requires approval)', () => {
      const r = evaluateTreasuryAllocation({
        hot: 2_000_000n,
        warm: 60_000_000n,
        cold: 200_000_000n,
      });
      const rec = r.recommendations.find((x) => x.kind === 'WARM_OVER_CAP_HUMAN_APPROVE');
      expect(rec).toBeDefined();
      expect(rec!.amount).toBe(10_000_000n);
      expect(rec!.from).toBe('warm');
      expect(rec!.to).toBe('cold');
      expect(rec!.requiresHumanApproval).toBe(true);
    });
  });

  describe('COLD_UNDER_FLOOR_HUMAN_APPROVE', () => {
    it('cold = 50% of total < 70% floor → recommend top-up to floor', () => {
      // Total = $1000K. 70% floor = $700K. Cold has $500K.
      // Deficit = $700K - $500K = $200K.
      const r = evaluateTreasuryAllocation({
        hot: 4_000_000n, //  $40K
        warm: 46_000_000n, // $460K
        cold: 50_000_000n, // $500K
      });
      const rec = r.recommendations.find((x) => x.kind === 'COLD_UNDER_FLOOR_HUMAN_APPROVE');
      expect(rec).toBeDefined();
      expect(rec!.amount).toBe(20_000_000n); // $200K deficit
      expect(rec!.requiresHumanApproval).toBe(true);
    });

    it('exactly 70% cold ratio is satisfied (no recommendation)', () => {
      const r = evaluateTreasuryAllocation({
        hot: 1_000_000n, //  $10K
        warm: 2_000_000n, // $20K
        cold: 7_000_000n, // $70K — exactly 70%
      });
      expect(r.recommendations.some((x) => x.kind === 'COLD_UNDER_FLOOR_HUMAN_APPROVE')).toBe(false);
    });
  });

  describe('multiple violations', () => {
    it('reports HOT and WARM and COLD violations together', () => {
      // hot $100K (over cap), warm $600K (over cap), cold $200K
      // total = $900K, 70% = $630K, cold is $200K → deficit $430K
      const r = evaluateTreasuryAllocation({
        hot: 10_000_000n,
        warm: 60_000_000n,
        cold: 20_000_000n,
      });
      const kinds = r.recommendations.map((x) => x.kind);
      expect(kinds).toContain('HOT_OVER_CAP_AUTO_AGGREGATE');
      expect(kinds).toContain('WARM_OVER_CAP_HUMAN_APPROVE');
      expect(kinds).toContain('COLD_UNDER_FLOOR_HUMAN_APPROVE');
      expect(kinds).not.toContain('OK');
    });
  });

  describe('ratios reporting', () => {
    it('produces correct ratios as percentages with 2 decimals', () => {
      const r = evaluateTreasuryAllocation({
        hot: 1_000_000n,
        warm: 1_000_000n,
        cold: 8_000_000n,
      });
      expect(r.ratios).toEqual({ hot: 10, warm: 10, cold: 80 });
    });

    it('zero total produces zero ratios', () => {
      const r = evaluateTreasuryAllocation({ hot: 0n, warm: 0n, cold: 0n });
      expect(r.ratios).toEqual({ hot: 0, warm: 0, cold: 0 });
    });
  });

  it('rejects negative balances', () => {
    expect(() =>
      evaluateTreasuryAllocation({ hot: -1n, warm: 0n, cold: 0n }),
    ).toThrow(/non-negative/);
  });

  it('needsRebalance returns true when any recommendation is non-OK', () => {
    expect(needsRebalance({ hot: 6_000_000n, warm: 0n, cold: 100_000_000n })).toBe(true);
    expect(needsRebalance({ hot: 1_000_000n, warm: 2_000_000n, cold: 7_000_000n })).toBe(false);
  });
});
