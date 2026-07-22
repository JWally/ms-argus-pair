#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const phoneSessionRuntime = fs.readFileSync(
  path.join(root, 'src/lib/phone-session-runtime.ts'),
  'utf8'
);
const phoneMain = fs.readFileSync(path.join(root, 'src/phone-main.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`phone-scan-background: ${message}`);
    process.exitCode = 1;
  }
}

const waitForArgusBody = pairLib.match(/async function waitForArgus[\s\S]*?\n}/)?.[0] ?? '';
const startPhoneScanBody =
  pairLib.match(/async function startPhoneIntegrityScan[\s\S]*?\n}\n\n\/\*\*/)?.[0] ?? '';
const scanStart = phoneSessionRuntime.indexOf('deps.startScan(sessionId, binding.nonce)');
const desktopConnect = phoneSessionRuntime.indexOf('await deps.connect');

assert(
  scanStart >= 0 && desktopConnect >= 0 && scanStart < desktopConnect,
  'phone integrity must start before waiting for the desktop connection'
);
assert(
  phoneSessionRuntime.includes('LATENCY CONTRACT: do not move this scan'),
  'the eager-scan latency contract should remain documented at its call site'
);
assert(
  waitForArgusBody.includes('await awaitWithDeadline(') &&
    waitForArgusBody.includes('window.argusBootstrapReady') &&
    startPhoneScanBody.includes('await waitForArgus()'),
  'eager scanning must wait for the signed SDK bootstrap instead of racing window.argus'
);
assert(
  phoneSessionRuntime.includes('getScanPromise: () => scanPromise'),
  'all proof paths should share the eager scan promise'
);
assert(
  phoneMain.includes("onScanStart: () => recordPhonePerf('scan_start'") &&
    phoneMain.includes("recordPhonePerf('scan_done'"),
  'phone timing must record the real background scan window in the batched timeline'
);
assert(
  phoneMain.includes("void pair('integrity', { keepDrawingBoard: true })"),
  'Fast Pass should keep the challenge visible while submission finishes'
);
assert(
  /if \(state\.inflight\) \{\s*setState\(\{ challengeIndex: state\.challengeIndex \+ 1 \}\)/s.test(
    phoneMain
  ),
  'the challenge should continue advancing while background work is in flight'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('phone-scan-background: ok');
