/*
 * TDD spec for the short-token pairing indirection.
 *
 * The QR must be sparse enough for the spatial-frequency poison to survive, so
 * instead of packing {wsUrl, e, pt, n} into the URL fragment (~170 chars → 53×53
 * QR, poison breaks it) the desktop mints a short single-use token and the phone
 * redeems it for that blob. This tests the mint/redeem semantics against an
 * in-memory store; the server wires the same interface to Valkey (SET EX / GETDEL).
 */
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

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log('  ok  -', msg);
  else {
    console.error('  FAIL-', msg);
    failures += 1;
  }
};

const blob: PairBlob = {
  sessionId: 'sess-123',
  wsUrl: 'wss://x/prod',
  e: 'sealed-envelope',
  pt: 'phone-tok',
  n: 'nonce-xyz',
};

// 1. unguessable, unique tokens
{
  const s = memStore();
  const a = await mintPairToken(s, blob);
  const b = await mintPairToken(s, blob);
  assert(/^[A-Za-z0-9_-]{20,}$/.test(a), 'token is url-safe and ≥20 chars (≥128 bits entropy)');
  assert(a !== b, 'each mint yields a unique token');
}
// 2. redeem returns the exact blob
{
  const s = memStore();
  const t = await mintPairToken(s, blob);
  const got = await redeemPairToken(s, t);
  assert(
    !!got &&
      got.sessionId === blob.sessionId &&
      got.wsUrl === blob.wsUrl &&
      got.e === blob.e &&
      got.pt === blob.pt &&
      got.n === blob.n,
    'redeem returns the exact blob'
  );
}
// 3. single-use
{
  const s = memStore();
  const t = await mintPairToken(s, blob);
  await redeemPairToken(s, t);
  assert((await redeemPairToken(s, t)) === null, 'second redeem is null (single-use)');
}
// 4. unknown / malformed token
{
  const s = memStore();
  assert((await redeemPairToken(s, 'not-a-real-token')) === null, 'unknown token → null');
  assert((await redeemPairToken(s, '')) === null, 'empty token → null');
}
// 5. TTL expiry
{
  const s = memStore();
  const t = await mintPairToken(s, blob);
  s.advance(PAIR_TOKEN_TTL_SEC + 1);
  assert((await redeemPairToken(s, t)) === null, 'expired token → null');
}

if (failures) {
  console.error(`pair-token: ${failures} FAILED`);
  process.exit(1);
}
console.log('pair-token: all passed');
