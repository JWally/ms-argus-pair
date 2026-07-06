/*
 * E2E contract test against the DEPLOYED pair stack — the standing regression
 * guard for the red-team (2026-07-03) QR-extraction family.
 *
 * The premise we ACCEPT: a sufficiently capable bot can obtain /p/<token> (by
 * substituting the QR worker, or ultimately by optically decoding the on-screen
 * QR). QR secrecy is a speed-bump, not the lock. So this test proves the actual
 * lock holds: a stolen, redeemed pair-token CANNOT produce a `paired` verdict
 * without genuine phone-side proof. If anyone regresses phone-attest to fail
 * OPEN, this goes red.
 *
 * It also asserts the mint stays sealed (no plaintext token leaks in the
 * response) and that a redeemed token is single-use.
 *
 * Run: `npm run test:e2e` (PAIR_HOST overrides the target; default dev-jw).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  genKeyPair,
  exportPubRaw,
  importPubRaw,
  deriveAesKey,
  openBytes,
} from '../../src/lib/ecdh-seal.ts';
import { fibScramble } from '../../src/lib/fib-scramble.ts';

const HOST = process.env.PAIR_HOST ?? 'https://captcha-dev-jw.argus.pw';
// eslint-disable-next-line security/detect-unsafe-regex -- bounded scan of Vite asset names in deployed HTML/JS.
const WORKER_ASSET_PATTERN = /(?:\/?assets\/)?pair-qr-worker-[A-Za-z0-9_-]+\.js/g;
// eslint-disable-next-line security/detect-unsafe-regex -- bounded scan of Vite asset names in deployed HTML/JS.
const JS_ASSET_PATTERN = /(?:\/?assets\/)?[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js/g;

interface SessionStart {
  sessionId: string;
  nonce: string;
  ws: { url: string | null; desktopToken: string; phoneToken: string };
}

async function startSession(): Promise<SessionStart> {
  const res = await fetch(`${HOST}/api/session/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<SessionStart>;
}

let workerMetadataPromise: Promise<{ workerUrl: string; workerSha256: string }> | null = null;

async function findWorkerAsset(): Promise<string> {
  const root = await (await fetch(`${HOST}/`)).text();
  const scriptPaths = Array.from(root.matchAll(/<script[^>]+src="([^"]+\.js)"/g), (m) => m[1]);
  const candidates = new Set(root.match(WORKER_ASSET_PATTERN) ?? []);
  const pending = scriptPaths.map((scriptPath) => new URL(scriptPath, HOST).href);
  const visited = new Set<string>();

  for (const scriptUrl of pending) {
    if (visited.has(scriptUrl)) continue;
    visited.add(scriptUrl);
    const script = await (await fetch(scriptUrl)).text();
    for (const match of script.match(WORKER_ASSET_PATTERN) ?? []) {
      candidates.add(match);
    }
    for (const match of script.match(JS_ASSET_PATTERN) ?? []) {
      const nextUrl = new URL(match.startsWith('/') ? match : `/${match}`, HOST).href;
      if (!visited.has(nextUrl)) pending.push(nextUrl);
    }
  }

  const workerPath = [...candidates].find((candidate) => candidate.includes('pair-qr-worker-'));
  if (!workerPath) {
    throw new Error('pair QR worker asset was not discoverable from deployed scripts');
  }
  return new URL(workerPath.startsWith('/') ? workerPath : `/${workerPath}`, HOST).href;
}

async function workerMetadata(): Promise<{ workerUrl: string; workerSha256: string }> {
  workerMetadataPromise ??= (async () => {
    const workerUrl = await findWorkerAsset();
    const bytes = Buffer.from(await (await fetch(workerUrl)).arrayBuffer());
    const workerSha256 = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    return { workerUrl, workerSha256 };
  })();
  return workerMetadataPromise;
}

/** Mint + decrypt the sealed pair-token — models a bot that lifted it. */
async function stealToken(s: SessionStart): Promise<{ token: string; sealed: boolean }> {
  const client = await genKeyPair();
  const cPub = await exportPubRaw(client.publicKey);
  const worker = await workerMetadata();
  const res = await fetch(
    `${HOST}/api/session/${s.sessionId}/pair-token?t=${encodeURIComponent(s.ws.desktopToken)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wsUrl: s.ws.url ?? 'wss://x',
        e: 'e2e-desktop-envelope',
        pt: s.ws.phoneToken,
        n: s.nonce,
        cPub,
        workerUrl: worker.workerUrl,
        workerSha256: worker.workerSha256,
      }),
    }
  );
  expect(res.status).toBe(200);
  const mint = (await res.json()) as { token?: string; enc?: string; sPub?: string };
  const sealed =
    typeof mint.enc === 'string' && typeof mint.sPub === 'string' && !('token' in mint);
  const aes = await deriveAesKey(client.privateKey, await importPubRaw(mint.sPub!));
  // AES-open yields the fib-scrambled token bytes; un-scramble to the token
  // (what the wasm enclave does internally — replicated here to model a bot
  // that reversed it). fibScramble is self-inverse.
  const token = new TextDecoder().decode(
    fibScramble(await openBytes(aes, mint.enc!), worker.workerSha256)
  );
  return { token, sealed };
}

describe('stolen pair-token cannot forge a pairing (e2e)', () => {
  it('the mint stays sealed — no plaintext token in the response', async () => {
    const s = await startSession();
    const { token, sealed } = await stealToken(s);
    expect(sealed).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it('a redeemed token is single-use (second redeem is gone)', async () => {
    const s = await startSession();
    const { token } = await stealToken(s);

    const first = await fetch(`${HOST}/api/pair-token/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);
    const bundle = (await first.json()) as Record<string, string>;
    expect(bundle.sessionId).toBe(s.sessionId);

    const second = await fetch(`${HOST}/api/pair-token/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(second.status).toBe(410); // token_expired_or_used
  });

  it('a redeemed token + forged phone-attest does NOT yield a paired verdict', async () => {
    const s = await startSession();
    const { token } = await stealToken(s);
    const bundle = (await (
      await fetch(`${HOST}/api/pair-token/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    ).json()) as Record<string, string>;

    // Attacker holds the full bundle but has no real phone / valid attestation.
    const res = await fetch(`${HOST}/api/session/${s.sessionId}/phone-attest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        argusSessionId: 'forged-argus-session',
        attestation: { envelope: 'x', signature: 'x', publicKey: 'x', keyId: 'x' },
        desktopEnvelope: bundle.e,
      }),
    });
    const out = (await res.json().catch(() => ({}))) as { verdict?: string };
    // Fail-closed: the server MUST NOT pair. Any 4xx, or a non-`paired`
    // verdict, satisfies it — we don't pin the exact reason so legitimate
    // error-code changes don't make this brittle.
    expect(res.status >= 400 || out.verdict !== 'paired').toBe(true);
  });
});
