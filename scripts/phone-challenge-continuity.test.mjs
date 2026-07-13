#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src/phone-main.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`phone-challenge-continuity: ${message}`);
    process.exitCode = 1;
  }
}

const backgroundState =
  source.match(/function setBackgroundState[\s\S]*?\n}\n\nasync function bootstrap/)?.[0] ?? '';
const bootstrap = source.match(/async function bootstrap[\s\S]*?\n}\n\nfunction maybeStartFastPass/)?.[0] ?? '';
const advanceChallenge =
  source.match(/function advanceChallenge[\s\S]*?\n}\n\nasync function pair/)?.[0] ?? '';

assert(
  backgroundState.includes("root.querySelector('.bio-draw')") &&
    backgroundState.includes('if (!preserveActiveChallenge) render()'),
  'background readiness updates must preserve an active drawing canvas'
);
assert(
  bootstrap.includes('setBackgroundState({ trustChecked: true })') &&
    bootstrap.includes('setBackgroundState({\n        hasTrust: Boolean(trustToken),'),
  'trust completion and timeout must not repaint the active challenge'
);
assert(
  /if \(!state\.startedInChallenge\) \{\s*state\.phase = 'ready';\s*render\(\);\s*}/s.test(
    bootstrap
  ),
  'desktop-ready should render only when no challenge is already on screen'
);
const signalDone = advanceChallenge.indexOf('signalChallengeComplete()');
const showVerified = advanceChallenge.indexOf("setState({ phase: 'paired', status: 'done' })");
const attemptClose = advanceChallenge.indexOf('window.close();');
assert(
  signalDone >= 0 && showVerified > signalDone && attemptClose > showVerified,
  'DONE must show Verified before attempting a close that iOS may refuse'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('phone-challenge-continuity: ok');
