#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairPage = fs.readFileSync(path.join(root, 'src/pages/Pair.tsx'), 'utf8');
const phoneEntry = fs.readFileSync(path.join(root, 'src/phone-main.tsx'), 'utf8');
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');
const pairApi = fs.readFileSync(path.join(root, 'cdk/lib/pair-api.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`pair-proof-menu: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  pairPage.includes('runGoogleProofOfLife') &&
    pairPage.includes('PROVIDERS_CONFIGURED') &&
    pairPage.includes('isOAuthError'),
  'Pair page should wire Google OAuth proof-of-life helpers'
);

assert(
  pairPage.includes('infoRef.current.freshProofRequired') &&
    phoneEntry.includes('state.info.freshProofRequired') &&
    pairLib.includes('info.freshProofRequired ? null : await loadTrustToken()') &&
    pairApi.includes('s.freshProofRequired && deviceTrustToken'),
  'forceauth should bypass cached trust in both phone UIs and reject it on the server'
);

assert(
  pairPage.includes('clearPasskeyHint'),
  'Pair page should clear stale passkey hints when the server rejects a credential'
);

assert(
  pairPage.includes("type ProofChoice = 'integrity' | 'passkey' | 'passkey-create' | 'google'"),
  'Pair page should model integrity-only, passkey use, passkey create, and Google'
);

assert(
  pairPage.includes(
    "const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth'"
  ) &&
    phoneEntry.includes(
      "const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth'"
    ) &&
    pairPage.includes("proofMode === 'integrity'") &&
    phoneEntry.includes("proofMode === 'integrity'") &&
    pairPage.includes("void pair('integrity')") &&
    phoneEntry.includes("void pair('integrity', { keepDialpad: true })"),
  'integrity-only sessions should submit without opening a passkey or OAuth ceremony'
);

assert(
  pairPage.includes('runGoogleProofOfLife(info.nonce)'),
  'Google menu action should bind OAuth proof to the pair nonce'
);

assert(
  pairPage.includes("setPhase('ready');") &&
    !pairPage.includes("setPhase(hasTrust ? 'returning' : 'pairing');\n    void pair();"),
  'fresh phones should land on the proof menu instead of auto-creating a passkey after dialpad'
);

assert(
  pairLib.includes("mode?: 'integrity' | 'passkey-create' | 'passkey-auth' | 'oauth'"),
  'phone attestation API should keep explicit proof modes'
);

assert(
  pairPage.includes("pair('passkey')") &&
    pairPage.includes("pair('passkey-create')") &&
    !pairPage.includes("pair('passkey-auth')") &&
    phoneEntry.includes("pair('passkey')") &&
    phoneEntry.includes("pair('passkey-create')") &&
    !phoneEntry.includes("pair('passkey-auth')"),
  'Phone UIs should render passkey use and explicit passkey creation actions'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-proof-menu: ok');
