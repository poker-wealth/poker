import { sha256 } from '@noble/hashes/sha256';
import { type Card, RANKS, SUITS, cardId, makeCard } from './card.js';

/**
 * Deterministic deck operations — the heart of provably-fair dealing.
 *
 * The deck order is a pure function of `final_seed` (the Commit-Reveal
 * triple-mix output). Same seed → same shuffle, every time, on any machine.
 * Verifiers re-derive the deck from the published seed and compare against
 * what was dealt. If they match, the deal was honest.
 *
 * shuffleDeck() uses Fisher-Yates driven by a SHA-256 counter DRBG so a
 * single 32-byte seed deterministically produces the full 52! permutation
 * space (well, the reachable subset given 256 bits of entropy).
 */

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(makeCard(r, s));
    }
  }
  return deck;
}

/** Unbounded deterministic byte stream from a 32-byte seed: SHA-256(seed || counter). */
export interface ByteStream {
  next(): number; // 0..255
}

export function drbgFromSeed(seed: Uint8Array): ByteStream {
  if (seed.length !== 32) throw new Error('drbgFromSeed: seed must be 32 bytes');
  let counter = 0n;
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let pos = 0;
  return {
    next(): number {
      if (pos >= buf.length) {
        const counterBuf = new Uint8Array(8);
        new DataView(counterBuf.buffer).setBigUint64(0, counter, false);
        counter++;
        const input = new Uint8Array(seed.length + counterBuf.length);
        input.set(seed, 0);
        input.set(counterBuf, seed.length);
        buf = sha256(input);
        pos = 0;
      }
      const b = buf[pos]!;
      pos++;
      return b;
    },
  };
}

/**
 * Integer in [0, max) drawn from `stream`, rejection-sampled to remove modulo
 * bias. Used by Fisher-Yates for unbiased shuffles.
 */
export function uniformIntFromStream(stream: ByteStream, max: number): number {
  if (max <= 0 || max > 0x100000000) throw new Error('uniformIntFromStream: max out of range');
  if (max === 1) return 0;
  const bytesNeeded = Math.ceil(Math.log2(max) / 8);
  const range = 256 ** bytesNeeded;
  const limit = range - (range % max); // largest multiple of max ≤ range
  for (;;) {
    let v = 0;
    for (let i = 0; i < bytesNeeded; i++) v = v * 256 + stream.next();
    if (v < limit) return v % max;
  }
}

/**
 * Fisher-Yates shuffle keyed by a 32-byte seed. Pure: same seed in → same
 * permutation out. Does NOT mutate the input.
 */
export function shuffleDeck(deck: readonly Card[], seed: Uint8Array): Card[] {
  const out = [...deck];
  const stream = drbgFromSeed(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = uniformIntFromStream(stream, i + 1);
    if (j !== i) {
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
  }
  return out;
}

/** Deck as a comma-separated CardId string (for receipts and hashing). */
export function deckToString(deck: readonly Card[]): string {
  return deck.map((c) => cardId(c)).join(',');
}
