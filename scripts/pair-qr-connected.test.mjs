#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const demoPage = fs.readFileSync(path.join(root, 'src/pages/Demo.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`pair-qr-connected: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  pairLib.includes('onPhoneConnected?: () => void'),
  'desktop pair events should expose an authenticated phone-connected callback'
);

assert(
  pairLib.includes("data.kind === 'phone-here'") && pairLib.includes('events.onPhoneConnected?.()'),
  'desktop flow should notify when the phone-here websocket message arrives'
);

assert(
  demoPage.includes('phoneConnected') &&
    demoPage.includes('const showQr =') &&
    demoPage.includes('!phoneConnected'),
  'desktop demo should track phone connection and suppress QR rendering after connect'
);

assert(
  demoPage.includes('Phone connected') && demoPage.includes('Finish on your phone'),
  'desktop demo should replace QR instructions with a connected waiting state'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-qr-connected: ok');
