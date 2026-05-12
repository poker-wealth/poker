/**
 * The 9 account types from the Financial Core spec.
 * Each is a physically isolated ledger; cross-type movements are gated
 * by ClearingRules. Adding a new type requires schema review + ClearingRules
 * whitelist update + on-chain HD derivation path mapping.
 */
export const ACCOUNT_TYPES = [
  'PLAYER',
  'TREASURY',
  'INSURANCE',
  'REINSURANCE',
  'LEAGUE_INVENTORY',
  'JACKPOT_MINI',
  'JACKPOT_MINOR',
  'JACKPOT_MAJOR',
  'JACKPOT_GRAND',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Sentinel owner_id used by PLATFORM-scoped accounts (TREASURY always; INSURANCE/REINSURANCE optionally). */
export const PLATFORM_OWNER = 'PLATFORM' as const;

/** The four per-table Jackpot tiers, in injection-priority order. */
export const JACKPOT_TYPES = [
  'JACKPOT_MINI',
  'JACKPOT_MINOR',
  'JACKPOT_MAJOR',
  'JACKPOT_GRAND',
] as const satisfies readonly AccountType[];

export type JackpotType = (typeof JACKPOT_TYPES)[number];

export function isJackpotType(type: AccountType): type is JackpotType {
  return (JACKPOT_TYPES as readonly AccountType[]).includes(type);
}

/**
 * Validates that owner_id is shaped correctly for the given account_type.
 * Rules come straight from spec §3.1 (account_type / owner_id table).
 */
export function validateOwnerForType(
  type: AccountType,
  ownerId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!ownerId) return { ok: false, reason: 'owner_id required' };

  switch (type) {
    case 'PLAYER':
      // owner_id = playerId. Format is enforced by the player service.
      return { ok: true };

    case 'TREASURY':
      // Single global treasury — owner_id MUST be the PLATFORM sentinel.
      return ownerId === PLATFORM_OWNER
        ? { ok: true }
        : { ok: false, reason: `TREASURY.owner_id must be '${PLATFORM_OWNER}'` };

    case 'INSURANCE':
    case 'REINSURANCE':
      // Either platform-wide ('PLATFORM') or per-league (leagueId).
      return { ok: true };

    case 'LEAGUE_INVENTORY':
      // owner_id = leagueId. The PLATFORM sentinel is invalid here.
      return ownerId === PLATFORM_OWNER
        ? { ok: false, reason: 'LEAGUE_INVENTORY.owner_id must be a leagueId, not PLATFORM' }
        : { ok: true };

    case 'JACKPOT_MINI':
    case 'JACKPOT_MINOR':
    case 'JACKPOT_MAJOR':
    case 'JACKPOT_GRAND':
      // Per-table independent pool: owner_id = tableId.
      return { ok: true };
  }
}

/**
 * Wallet scope distinguishes a PLAYER's Platform Wallet from per-League Wallets.
 * Spec §3.1: "Player balance (Platform Wallet and League Wallet as separate accounts)".
 *
 * For non-PLAYER account types this is conventionally PLATFORM (or the leagueId
 * for league-scoped INSURANCE/REINSURANCE/JACKPOT). Concrete usage:
 *   - PLAYER + scope=PLATFORM  → player's lobby wallet (TRC20-USDT settled)
 *   - PLAYER + scope=leagueId  → player's wallet inside that league (credit system)
 */
export type WalletScope = string;
