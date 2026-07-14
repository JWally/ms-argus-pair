/**
 * Valkey session-state helpers.
 *
 * Mirrors the DDB session-row operations in pair-api.ts, using only
 * native Redis commands (no Lua) by splitting the single session row
 * into per-field keys:
 *
 *   session:{id}:meta     {nonce, expiresAt, host requirement}     — 5min TTL
 *   session:{id}:desktop  {StoredDesktopAttestation}               — 5min TTL
 *   session:{id}:phone    {att, verdict, reason, annotations}      — 5min TTL
 *   claim:{argusSid}      {sessionId, role}                        — 24h TTL
 *
 * Every conditional write becomes a single `SET NX EX` — no scripts.
 * The trick is bundling the phone attestation, verdict, reason, and
 * annotations into one key so the "claim phone slot + record verdict"
 * pair is atomic on a single SET instead of two ordered writes.
 *
 * Reads compose via `MGET` — 1 round-trip pulls the 4 session keys,
 * the app code reassembles them into the existing `SessionItem` shape
 * so downstream handlers don't have to care which store served the
 * data.
 *
 * Feature flag: USE_VALKEY_SESSIONS=true routes session ops through
 * Valkey. Both code paths ship; flip the env to roll back without a
 * code redeploy. When OFF (or unset), all ops stay on DDB.
 */
import { getValkey } from './valkey-client';

const SESSION_TTL_SEC = 300; // 5 minutes — mirrors SESSION_TTL_SECONDS in pair-api.ts
const CLAIM_TTL_SEC = 24 * 3600; // 24h — mirrors ARGUS_SID_LEDGER_TTL_SECONDS

export function isValkeySessionsEnabled(): boolean {
  return process.env.USE_VALKEY_SESSIONS === 'true';
}

// ── Key builders ───────────────────────────────────────────────────
//
// ElastiCache Serverless Valkey runs in cluster mode. Multi-key
// commands (MGET, pipelined writes within a MULTI, etc.) only work
// when every key hashes to the same slot. Redis cluster honors a
// "hash tag" syntax: when a key contains `{...}`, only the substring
// inside the braces is hashed. So wrapping `{id}` in every session
// key guarantees all 4 fields for the same session colocate.
//
// Argus-claim keys aren't multi-key'd with anything (no MGET, no
// MULTI), so we don't need to tag them — but doing so consistently
// keeps the convention uniform and lets future read-many ops work
// against the same session without re-design.

const metaKey = (id: string) => `session:{${id}}:meta`;
const desktopKey = (id: string) => `session:{${id}}:desktop`;
const phoneKey = (id: string) => `session:{${id}}:phone`;
const claimKey = (argusSid: string) => `claim:{${argusSid}}`;

// ── Shared type — kept in sync with pair-api.ts ─────────────────────
// Defining a lightweight alias here so we don't have to import the
// full StoredAttestation chain. Callers cast to the concrete type
// when reassembling SessionItem.

type SessionFieldBlob = Record<string, unknown>;

export interface SessionMeta {
  nonce: string;
  expiresAt: number;
  /** Merchant-generated identifier for the single protected action. */
  challengeId: string;
  /** Merchant CPI this session is attributed to, when created via the embed widget. */
  cpi?: string | null;
  /** Server-resolved scoped-CPI policy, snapshotted when the session starts. */
  proofRequired?: boolean;
  /** Cached device trust is insufficient; require a fresh passkey/OAuth ceremony. */
  freshProofRequired?: boolean;
  /** Cross-origin embeds must attach a bound merchant-realm scan with desktop-attest. */
  hostPreflightRequired?: boolean;
  /** Exact merchant origin the required host scan must sign. */
  hostOrigin?: string;
  /** Legacy sessions stored host evidence in meta before async attachment shipped. */
  hostAttestation?: SessionFieldBlob;
}

export interface PhoneBundle {
  att: SessionFieldBlob;
  verdict: 'pending' | 'paired' | 'failed';
  reason: string | null;
  annotations: Record<string, unknown>;
}

/**
 * MGETs the 3 session keys in one round-trip, returns the raw JSON
 * strings (or null for keys that don't exist). Caller decides how to
 * reassemble into the SessionItem shape.
 */
