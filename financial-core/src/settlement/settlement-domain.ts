import { PLATFORM_OWNER, type AccountType } from '../domain/account-types.js';

/**
 * Settlement Domain — the rake routing rules hub (spec §3.10).
 *
 * Iron rule: ALL games query here. New game integration touches THIS file
 * only — Settlement Engine never branches on tableType. Zero cross-system
 * sharing, zero double-rake.
 */

export type TableType = 'PLATFORM' | 'LEAGUE';

export interface RakeDestination {
  account_type: AccountType;
  owner_id: string;
}

/** Where does a hand's rake go? */
export function getRakeDestination(tableType: 'PLATFORM'): RakeDestination;
export function getRakeDestination(tableType: 'LEAGUE', leagueId: string): RakeDestination;
export function getRakeDestination(tableType: TableType, leagueId?: string): RakeDestination {
  if (tableType === 'PLATFORM') {
    return { account_type: 'TREASURY', owner_id: PLATFORM_OWNER };
  }
  if (tableType === 'LEAGUE') {
    if (!leagueId) {
      throw new Error('getRakeDestination(LEAGUE) requires a leagueId');
    }
    return { account_type: 'LEAGUE_INVENTORY', owner_id: leagueId };
  }
  // Exhaustiveness — TypeScript should already prevent this.
  throw new Error(`unknown table type: ${tableType as string}`);
}

/**
 * Wallet scope for a player's funds in a given table context.
 *   - PLATFORM tables → player's PLATFORM (lobby) wallet.
 *   - LEAGUE  tables → player's wallet inside that league.
 *
 * Used by Settlement Engine to pick the correct PLAYER account when
 * deducting bets, paying winners, and routing rake.
 */
export function getPlayerWalletScope(tableType: 'PLATFORM'): string;
export function getPlayerWalletScope(tableType: 'LEAGUE', leagueId: string): string;
export function getPlayerWalletScope(tableType: TableType, leagueId?: string): string {
  if (tableType === 'PLATFORM') return PLATFORM_OWNER;
  if (tableType === 'LEAGUE') {
    if (!leagueId) {
      throw new Error('getPlayerWalletScope(LEAGUE) requires a leagueId');
    }
    return leagueId;
  }
  throw new Error(`unknown table type: ${tableType as string}`);
}
