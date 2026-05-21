/**
 * Financial Core HTTP client — game-server → financial-core /api/v1/internal/*.
 *
 * Server-to-server calls authenticated with the shared X-Internal-Token
 * (M2 W3+ replaces this with a service JWT). All money crosses as strings
 * (BigInt cents) per the FC API contract.
 *
 * Pure transport — inject `fetchFn` for tests. No retry here; the FC
 * endpoints are themselves idempotent (Idempotency-Key), so the caller
 * retries safely.
 */

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface FcClientOptions {
  baseUrl: string;
  internalToken: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export class FcError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'FcError';
  }
}

export interface AccountRefDto {
  type: string;
  owner_id: string;
  wallet_scope?: string;
}

export interface SettleRoundRequest {
  round_id: string;
  table_id: string;
  table_type: 'PLATFORM' | 'LEAGUE';
  league_id?: string | null;
  winner_owner_id: string;
  winner_profit: string; // BigInt cents as string
  rake_amount: string;
  losers: Array<{ owner_id: string; contribution: string }>;
}

export interface SettlePotsRequest {
  round_id: string;
  table_id: string;
  table_type: 'PLATFORM' | 'LEAGUE';
  league_id?: string | null;
  rake_amount: string;
  net_deltas: Array<{ owner_id: string; net: string; wallet_scope?: string }>;
}

export interface DepositCreditRequest {
  player_id: string;
  amount: string;
  tx_hash: string;
  contract_address: string;
  confirmations: number;
  block_number?: number;
  wallet_scope?: string;
}

export interface TransferRequest {
  from?: AccountRefDto;
  to?: AccountRefDto;
  amount: string;
  ledger_type: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

const defaultFetch: FetchFn = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });

export class FcClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(opts: FcClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.internalToken;
    this.fetchFn = opts.fetchFn ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async health(): Promise<{ status: string; mongo: string }> {
    return this.request('GET', '/api/v1/health', undefined, false) as Promise<{
      status: string;
      mongo: string;
    }>;
  }

  async settleRound(req: SettleRoundRequest, idempotencyKey?: string): Promise<unknown> {
    return this.request('POST', '/api/v1/internal/settle-round', req, true, idempotencyKey);
  }

  /** Multi-winner settlement (split / side pots). */
  async settlePots(req: SettlePotsRequest, idempotencyKey?: string): Promise<unknown> {
    return this.request('POST', '/api/v1/internal/settle-pots', req, true, idempotencyKey);
  }

  async creditDeposit(req: DepositCreditRequest): Promise<unknown> {
    return this.request('POST', '/api/v1/internal/deposit/credit', req, true);
  }

  async transfer(req: TransferRequest, idempotencyKey: string): Promise<unknown> {
    return this.request('POST', '/api/v1/internal/transfer', req, true, idempotencyKey);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    internal: boolean,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (internal) headers['X-Internal-Token'] = this.token;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed: unknown = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const p = (parsed ?? {}) as { code?: string; detail?: string; title?: string };
        throw new FcError(res.status, p.code ?? 'UNKNOWN', p.detail ?? p.title ?? `HTTP ${res.status}`, parsed);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}
