import type { JackpotType } from '../domain/account-types.js';

/**
 * HD wallet derivation paths — spec §3.4 (BIP-44).
 *
 * Iron rule: master private key lives in HSM. Never online. Never in code.
 * This module produces derivation PATHS only. Actual address derivation
 * (path → secp256k1 key → Tron base58check address) lives in
 * `derive-tron-address.ts` and is called by the HSM-signing service.
 *
 * Coin type: 195' (Tron, BIP-44 SLIP-0044 registration).
 * Account: 0' (single platform account).
 *
 * Mapping (spec §3.4 table):
 *   TREASURY (Hot)              m/44'/195'/0'/0/0
 *   TREASURY (Warm)             m/44'/195'/0'/0/1
 *   TREASURY (Cold)             m/44'/195'/0'/0/2
 *   INSURANCE (PLATFORM)        m/44'/195'/0'/1/0
 *   INSURANCE (leagueId)        m/44'/195'/0'/1/{leagueIdx}
 *   REINSURANCE (PLATFORM)      m/44'/195'/0'/2/0
 *   REINSURANCE (leagueId)      m/44'/195'/0'/2/{leagueIdx}
 *   LEAGUE_INVENTORY            m/44'/195'/0'/3/{leagueIdx}
 *   JACKPOT_*                   m/44'/195'/0'/4/{tableIdx}/{tier}
 *                                  tier: 0=MINI, 1=MINOR, 2=MAJOR, 3=GRAND
 *   PLAYER deposit              m/44'/195'/0'/5/{playerIdx}
 *
 * Indices (leagueIdx, tableIdx, playerIdx) are stable monotonic counters
 * assigned at account-creation time and persisted alongside the
 * `accounts` document. The platform-level pools (INSURANCE/REINSURANCE
 * with owner_id=PLATFORM) use leagueIdx=0 by convention; leagueIdx=1+
 * are reserved for per-league pools.
 *
 * Hardened indices use the apostrophe suffix (BIP-32 hardened derivation:
 * index ≥ 2^31). Only the first three segments are hardened per BIP-44.
 */

// BIP-44 coin type for Tron — see SLIP-0044.
const COIN_TRON = "195'";
const PURPOSE_BIP44 = "44'";
const ACCOUNT_PLATFORM = "0'";

// Change-level branch ids (the 4th segment of m/44'/195'/0'/X).
const BRANCH_TREASURY = 0;
const BRANCH_INSURANCE = 1;
const BRANCH_REINSURANCE = 2;
const BRANCH_LEAGUE_INVENTORY = 3;
const BRANCH_JACKPOT = 4;
const BRANCH_PLAYER_DEPOSIT = 5;

const ROOT = `m/${PURPOSE_BIP44}/${COIN_TRON}/${ACCOUNT_PLATFORM}`;

const MAX_NON_HARDENED_INDEX = 2 ** 31 - 1;

function assertNonNegativeIndex(label: string, idx: number): void {
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`hd-derivation: ${label} must be a non-negative integer`);
  }
  if (idx > MAX_NON_HARDENED_INDEX) {
    throw new Error(`hd-derivation: ${label} exceeds BIP-32 non-hardened max (${MAX_NON_HARDENED_INDEX})`);
  }
}

export type TreasuryTier = 'hot' | 'warm' | 'cold';
const TREASURY_TIER_INDEX: Readonly<Record<TreasuryTier, number>> = Object.freeze({
  hot: 0,
  warm: 1,
  cold: 2,
});

export function treasuryPath(tier: TreasuryTier): string {
  const idx = TREASURY_TIER_INDEX[tier];
  if (idx === undefined) throw new Error(`hd-derivation: unknown treasury tier ${tier}`);
  return `${ROOT}/${BRANCH_TREASURY}/${idx}`;
}

/** INSURANCE pool path. `leagueIdx` 0 = platform-wide pool; 1+ = per-league. */
export function insurancePath(leagueIdx: number): string {
  assertNonNegativeIndex('leagueIdx', leagueIdx);
  return `${ROOT}/${BRANCH_INSURANCE}/${leagueIdx}`;
}

/** REINSURANCE pool path. `leagueIdx` 0 = platform-wide pool; 1+ = per-league. */
export function reinsurancePath(leagueIdx: number): string {
  assertNonNegativeIndex('leagueIdx', leagueIdx);
  return `${ROOT}/${BRANCH_REINSURANCE}/${leagueIdx}`;
}

/** LEAGUE_INVENTORY path (per-league). `leagueIdx` 1+. */
export function leagueInventoryPath(leagueIdx: number): string {
  assertNonNegativeIndex('leagueIdx', leagueIdx);
  if (leagueIdx === 0) {
    throw new Error('hd-derivation: leagueIdx=0 reserved for platform pools, not LEAGUE_INVENTORY');
  }
  return `${ROOT}/${BRANCH_LEAGUE_INVENTORY}/${leagueIdx}`;
}

/** Maps a JackpotType to its tier sub-index per spec §3.4. */
const JACKPOT_TIER_INDEX: Readonly<Record<JackpotType, number>> = Object.freeze({
  JACKPOT_MINI: 0,
  JACKPOT_MINOR: 1,
  JACKPOT_MAJOR: 2,
  JACKPOT_GRAND: 3,
});

export function jackpotPath(tableIdx: number, type: JackpotType): string {
  assertNonNegativeIndex('tableIdx', tableIdx);
  const tier = JACKPOT_TIER_INDEX[type];
  return `${ROOT}/${BRANCH_JACKPOT}/${tableIdx}/${tier}`;
}

/** Per-player deposit address. `playerIdx` is the player's stable HD index. */
export function playerDepositPath(playerIdx: number): string {
  assertNonNegativeIndex('playerIdx', playerIdx);
  return `${ROOT}/${BRANCH_PLAYER_DEPOSIT}/${playerIdx}`;
}

/** Internal constants exposed for tests and the address-derivation service. */
export const HD_CONSTANTS = Object.freeze({
  PURPOSE: PURPOSE_BIP44,
  COIN: COIN_TRON,
  ACCOUNT: ACCOUNT_PLATFORM,
  ROOT,
  BRANCH: {
    TREASURY: BRANCH_TREASURY,
    INSURANCE: BRANCH_INSURANCE,
    REINSURANCE: BRANCH_REINSURANCE,
    LEAGUE_INVENTORY: BRANCH_LEAGUE_INVENTORY,
    JACKPOT: BRANCH_JACKPOT,
    PLAYER_DEPOSIT: BRANCH_PLAYER_DEPOSIT,
  },
  TREASURY_TIER_INDEX,
  JACKPOT_TIER_INDEX,
  MAX_NON_HARDENED_INDEX,
});
