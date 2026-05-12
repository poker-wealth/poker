import {
  IllegalFundFlowError,
  assertFlowAllowed,
  checkFlow,
} from '../../src/clearing/clearing-rules';
import { ACCOUNT_TYPES, type AccountType } from '../../src/domain/account-types';
import type { LedgerType } from '../../src/domain/ledger-types';

describe('clearing/ClearingRules', () => {
  describe('internal flows — spec §3.3 whitelist', () => {
    type Case = [AccountType, AccountType, LedgerType];
    const ALLOWED: Case[] = [
      // PLAYER outbound
      ['PLAYER', 'PLAYER', 'WIN_PAYOUT'],
      ['PLAYER', 'TREASURY', 'RAKE'],
      ['PLAYER', 'LEAGUE_INVENTORY', 'RAKE'],
      ['PLAYER', 'INSURANCE', 'INSURANCE_PREMIUM'],
      ['PLAYER', 'JACKPOT_MINI', 'JACKPOT_INJECT'],
      ['PLAYER', 'JACKPOT_MINOR', 'JACKPOT_INJECT'],
      ['PLAYER', 'JACKPOT_MAJOR', 'JACKPOT_INJECT'],
      ['PLAYER', 'JACKPOT_GRAND', 'JACKPOT_INJECT'],
      // TREASURY outbound
      ['TREASURY', 'PLAYER', 'AGENT_COMMISSION'],
      ['TREASURY', 'PLAYER', 'AGENT_VIP_BONUS'],
      ['TREASURY', 'REINSURANCE', 'REINSURANCE_INJECT'],
      ['TREASURY', 'LEAGUE_INVENTORY', 'LEAGUE_TOPUP'],
      // INSURANCE outbound
      ['INSURANCE', 'PLAYER', 'INSURANCE_PAYOUT'],
      ['INSURANCE', 'REINSURANCE', 'REINSURANCE_INJECT'],
      // REINSURANCE outbound
      ['REINSURANCE', 'INSURANCE', 'REINSURANCE_PAYOUT'],
      ['REINSURANCE', 'TREASURY', 'REINSURANCE_PAYOUT'],
      // LEAGUE_INVENTORY outbound
      ['LEAGUE_INVENTORY', 'PLAYER', 'WIN_PAYOUT'],
      ['LEAGUE_INVENTORY', 'TREASURY', 'LEAGUE_CASHOUT'],
      // JACKPOTs outbound
      ['JACKPOT_MINI', 'PLAYER', 'JACKPOT_PAYOUT'],
      ['JACKPOT_MINOR', 'PLAYER', 'JACKPOT_PAYOUT'],
      ['JACKPOT_MAJOR', 'PLAYER', 'JACKPOT_PAYOUT'],
      ['JACKPOT_GRAND', 'PLAYER', 'JACKPOT_PAYOUT'],
    ];

    it.each(ALLOWED)('allows %s -> %s (%s)', (fromType, toType, ledgerType) => {
      expect(checkFlow({ fromType, toType, ledgerType })).toEqual({ ok: true });
    });

    const PROHIBITED: Case[] = [
      // Explicit spec §3.3 prohibitions
      ['PLAYER', 'REINSURANCE', 'BET'],
      ['TREASURY', 'INSURANCE', 'BET'], // must go through multi-sig override
      ['INSURANCE', 'TREASURY', 'WIN_PAYOUT'],
      ['REINSURANCE', 'PLAYER', 'WIN_PAYOUT'], // must route through INSURANCE
      ['JACKPOT_MINI', 'TREASURY', 'WIN_PAYOUT'], // no misappropriation
      ['JACKPOT_GRAND', 'TREASURY', 'WIN_PAYOUT'],
      // Cross-league prohibition
      ['LEAGUE_INVENTORY', 'LEAGUE_INVENTORY', 'BET'],
      // Jackpot tier-to-tier (out-only)
      ['JACKPOT_MINI', 'JACKPOT_MINOR', 'JACKPOT_INJECT'],
      ['JACKPOT_GRAND', 'JACKPOT_MAJOR', 'JACKPOT_INJECT'],
    ];

    it.each(PROHIBITED)('rejects %s -> %s (%s)', (fromType, toType, ledgerType) => {
      const r = checkFlow({ fromType, toType, ledgerType });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not on the whitelist|whitelist/);
    });
  });

  describe('inflows — DEPOSIT and WITHDRAW_REFUND', () => {
    it('allows external -> PLAYER via DEPOSIT', () => {
      expect(
        checkFlow({ fromType: null, toType: 'PLAYER', ledgerType: 'DEPOSIT' }),
      ).toEqual({ ok: true });
    });

    it('allows external -> TREASURY via DEPOSIT (operator/league funding)', () => {
      expect(
        checkFlow({ fromType: null, toType: 'TREASURY', ledgerType: 'DEPOSIT' }),
      ).toEqual({ ok: true });
    });

    it('allows external -> PLAYER via WITHDRAW_REFUND', () => {
      expect(
        checkFlow({ fromType: null, toType: 'PLAYER', ledgerType: 'WITHDRAW_REFUND' }),
      ).toEqual({ ok: true });
    });

    it('rejects DEPOSIT to disallowed types', () => {
      for (const toType of ['INSURANCE', 'JACKPOT_MINI', 'REINSURANCE'] as AccountType[]) {
        const r = checkFlow({ fromType: null, toType, ledgerType: 'DEPOSIT' });
        expect(r.ok).toBe(false);
      }
    });

    it('rejects DEPOSIT with a non-null fromType', () => {
      const r = checkFlow({ fromType: 'PLAYER', toType: 'PLAYER', ledgerType: 'DEPOSIT' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/fromType must be null/);
    });

    it('rejects WITHDRAW_REFUND -> TREASURY (only PLAYER allowed)', () => {
      const r = checkFlow({
        fromType: null,
        toType: 'TREASURY',
        ledgerType: 'WITHDRAW_REFUND',
      });
      expect(r.ok).toBe(false);
    });
  });

  describe('outflows — WITHDRAW', () => {
    it('allows PLAYER -> external via WITHDRAW', () => {
      expect(
        checkFlow({ fromType: 'PLAYER', toType: null, ledgerType: 'WITHDRAW' }),
      ).toEqual({ ok: true });
    });

    it('allows TREASURY -> external via WITHDRAW (cold storage rebalance, league cashout)', () => {
      expect(
        checkFlow({ fromType: 'TREASURY', toType: null, ledgerType: 'WITHDRAW' }),
      ).toEqual({ ok: true });
    });

    it('rejects WITHDRAW from INSURANCE/REINSURANCE/LEAGUE_INVENTORY/JACKPOT', () => {
      for (const fromType of [
        'INSURANCE',
        'REINSURANCE',
        'LEAGUE_INVENTORY',
        'JACKPOT_MINI',
      ] as AccountType[]) {
        expect(
          checkFlow({ fromType, toType: null, ledgerType: 'WITHDRAW' }).ok,
        ).toBe(false);
      }
    });

    it('rejects WITHDRAW with a non-null toType', () => {
      const r = checkFlow({ fromType: 'PLAYER', toType: 'PLAYER', ledgerType: 'WITHDRAW' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/toType must be null/);
    });
  });

  describe('boundary-type misuse for internal types', () => {
    it('rejects internal type with a null endpoint', () => {
      const r = checkFlow({ fromType: 'PLAYER', toType: null, ledgerType: 'RAKE' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/both endpoints required/);
    });
  });

  describe('assertFlowAllowed throws IllegalFundFlowError on illegal flow', () => {
    it('throws with fromType, toType, ledgerType on the error instance', () => {
      try {
        assertFlowAllowed({
          fromType: 'PLAYER',
          toType: 'REINSURANCE',
          ledgerType: 'BET',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalFundFlowError);
        const e = err as IllegalFundFlowError;
        expect(e.fromType).toBe('PLAYER');
        expect(e.toType).toBe('REINSURANCE');
        expect(e.ledgerType).toBe('BET');
        expect(e.message).toMatch(/PLAYER -> REINSURANCE/);
      }
    });

    it('does not throw for an allowed flow', () => {
      expect(() =>
        assertFlowAllowed({ fromType: 'PLAYER', toType: 'TREASURY', ledgerType: 'RAKE' }),
      ).not.toThrow();
    });
  });

  describe('whitelist coverage — every AccountType appears as a source', () => {
    it('every AccountType has an internal-flow entry', () => {
      const { __WHITELIST_FOR_TESTS } = jest.requireActual<
        typeof import('../../src/clearing/clearing-rules')
      >('../../src/clearing/clearing-rules');
      for (const t of ACCOUNT_TYPES) {
        expect(__WHITELIST_FOR_TESTS.INTERNAL[t]).toBeDefined();
      }
    });
  });
});
