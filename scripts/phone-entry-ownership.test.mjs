#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(file) {
  return readFileSync(join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`phone-entry-ownership: ${message}`);
    process.exitCode = 1;
  }
}

const main = read('src/main.tsx');
const phone = read('src/phone-main.tsx');
const drawingBoard = read('src/lib/phone-drawing-board.ts');
const styles = read('src/index.css');

for (const obsoleteFile of [
  'src/pages/Pair.tsx',
  'src/pages/PairScreens.tsx',
  'src/components/Dialpad.tsx',
]) {
  assert(!existsSync(join(root, obsoleteFile)), `${obsoleteFile} must stay deleted`);
}

assert(
  !main.includes("import('./pages/Pair')") && !main.includes('path="/pair/:roomId"'),
  'the React SPA must not own a fallback phone route'
);
assert(
  phone.includes('function renderBioDraw') &&
    phone.includes('mountPhoneDrawingBoard') &&
    drawingBoard.includes('const DRAW_LETTERS') &&
    drawingBoard.includes('bio-draw-canvas'),
  'phone-main.tsx must retain the canonical letter-drawing challenge'
);
assert(!phone.includes('keepDialpad'), 'drawing-challenge state must not retain dialpad naming');
assert(!styles.includes('.dialer-'), 'the shared stylesheet must not retain numeric dialer UI');

if (process.exitCode) process.exit(process.exitCode);
console.log('phone-entry-ownership: ok');
