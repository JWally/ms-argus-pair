/*
 * TDD spec for the short-token pairing indirection.
 *
 * The QR must be sparse enough for the spatial-frequency poison to survive, so
 * instead of packing {wsUrl, e, pt, n} into the URL fragment (~170 chars → 53×53
 * QR, poison breaks it) the desktop mints a short single-use token and the phone
 * redeems it for that blob. This tests the mint/redeem semantics against an
 * in-memory store; the server wires the same interface to Valkey (SET EX / GETDEL).
 */
import { describe, expect, it } from 'vitest';
import {
  mintPairToken,
  redeemPairToken,
  PAIR_TOKEN_TTL_SEC,
  type KvStore,
  type PairBlob,
} from '../cdk/lib/pair-api/pair-token.ts';

let now = 1_000_000;
function memStore(): KvStore & { advance: (s: number) => void } {
  const m = new Map<string, { v: string; exp: number }>();
  return {
    async set(k, v, ttl) {
      m.set(k, { v, exp: now + ttl });
    },
    async take(k) {
      const e = m.get(k);
      if (!e) return null;
      m.delete(k);
      return e.exp < now ? null : e.v;
    },
    advance(s) {
      now += s;
    },
  };
}

const blob: PairBlob = {
  sessionId: 'sess-123',
  wsUrl: 'wss://x/prod',
  e: 'sealed-envelope',
  pt: 'phone-tok',
  n: 'nonce-xyz',
};

describe('pair-token mint/redeem', () => {
  it('mints url-safe, unique tokens with ≥128 bits entropy', async () => {
    const s = memStore();
    const a = await mintPairToken(s, blob);
    const b = await mintPairToken(s, blob);
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(a).not.toBe(b);
  });

  it('redeem returns the exact blob', async () => {
    const s = memStore();
    const t = await mintPairToken(s, blob);
    expect(await redeemPairToken(s, t)).toEqual(blob);
  });

  it('is single-use: second redeem is null', async () => {
    const s = memStore();
    const t = await mintPairToken(s, blob);
    await redeemPairToken(s, t);
    expect(await redeemPairToken(s, t)).toBeNull();
  });

  it('unknown and empty tokens redeem to null', async () => {
    const s = memStore();
    expect(await redeemPairToken(s, 'not-a-real-token')).toBeNull();
    expect(await redeemPairToken(s, '')).toBeNull();
  });

  it('expired tokens redeem to null', async () => {
    const s = memStore();
    const t = await mintPairToken(s, blob);
    s.advance(PAIR_TOKEN_TTL_SEC + 1);
    expect(await redeemPairToken(s, t)).toBeNull();
  });
});
