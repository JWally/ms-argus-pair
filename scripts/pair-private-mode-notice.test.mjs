#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairPage = fs.readFileSync(path.join(root, 'src/pages/Pair.tsx'), 'utf8');
const deviceTrust = fs.readFileSync(path.join(root, 'src/lib/device-trust.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`pair-private-mode-notice: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  deviceTrust.includes('detectPrivateStorageMode'),
  'device-trust should expose a storage/private-mode probe'
);

assert(
  pairPage.includes('privateModeLikely') && pairPage.includes('detectPrivateStorageMode'),
  'Pair page should read the private-mode probe'
);

assert(
  pairPage.includes('Private browsing does not remember this check.'),
  'Pair page should explain why proof repeats in private browsing'
);

assert(
  pairPage.includes('Use a normal tab to skip it next time.'),
  'Private-mode notice should summarize the normal-mode benefit tightly'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-private-mode-notice: ok');
