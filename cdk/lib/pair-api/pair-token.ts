/*
 * Short-token pairing indirection.
 *
 * The QR must stay sparse (fat modules) for the spatial-frequency poison in
 * qr-paint.ts to survive a real camera read. Packing {wsUrl, e, pt, n} into the
 * URL fragment makes a ~170-char payload → 53×53 QR → tiny modules → poison
 * breaks it. Instead the desktop mints a short single-use token and encodes
 * `/p/<token>` (~33×33); the phone redeems it for the same blob.
 *
 * All four blob fields are server-minted already (wsUrl is the WS API URL, `e`
 * is a server-sealed envelope, `pt`/`n` are server tokens/nonce), so brokering
 * them through the server exposes nothing new — it's the same relay the fragment
 * did, just via a token instead of the QR carrying the whole thing.
 *
 * Single-use is enforced by the store's atomic `take` (GETDEL on Valkey).
 */
import { randomBytes } from 'node:crypto';

export const PAIR_TOKEN_TTL_SEC = 300; // matches the 5-min session TTL

export interface PairBlob {
  sessionId: string; // so the phone can navigate to /pair/{sessionId}
  wsUrl: string;
  e: string; // desktop's sealed connection envelope
  pt: string; // phone WS bootstrap token
  n: string; // session nonce
  /** Server-resolved policy bit. The desktop cannot select this value. */
  proofRequired: boolean;
  /** Server-resolved fresh-auth bit. Cached device trust cannot satisfy it. */
  freshProofRequired: boolean;
}

/** Minimal KV the token needs. `take` must be atomic get-and-delete (single-use). */
export interface KvStore {
  set(key: string, value: string, ttlSec: number): Promise<void>;
  take(key: string): Promise<string | null>;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;
const keyOf = (token: string) => `ptoken:${token}`;

export async function mintPairToken(store: KvStore, blob: PairBlob): Promise<string> {
  const token = randomBytes(16).toString('base64url'); // 128-bit, ~22 url-safe chars
  await store.set(keyOf(token), JSON.stringify(blob), PAIR_TOKEN_TTL_SEC);
  return token;
}

export async function redeemPairToken(store: KvStore, token: string): Promise<PairBlob | null> {
  if (!TOKEN_RE.test(token)) return null;
  const raw = await store.take(keyOf(token));
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as PairBlob;
    if (
      typeof b.sessionId === 'string' &&
      typeof b.wsUrl === 'string' &&
      typeof b.e === 'string' &&
      typeof b.pt === 'string' &&
      typeof b.n === 'string' &&
      typeof b.proofRequired === 'boolean' &&
      typeof b.freshProofRequired === 'boolean'
    ) {
      return b;
    }
    return null;
  } catch {
    return null;
  }
}
