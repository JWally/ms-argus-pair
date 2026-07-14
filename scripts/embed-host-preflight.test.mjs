import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [loader, embed, pair] = await Promise.all([
  read('loader/loader.ts'),
  read('src/pages/Embed.tsx'),
  read('src/lib/pair.ts'),
]);

assert.match(loader, /runHostPreflight/);
assert.match(loader, /event: 'host-scan'/);
assert.match(loader, /event === 'host-scan-request'/);
assert.match(loader, /hostPreflight=1/);
assert.match(embed, /host-scan-request/);
assert.match(embed, /hostPreflight/);
assert.match(pair, /requestHostPreflight/);
assert.match(pair, /hostPreflightRequired/);

const startDesktop = embed.indexOf('startDesktopSession(');
const preStartBody = embed.slice(embed.indexOf('(async () => {'), startDesktop);
assert.ok(startDesktop >= 0, 'startDesktopSession call missing');
assert.doesNotMatch(
  preStartBody,
  /await requestHostPreflight/,
  'QR startup must not await the merchant-realm scan'
);

const sessionStart = pair.indexOf('jsonFetch<SessionStartResp>');
const qrMint = pair.indexOf('mintDesktopQr(', sessionStart);
const evidenceStart = pair.indexOf('desktopEvidencePromise', sessionStart);
assert.ok(sessionStart >= 0 && qrMint > sessionStart, 'desktop session/QR sequence changed');
assert.ok(
  evidenceStart > sessionStart && evidenceStart < qrMint,
  'desktop evidence must begin before QR minting completes'
);

const ssoStart = loader.indexOf('function startMobileSso');
const ssoEnd = loader.indexOf('\n  const auto =', ssoStart);
assert.ok(ssoStart >= 0 && ssoEnd > ssoStart, 'startMobileSso function boundary changed');
const ssoBody = loader.slice(ssoStart, ssoEnd);
assert.doesNotMatch(ssoBody, /hostPreflight|runHostPreflight|host-scan|argus\.run/);
assert.match(ssoBody, /window\.location\.assign/);

console.log('embed-host-preflight: ok');
