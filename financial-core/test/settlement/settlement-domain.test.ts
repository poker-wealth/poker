import { PLATFORM_OWNER } from '../../src/domain/account-types';
import {
  getPlayerWalletScope,
  getRakeDestination,
} from '../../src/settlement/settlement-domain';

describe('settlement/SettlementDomain', () => {
  describe('getRakeDestination', () => {
    it('PLATFORM table → TREASURY/PLATFORM', () => {
      expect(getRakeDestination('PLATFORM')).toEqual({
        account_type: 'TREASURY',
        owner_id: PLATFORM_OWNER,
      });
    });

    it('LEAGUE table → LEAGUE_INVENTORY/{leagueId}', () => {
      expect(getRakeDestination('LEAGUE', 'league-42')).toEqual({
        account_type: 'LEAGUE_INVENTORY',
        owner_id: 'league-42',
      });
    });

    it('LEAGUE without leagueId throws', () => {
      // @ts-expect-error — runtime check despite typed signature
      expect(() => getRakeDestination('LEAGUE')).toThrow(/requires a leagueId/);
    });

    it('unknown table type throws', () => {
      expect(() => getRakeDestination('NOPE' as 'PLATFORM')).toThrow(/unknown table type/);
    });

    it('platform and league destinations never collide (zero double-rake)', () => {
      const a = getRakeDestination('PLATFORM');
      const b = getRakeDestination('LEAGUE', 'l1');
      expect(a.account_type).not.toBe(b.account_type);
    });
  });

  describe('getPlayerWalletScope', () => {
    it('PLATFORM table → PLATFORM scope (lobby wallet)', () => {
      expect(getPlayerWalletScope('PLATFORM')).toBe(PLATFORM_OWNER);
    });

    it('LEAGUE table → leagueId scope (per-league wallet)', () => {
      expect(getPlayerWalletScope('LEAGUE', 'league-7')).toBe('league-7');
    });

    it('LEAGUE without leagueId throws', () => {
      // @ts-expect-error — runtime check despite typed signature
      expect(() => getPlayerWalletScope('LEAGUE')).toThrow(/requires a leagueId/);
    });
  });
});
