#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// The desktop must learn when the phone connects, so the QR surface can react
// (flip/blur, never remove). The marketing Demo page moved to ms-argus-www; the
// durable guarantee is the lib/pair contract that fires onPhoneConnected on the
// phone-here websocket message.
const root = process.cwd();
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const desktopRuntime = fs.readFileSync(
  path.join(root, 'src/lib/desktop-session-runtime.ts'),
  'utf8'
);

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
  desktopRuntime.includes("case 'phone-here'") &&
    desktopRuntime.includes('this.options.onPhoneConnected?.()'),
  'desktop flow should notify when the phone-here websocket message arrives'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-qr-connected: ok');
