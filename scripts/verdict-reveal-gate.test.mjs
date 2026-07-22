#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// The desktop must not reveal pass or fail while the phone user is still mid-
// drawing-challenge. Verification runs in the background as before; only the
// REVEAL is gated: phone-here announces challenge:true, the desktop holds the
// verdict, and the phone's `phone-done` message releases it. These two sides
// live in different files and silently break apart — keep the message kinds
// and the release paths coupled.
const root = process.cwd();
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const desktopRuntime = fs.readFileSync(
  path.join(root, 'src/lib/desktop-session-runtime.ts'),
  'utf8'
);
const resultPoll = fs.readFileSync(path.join(root, 'src/lib/desktop-result-poll.ts'), 'utf8');
const verdictGate = fs.readFileSync(path.join(root, 'src/lib/desktop-verdict-gate.ts'), 'utf8');
const phoneEntry = fs.readFileSync(path.join(root, 'src/phone-main.tsx'), 'utf8');
const pairApi = fs.readFileSync(path.join(root, 'cdk/lib/pair-api.ts'), 'utf8');
const phoneAttestationRoute = fs.readFileSync(
  path.join(root, 'cdk/lib/pair-api/phone-attestation-route.ts'),
  'utf8'
);
const verdictPush = fs.readFileSync(path.join(root, 'cdk/lib/pair-api/verdict-push.ts'), 'utf8');
const verdictDisclosure = fs.readFileSync(
  path.join(root, 'cdk/lib/pair-api/verdict-disclosure.ts'),
  'utf8'
);
const wsHandler = fs.readFileSync(path.join(root, 'cdk/lib/ws-handler.ts'), 'utf8');

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
  desktopRuntime.includes('this.gate.notePhoneChallenge') &&
    verdictGate.includes('if (this.phoneInChallenge && !this.phoneDone)') &&
    !verdictGate.includes("verdict.verdict === 'paired'"),
  'desktop should hold every verdict while the challenge is unfinished'
);

assert(
  desktopRuntime.includes("case 'phone-done'") &&
    desktopRuntime.includes('this.gate.releaseHeldVerdict()'),
  'desktop should release the held verdict on the phone-done message'
);

assert(
  pairLib.includes("{ kind: 'phone-done' }"),
  'signalChallengeDone should send the phone-done peer message the desktop listens for'
);

// Every hold needs a bounded escape: the DONE tap, challenge dismissal,
// pagehide, the hold cap, and the session-expiry timer.
assert(
  verdictGate.includes('const VERDICT_HOLD_CAP_MS = 90_000') &&
    verdictGate.includes('this.releaseHeldVerdict'),
  'a held verdict must be capped so a vanished phone cannot wedge the desktop'
);

assert(
  desktopRuntime.includes('const CONNECTED_POLL_DELAY_MS = 20_000') &&
    desktopRuntime.includes('void this.poll.start(0)') &&
    desktopRuntime.includes('this.clearFallbackTimer()') &&
    resultPoll.includes('gate.receiveSealedVerdict') &&
    resultPoll.includes('response.status !== 204'),
  'the delayed authenticated result fallback should stay behind its tested poll boundary'
);

const signalCallCount = phoneEntry.split('signalChallengeComplete()').length - 1;
assert(
  signalCallCount >= 3,
  'phone entry should signal completion on DONE tap, challenge dismissal, and pagehide'
);

assert(
  verdictPush.includes("kind: 'verdict-sealed'") &&
    verdictPush.includes("kind: 'verdict-release'") &&
    !verdictPush.includes('verdict: args.verdict'),
  'the server push must deliver fixed ciphertext first and the reveal key separately'
);

assert(
  phoneAttestationRoute.includes("verdict: 'complete'") &&
    verdictDisclosure.includes('phoneState: sealed.phoneEnvelope') &&
    verdictDisclosure.includes("status: 'sealed'") &&
    verdictDisclosure.includes('shouldReleaseVerdict(sealed.revealState') &&
    !pairApi.includes('return jsonResp(200, { verdict, reason, annotations, nextDeviceTrust })') &&
    !phoneAttestationRoute.includes(
      'return jsonResp(200, { verdict, reason, annotations, nextDeviceTrust })'
    ),
  'phone-attest, result, and verdict-token endpoints must not expose plaintext before release'
);

assert(
  wsHandler.includes("me.role !== 'phone'") &&
    wsHandler.includes("dataKind !== 'phone-done'") &&
    wsHandler.includes('await markPhoneDone') &&
    wsHandler.includes("kind: 'verdict-release'"),
  'only the authenticated phone-done relay should trigger the live reveal-key message'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('verdict-reveal-gate: ok');
