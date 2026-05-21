import { bytesToHex } from '@noble/hashes/utils';
import {
  DrandTimeoutError,
  fetchDrandLatest,
  type FetchFn,
} from '../../src/provably-fair/drand';

const VALID_RANDOMNESS = 'a'.repeat(64); // 32 bytes hex

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('provably-fair/drand', () => {
  it('returns the first valid response (Promise.any race)', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('fast')) return jsonResponse({ round: 100, randomness: VALID_RANDOMNESS });
      // slow endpoint: never resolves within the test
      return new Promise(() => {}) as never;
    };
    const r = await fetchDrandLatest({
      urls: ['https://fast.example', 'https://slow.example'],
      timeoutMs: 1000,
      fetchFn,
    });
    expect(r.round).toBe(100);
    expect(r.randomness).toHaveLength(32);
    expect(bytesToHex(r.randomness)).toBe(VALID_RANDOMNESS);
    expect(r.source).toBe('https://fast.example');
  });

  it('ignores a failing endpoint if another succeeds', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('bad')) return jsonResponse({}, false, 500);
      return jsonResponse({ round: 7, randomness: VALID_RANDOMNESS });
    };
    const r = await fetchDrandLatest({
      urls: ['https://bad.example', 'https://good.example'],
      timeoutMs: 1000,
      fetchFn,
    });
    expect(r.round).toBe(7);
    expect(r.source).toBe('https://good.example');
  });

  it('throws DrandTimeoutError when all endpoints exceed the timeout', async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      fetchDrandLatest({
        urls: ['https://a.example', 'https://b.example'],
        timeoutMs: 50,
        fetchFn,
      }),
    ).rejects.toBeInstanceOf(DrandTimeoutError);
  });

  it('rejects randomness that is not 32 bytes', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ round: 1, randomness: 'ab' });
    await expect(
      fetchDrandLatest({ urls: ['https://x.example'], timeoutMs: 1000, fetchFn }),
    ).rejects.toThrow(/all endpoints failed/);
  });

  it('rejects malformed JSON (missing round)', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ randomness: VALID_RANDOMNESS });
    await expect(
      fetchDrandLatest({ urls: ['https://x.example'], timeoutMs: 1000, fetchFn }),
    ).rejects.toThrow(/all endpoints failed/);
  });

  it('throws if no urls configured', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({});
    await expect(
      fetchDrandLatest({ urls: [], timeoutMs: 1000, fetchFn }),
    ).rejects.toThrow(/no urls/);
  });
});
