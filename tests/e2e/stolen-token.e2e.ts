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
import { gunzipSync } from 'node:zlib';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  genKeyPair,
  exportPubRaw,
  importPubRaw,
  deriveAesKey,
  openBytes,
} from '../../src/lib/ecdh-seal.ts';
import { unpackQrFrameBundle } from '../../src/lib/qr-frame-bundle.ts';
import { SERVER_QR_QUIET_MODULES, SERVER_QR_SCALE } from '../../cdk/lib/pair-api/server-qr-png.ts';

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

function isDark(png: PNG, x: number, y: number): boolean {
  const index = (y * png.width + x) * 4;
  // eslint-disable-next-line security/detect-object-injection -- bounded PNG pixel read in test decoder.
  return (png.data[index] + png.data[index + 1] + png.data[index + 2]) / 3 < 128;
}

function setPixel(data: Uint8ClampedArray, width: number, x: number, y: number, dark: boolean) {
  const index = (y * width + x) * 4;
  const value = dark ? 0 : 255;
  // eslint-disable-next-line security/detect-object-injection -- bounded RGBA buffer write in test decoder.
  data[index] = value;
  data[index + 1] = value;
  data[index + 2] = value;
  data[index + 3] = 255;
}

function moduleIsMostlyDark(png: PNG, row: number, col: number): boolean {
  let dark = 0;
  let total = 0;
  const x0 = (col + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE;
  const y0 = (row + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE;
  for (let y = 2; y < SERVER_QR_SCALE - 2; y += 1) {
    for (let x = 2; x < SERVER_QR_SCALE - 2; x += 1) {
      total += 1;
      if (isDark(png, x0 + x, y0 + y)) dark += 1;
    }
  }
  return dark > total / 2;
}

function paintCleanModule(
  clean: Uint8ClampedArray,
  cleanWidth: number,
  row: number,
  col: number,
  dark: boolean
): void {
  const cleanScale = 10;
  for (let y = 0; y < cleanScale; y += 1) {
    for (let x = 0; x < cleanScale; x += 1) {
      setPixel(
        clean,
        cleanWidth,
        (col + SERVER_QR_QUIET_MODULES) * cleanScale + x,
        (row + SERVER_QR_QUIET_MODULES) * cleanScale + y,
        dark
      );
    }
  }
}

function decodeTokenFromServerQrPng(bytes: Uint8Array): string {
  const png = PNG.sync.read(Buffer.from(bytes));
  const moduleCount = png.width / SERVER_QR_SCALE - SERVER_QR_QUIET_MODULES * 2;
  expect(Number.isInteger(moduleCount)).toBe(true);

  const cleanScale = 10;
  const cleanWidth = (moduleCount + SERVER_QR_QUIET_MODULES * 2) * cleanScale;
  const clean = new Uint8ClampedArray(cleanWidth * cleanWidth * 4);
  clean.fill(255);
  // eslint-disable-next-line security/detect-object-injection -- bounded alpha-channel fill in test decoder.
  for (let index = 3; index < clean.length; index += 4) clean[index] = 255;

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      paintCleanModule(clean, cleanWidth, row, col, moduleIsMostlyDark(png, row, col));
    }
  }

  const decoded = jsQR(clean, cleanWidth, cleanWidth, { inversionAttempts: 'dontInvert' })?.data;
  const token = decoded?.match(/\/p\/([^?#]+)/)?.[1];
  if (!token) throw new Error('server QR PNG did not decode to /p/<token>');
  return token;
}

function decodeTokenFromServerQrFrames(frames: Uint8Array[]): string {
  for (const frame of frames) {
    try {
      return decodeTokenFromServerQrPng(frame);
    } catch {
      /* Animation frames are intentionally uneven; try the next frame. */
    }
  }
  throw new Error('server QR PNG frames did not decode to /p/<token>');
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

/** Mint + decrypt the sealed QR PNG, then optically recover /p/<token>. */
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
  const mint = (await res.json()) as {
    token?: string;
    enc?: string;
    sPub?: string;
    kind?: string;
    compression?: string;
  };
  const sealed =
    typeof mint.enc === 'string' && typeof mint.sPub === 'string' && !('token' in mint);
  const aes = await deriveAesKey(client.privateKey, await importPubRaw(mint.sPub!));
  let opened = await openBytes(aes, mint.enc!);
  if (mint.compression === 'gzip') opened = gunzipSync(opened);
  const token =
    mint.kind === 'png-frames'
      ? decodeTokenFromServerQrFrames(unpackQrFrameBundle(opened).frames)
      : decodeTokenFromServerQrPng(opened);
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