export async function mgetSession(sessionId: string): Promise<{
  meta: SessionMeta | null;
  desktop: SessionFieldBlob | null;
  phone: PhoneBundle | null;
}> {
  const valkey = getValkey();
  const [meta, desktop, phone] = await valkey.mget(
    metaKey(sessionId),
    desktopKey(sessionId),
    phoneKey(sessionId)
  );
  return {
    meta: meta ? (JSON.parse(meta) as SessionMeta) : null,
    desktop: desktop ? (JSON.parse(desktop) as SessionFieldBlob) : null,
    phone: phone ? (JSON.parse(phone) as PhoneBundle) : null,
  };
}

/**
 * Create a new session. SET NX guarantees idempotency on the (vanishingly
 * unlikely) UUID collision. Returns false if the key already existed.
 */
export async function startSessionValkey(sessionId: string, meta: SessionMeta): Promise<boolean> {
  const valkey = getValkey();
  // ioredis: `SET key value EX seconds NX` — returns 'OK' on success, null on NX-fail.
  const r = await valkey.set(metaKey(sessionId), JSON.stringify(meta), 'EX', SESSION_TTL_SEC, 'NX');
  return r === 'OK';
}

/**
 * Atomic claim of the desktop attestation slot. Returns false if the
 * slot was already taken — caller maps to 409 already_attested.
 */
export async function recordDesktopAttestationValkey(
  sessionId: string,
  att: SessionFieldBlob
): Promise<boolean> {
  const valkey = getValkey();
  const r = await valkey.set(
    desktopKey(sessionId),
    JSON.stringify(att),
    'EX',
    SESSION_TTL_SEC,
    'NX'
  );
  return r === 'OK';
}

/**
 * Atomic claim of the phone attestation slot. The verdict, reason,
 * and annotations are bundled into the same blob so this single SET
 * commits the whole verdict atomically — no need for a second write.
 *
 * Returns the existing bundle when the SET fails (somebody else won
 * the race) so the caller can return an idempotent success response
 * with the winning verdict.
 */
export async function recordPhoneAttestationValkey(
  sessionId: string,
  bundle: PhoneBundle
): Promise<{ ok: true } | { ok: false; existing: PhoneBundle | null }> {
  const valkey = getValkey();
  const r = await valkey.set(
    phoneKey(sessionId),
    JSON.stringify(bundle),
    'EX',
    SESSION_TTL_SEC,
    'NX'
  );
  if (r === 'OK') return { ok: true };
  const existingRaw = await valkey.get(phoneKey(sessionId));
  return {
    ok: false,
    existing: existingRaw ? (JSON.parse(existingRaw) as PhoneBundle) : null,
  };
}

/**
 * Claim an argusSessionId so it can't be recycled. 24h TTL deliberately
 * outlives the session itself — recycling concerns persist after the
 * pair session has expired and been discarded.
 */
export async function claimArgusValkey(
  argusSid: string,
  pairSessionId: string,
  role: 'host' | 'desktop' | 'phone'
): Promise<{ ok: true } | { ok: false; reason: 'already_claimed' }> {
  const valkey = getValkey();
  const r = await valkey.set(
    claimKey(argusSid),
    JSON.stringify({ sessionId: pairSessionId, role, claimedAt: Math.floor(Date.now() / 1000) }),
    'EX',
    CLAIM_TTL_SEC,
    'NX'
  );
  if (r === 'OK') return { ok: true };
  // Idempotent re-claim: the same pair session can legitimately re-submit the
  // same argusSessionId (silent device-trust redeem claims it, 401s on its
  // IP-pinned verify without storing, then the WebAuthn fallback re-submits
  // the SAME scan). That retry must not 409. Only a DIFFERENT pair session
  // reusing the id is the recycling attack the claim defends against.
  const existingRaw = await valkey.get(claimKey(argusSid));
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as { sessionId?: string; role?: string };
      if (existing.sessionId === pairSessionId && existing.role === role) {
        return { ok: true };
      }
    } catch {
      /* unparseable existing claim — fall through to reject */
    }
  }
  return { ok: false, reason: 'already_claimed' };
}
