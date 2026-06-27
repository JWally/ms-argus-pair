#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const pairPage = fs.readFileSync(path.join(root, 'src/pages/Pair.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`phone-scan-lazy: ${message}`);
    process.exitCode = 1;
  }
}

const awaitDesktopReadyBody =
  pairLib.match(/export async function awaitDesktopReady[\s\S]*?\n}\n\n\/\*\*/)?.[0] ?? '';
const startPhoneScanBody =
  pairLib.match(/function startPhoneIntegrityScan[\s\S]*?\n}\n\n\/\*\*/)?.[0] ?? '';

assert(
  pairLib.includes('getScanPromise: () => Promise<ArgusRunResult>'),
  'PhoneSessionInfo should expose a lazy scan getter instead of an eager scan promise'
);

assert(
  startPhoneScanBody.includes('argus.run') && startPhoneScanBody.includes("role: 'phone'"),
  'phone integrity scan should live in an explicit lazy helper'
);

assert(
  awaitDesktopReadyBody.includes('let scanPromise: Promise<ArgusRunResult> | null = null') &&
    awaitDesktopReadyBody.includes('const getScanPromise = () =>') &&
    awaitDesktopReadyBody.includes('getScanPromise,') &&
    !awaitDesktopReadyBody.includes('const argus = getArgus()') &&
    !awaitDesktopReadyBody.includes('const scanPromise = argus.run'),
  'awaitDesktopReady should not start Argus while the cheap dialpad is loading'
);

assert(
  pairLib.includes('info.getScanPromise()') && !pairLib.includes('info.scanPromise'),
  'phone attestation should start or await the lazy scan only after the user advances'
);

assert(
  pairPage.includes('advanceChallenge') && pairPage.includes('void pair();'),
  'phone page should keep the dialpad as the user-visible pre-scan gate'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('phone-scan-lazy: ok');
