#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// The desktop must not flip to Verified while the phone user is still mid-
// drawing-challenge. Verification runs in the background as before; only the
// REVEAL is gated: phone-here announces challenge:true, the desktop holds a
// `paired` verdict, and the phone's `phone-done` message releases it. These
// two sides live in different files and silently break apart — keep the
// message kinds and the release paths coupled.
const root = process.cwd();
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const phoneEntry = fs.readFileSync(path.join(root, 'src/phone-main.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`verdict-reveal-gate: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  pairLib.includes("{ kind: 'phone-here', challenge: opts.challenge === true }"),
  'phone-here should carry the challenge flag that arms the desktop reveal gate'
);

assert(
  phoneEntry.includes('challenge: state.startedInChallenge'),
  'phone entry should announce challenge mode when it starts in the bio-draw'
);

assert(
  pairLib.includes("v.verdict === 'paired' && phoneInChallenge && !phoneDone"),
  'desktop should hold only paired verdicts, and only while the challenge is unfinished'
);

assert(
  pairLib.includes("data.kind === 'phone-done'") && pairLib.includes('releaseHeldVerdict()'),
  'desktop should release the held verdict on the phone-done message'
);

assert(
  pairLib.includes("{ kind: 'phone-done' }"),
  'signalChallengeDone should send the phone-done peer message the desktop listens for'
);

// Every hold needs a bounded escape: the DONE tap, challenge dismissal,
// pagehide, the hold cap, and the session-expiry timer.
assert(
  pairLib.includes('window.setTimeout(releaseHeldVerdict, 90_000)'),
  'a held verdict must be capped so a vanished phone cannot wedge the desktop'
);

const signalCallCount = phoneEntry.split('signalChallengeComplete()').length - 1;
assert(
  signalCallCount >= 3,
  'phone entry should signal completion on DONE tap, challenge dismissal, and pagehide'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('verdict-reveal-gate: ok');
