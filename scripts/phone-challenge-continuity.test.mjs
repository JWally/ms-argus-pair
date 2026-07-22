#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src/phone-main.tsx'), 'utf8');
const drawingBoard = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/phone-drawing-board.ts'),
  'utf8'
);

function assert(condition, message) {
  if (!condition) {
    console.error(`phone-challenge-continuity: ${message}`);
    process.exitCode = 1;
  }
}

const backgroundState =
  source.match(/function setBackgroundState[\s\S]*?\n}\n\nasync function bootstrap/)?.[0] ?? '';
const bootstrap =
  source.match(/async function bootstrap[\s\S]*?\n}\n\nfunction maybeStartFastPass/)?.[0] ?? '';
const advanceChallenge =
  source.match(/function advanceChallenge[\s\S]*?\n}\n\nasync function pair/)?.[0] ?? '';
const pair =
  source.match(/async function pair[\s\S]*?\n}\n\nasync function loadOAuthModule/)?.[0] ?? '';
const updateActionLabel = source.match(/function updateBioDrawActionLabel[\s\S]*?\n}/)?.[0] ?? '';
const finalizePhoneState =
  source.match(/async function finalizePhoneStateAndClose[\s\S]*?\n}/)?.[0] ?? '';

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
assert(
  advanceChallenge.includes('if (state.verdict)') &&
    !advanceChallenge.includes("state.verdict === 'paired'"),
  'DONE must finish the phone flow for either server verdict without revealing the decision'
);
assert(
  /if \(options\.keepDrawingBoard\) \{\s*\/\/ Background verdict calculation[\s\S]*?state\.verdict = result\.verdict;[\s\S]*?state\.phase = 'challenge';[\s\S]*?updateBioDrawActionLabel\(\);[\s\S]*?return;\s*}/s.test(
    pair
  ),
  'a background verdict must stay behind the drawing challenge until DONE'
);
assert(
  updateActionLabel.includes('drawingBoard?.setDone(Boolean(state.verdict))') &&
    drawingBoard.includes("isDone ? 'DONE' : 'Next'") &&
    !drawingBoard.includes("isDone === 'paired'"),
  'either terminal verdict must expose the same neutral DONE action on the phone'
);
assert(
  advanceChallenge.indexOf('signalChallengeComplete()') <
    advanceChallenge.indexOf('finalizePhoneStateAndClose()') &&
    finalizePhoneState.indexOf('state.finalizeAfterDone()') <
      finalizePhoneState.indexOf('window.close()'),
  'DONE must release and persist sealed phone state before attempting to close'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('phone-challenge-continuity: ok');
