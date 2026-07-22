import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [loader, embed, embedSession, pair, desktopBootstrap] = await Promise.all([
  read('loader/loader.ts'),
  read('src/pages/Embed.tsx'),
  read('src/lib/embed-session.ts'),
  read('src/lib/pair.ts'),
  read('src/lib/desktop-session-bootstrap.ts'),
]);

// The standard captcha embed runs only the isolated Pair scan. Keep the
// server-side host-evidence protocol dormant until it has a deliberate design.
assert.doesNotMatch(loader, /runHostPreflight|host-scan|hostPreflight=1|argus\.run/);
assert.doesNotMatch(`${embed}\n${embedSession}`, /requestHostPreflight|host-scan|hostPreflight/);
assert.match(pair, /role: 'desktop'/);

const sessionStart = pair.indexOf(
  'const { session, desktopConn } = await bootstrapDesktopSession('
);
const qrMint = pair.indexOf('mintDesktopQr(', sessionStart);
const evidenceStart = pair.indexOf('desktopEvidencePromise', sessionStart);
assert.ok(sessionStart >= 0 && qrMint > sessionStart, 'desktop session/QR sequence changed');
assert.ok(
  evidenceStart > sessionStart && evidenceStart < qrMint,
  'isolated desktop evidence must begin before QR minting completes'
);
assert.match(desktopBootstrap, /dependencies\.startSession\(buildStartBody\(options\)\)/);

const ssoStart = loader.indexOf('function startMobileSso');
const ssoEnd = loader.indexOf('\n  const auto =', ssoStart);
assert.ok(ssoStart >= 0 && ssoEnd > ssoStart, 'startMobileSso function boundary changed');
const ssoBody = loader.slice(ssoStart, ssoEnd);
assert.doesNotMatch(ssoBody, /argus\.run/);
assert.match(ssoBody, /window\.location\.assign/);

console.log('embed-single-scan: ok');
