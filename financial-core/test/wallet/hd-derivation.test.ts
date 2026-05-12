import { JACKPOT_TYPES } from '../../src/domain/account-types';
import {
  HD_CONSTANTS,
  insurancePath,
  jackpotPath,
  leagueInventoryPath,
  playerDepositPath,
  reinsurancePath,
  treasuryPath,
} from '../../src/wallet/hd-derivation';

describe('wallet/hd-derivation — BIP-44 paths (spec §3.4)', () => {
  it('TREASURY tiers map to fixed paths per spec', () => {
    expect(treasuryPath('hot')).toBe("m/44'/195'/0'/0/0");
    expect(treasuryPath('warm')).toBe("m/44'/195'/0'/0/1");
    expect(treasuryPath('cold')).toBe("m/44'/195'/0'/0/2");
  });

  it('INSURANCE platform-wide pool uses leagueIdx=0', () => {
    expect(insurancePath(0)).toBe("m/44'/195'/0'/1/0");
  });

  it('INSURANCE per-league pools use leagueIdx 1+', () => {
    expect(insurancePath(1)).toBe("m/44'/195'/0'/1/1");
    expect(insurancePath(42)).toBe("m/44'/195'/0'/1/42");
  });

  it('REINSURANCE matches the same pattern at branch 2', () => {
    expect(reinsurancePath(0)).toBe("m/44'/195'/0'/2/0");
    expect(reinsurancePath(7)).toBe("m/44'/195'/0'/2/7");
  });

  it('LEAGUE_INVENTORY uses branch 3; leagueIdx=0 reserved (throws)', () => {
    expect(leagueInventoryPath(1)).toBe("m/44'/195'/0'/3/1");
    expect(leagueInventoryPath(99)).toBe("m/44'/195'/0'/3/99");
    expect(() => leagueInventoryPath(0)).toThrow(/reserved for platform pools/);
  });

  it('JACKPOT path is m/44/195/0/4/{tableIdx}/{tier}', () => {
    expect(jackpotPath(0, 'JACKPOT_MINI')).toBe("m/44'/195'/0'/4/0/0");
    expect(jackpotPath(0, 'JACKPOT_MINOR')).toBe("m/44'/195'/0'/4/0/1");
    expect(jackpotPath(0, 'JACKPOT_MAJOR')).toBe("m/44'/195'/0'/4/0/2");
    expect(jackpotPath(0, 'JACKPOT_GRAND')).toBe("m/44'/195'/0'/4/0/3");
    expect(jackpotPath(123, 'JACKPOT_GRAND')).toBe("m/44'/195'/0'/4/123/3");
  });

  it('every JackpotType produces a unique path for the same tableIdx', () => {
    const paths = new Set(JACKPOT_TYPES.map((t) => jackpotPath(7, t)));
    expect(paths.size).toBe(JACKPOT_TYPES.length); // all 4 unique
  });

  it('PLAYER deposit paths are unique per playerIdx', () => {
    expect(playerDepositPath(0)).toBe("m/44'/195'/0'/5/0");
    expect(playerDepositPath(1)).toBe("m/44'/195'/0'/5/1");
    expect(playerDepositPath(99_999)).toBe("m/44'/195'/0'/5/99999");
    const a = playerDepositPath(7);
    const b = playerDepositPath(8);
    expect(a).not.toBe(b);
  });

  it('rejects non-integer / negative / overflow indices', () => {
    expect(() => insurancePath(-1)).toThrow(/non-negative integer/);
    expect(() => insurancePath(1.5)).toThrow(/non-negative integer/);
    expect(() => jackpotPath(-1, 'JACKPOT_MINI')).toThrow(/non-negative integer/);
    expect(() => playerDepositPath(2 ** 31)).toThrow(/non-hardened max/);
  });

  it('cross-branch uniqueness: same numeric index in different branches yields different paths', () => {
    const paths = [
      treasuryPath('hot'),
      insurancePath(0),
      reinsurancePath(0),
      jackpotPath(0, 'JACKPOT_MINI'),
      playerDepositPath(0),
    ];
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('HD_CONSTANTS exposes the spec-derived branch ids and tier maps', () => {
    expect(HD_CONSTANTS.PURPOSE).toBe("44'");
    expect(HD_CONSTANTS.COIN).toBe("195'");
    expect(HD_CONSTANTS.ACCOUNT).toBe("0'");
    expect(HD_CONSTANTS.ROOT).toBe("m/44'/195'/0'");
    expect(HD_CONSTANTS.BRANCH).toEqual({
      TREASURY: 0,
      INSURANCE: 1,
      REINSURANCE: 2,
      LEAGUE_INVENTORY: 3,
      JACKPOT: 4,
      PLAYER_DEPOSIT: 5,
    });
    expect(HD_CONSTANTS.TREASURY_TIER_INDEX).toEqual({ hot: 0, warm: 1, cold: 2 });
    expect(HD_CONSTANTS.JACKPOT_TIER_INDEX).toEqual({
      JACKPOT_MINI: 0,
      JACKPOT_MINOR: 1,
      JACKPOT_MAJOR: 2,
      JACKPOT_GRAND: 3,
    });
  });
});
