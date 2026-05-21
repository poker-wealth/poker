import { hexToBytes } from '@noble/hashes/utils';

/**
 * drand client (spec §6.1) — public, verifiable randomness beacon.
 *
 * Strategy:
 *   - Query multiple drand HTTP endpoints concurrently (Promise.race) so the
 *     fastest healthy node wins.
 *   - Hard 5-second timeout; on timeout the caller switches to the KMS-only
 *     fallback (NOT waiting). Game never pauses on drand.
 *
 * The `fetchFn` is injectable so this is fully testable offline. Production
 * passes the global fetch; tests pass a stub.
 */

export interface DrandResult {
  round: number;
  /** 32-byte randomness value. */
  randomness: Uint8Array;
  /** Hex form, for receipts. */
  randomnessHex: string;
  /** Which endpoint answered first. */
  source: string;
}

export interface DrandResponseJson {
  round: number;
  randomness: string; // hex
  signature?: string;
  previous_signature?: string;
}

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface DrandClientOptions {
  urls: string[];
  timeoutMs: number;
  fetchFn: FetchFn;
}

export class DrandTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`drand: all endpoints timed out after ${timeoutMs}ms`);
    this.name = 'DrandTimeoutError';
  }
}

function parseDrandJson(raw: unknown, source: string): DrandResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('drand: response not an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj['round'] !== 'number') throw new Error('drand: missing round');
  if (typeof obj['randomness'] !== 'string') throw new Error('drand: missing randomness');
  const randomnessHex = obj['randomness'];
  const randomness = hexToBytes(randomnessHex);
  if (randomness.length !== 32) throw new Error(`drand: randomness must be 32 bytes, got ${randomness.length}`);
  return { round: obj['round'], randomness, randomnessHex, source };
}

/** Shared race: fetch `path` (e.g. '/public/latest') across all endpoints. */
async function raceEndpoints(opts: DrandClientOptions, path: string): Promise<DrandResult> {
  if (opts.urls.length === 0) throw new Error('drand: no urls configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  const attempts = opts.urls.map(async (base) => {
    const url = `${base.replace(/\/$/, '')}${path}`;
    const res = await opts.fetchFn(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`drand: ${url} returned ${res.status}`);
    return parseDrandJson(await res.json(), base);
  });

  try {
    return await Promise.any(attempts);
  } catch (err) {
    if (controller.signal.aborted) throw new DrandTimeoutError(opts.timeoutMs);
    throw new Error(
      `drand: all endpoints failed — ${err instanceof AggregateError ? err.errors.map((e) => (e as Error).message).join('; ') : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the latest drand randomness. Races all endpoints; first valid wins.
 * Throws DrandTimeoutError if none answer within timeoutMs.
 */
export async function fetchDrandLatest(opts: DrandClientOptions): Promise<DrandResult> {
  return raceEndpoints(opts, '/public/latest');
}

/**
 * Fetch a SPECIFIC drand round by number. This is what an independent
 * verifier calls during V2 verification — re-fetching the exact round a hand
 * used and confirming the randomness matches the published receipt.
 */
export async function fetchDrandRound(round: number, opts: DrandClientOptions): Promise<DrandResult> {
  if (!Number.isInteger(round) || round < 0) throw new Error('drand: round must be a non-negative integer');
  return raceEndpoints(opts, `/public/${round}`);
}
