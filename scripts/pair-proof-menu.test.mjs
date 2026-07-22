#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const phoneEntry = fs.readFileSync(path.join(root, 'src/phone-main.tsx'), 'utf8');
const pairFailure = fs.readFileSync(path.join(root, 'src/lib/phone-pair-failure.ts'), 'utf8');
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const pairApi = fs.readFileSync(path.join(root, 'cdk/lib/pair-api.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`pair-proof-menu: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  phoneEntry.includes('runGoogleProofOfLife') &&
    phoneEntry.includes('PROVIDERS_CONFIGURED') &&
    phoneEntry.includes('isOAuthError'),
  'the canonical phone entry should wire Google OAuth proof-of-life helpers'
);

assert(
  phoneEntry.includes('state.info.freshProofRequired') &&
    pairLib.includes('info.freshProofRequired ? null : await loadTrustToken()') &&
    pairApi.includes('s.freshProofRequired && deviceTrustToken'),
  'forceauth should bypass cached trust in the phone UI and reject it on the server'
);

assert(
  phoneEntry.includes('clearPasskeyHint'),
  'the phone entry should clear stale passkey hints when the server rejects a credential'
);

assert(
  phoneEntry.includes('type ProofChoice = PhoneProofMode') &&
    pairFailure.includes("'integrity' | 'passkey' | 'passkey-create' | 'google'"),
  'the phone entry should model integrity-only, passkey use, passkey create, and Google'
);

assert(
  phoneEntry.includes(
    "const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth'"
  ) &&
    phoneEntry.includes("proofMode === 'integrity'") &&
    phoneEntry.includes("void pair('integrity', { keepDrawingBoard: true })"),
  'integrity-only sessions should submit without opening a passkey or OAuth ceremony'
);

assert(
  phoneEntry.includes('runGoogleProofOfLife(state.info.nonce)'),
  'Google menu action should bind OAuth proof to the pair nonce'
);

assert(
  phoneEntry.includes("state.phase = 'ready';") &&
    !phoneEntry.includes(
      "state.phase = state.hasTrust ? 'returning' : 'pairing';\n    void pair();"
    ),
  'fresh phones should land on the proof menu instead of auto-creating a passkey after drawing'
);

assert(
  pairLib.includes("mode?: 'integrity' | 'passkey-create' | 'passkey-auth' | 'oauth'"),
  'phone attestation API should keep explicit proof modes'
);

assert(
  phoneEntry.includes("pair('passkey')") &&
    phoneEntry.includes("pair('passkey-create')") &&
    !phoneEntry.includes("pair('passkey-auth')"),
  'the phone UI should render passkey use and explicit passkey creation actions'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-proof-menu: ok');
