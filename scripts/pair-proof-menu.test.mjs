#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairPage = fs.readFileSync(path.join(root, 'src/pages/Pair.tsx'), 'utf8');
const phoneEntry = fs.readFileSync(path.join(root, 'src/phone-main.tsx'), 'utf8');
const pairLib = fs.readFileSync(path.join(root, 'src/lib/pair.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`pair-proof-menu: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  pairPage.includes('runOAuthProofOfLife') &&
    pairPage.includes('PROVIDERS_CONFIGURED') &&
    pairPage.includes('isOAuthError'),
  'Pair page should wire Google OAuth proof-of-life helpers'
);

assert(
  pairPage.includes('hasPasskeyHint') && pairPage.includes('clearPasskeyHint'),
  'Pair page should restore passkey hint handling for the proof menu'
);

assert(
  pairPage.includes("type ProofChoice = 'passkey' | 'google'"),
  'Pair page should model one passkey choice plus Google'
);

assert(
  pairPage.includes("mode: proofMode === 'google' ? 'oauth' : passkeyMode") &&
    phoneEntry.includes("mode: proofMode === 'google' ? 'oauth' : passkeyMode"),
  'submitPhoneAttestation should receive oauth or internally selected passkey mode'
);

assert(
  pairPage.includes("runOAuthProofOfLife('google', info.nonce)"),
  'Google menu action should bind OAuth proof to the pair nonce'
);

assert(
  pairPage.includes("setPhase('ready');") &&
    !pairPage.includes("setPhase(hasTrust ? 'returning' : 'pairing');\n    void pair();"),
  'fresh phones should land on the proof menu instead of auto-creating a passkey after dialpad'
);

assert(
  pairLib.includes("mode?: 'passkey-create' | 'passkey-auth' | 'oauth'"),
  'phone attestation API should keep explicit proof modes'
);

assert(
  pairPage.includes("pair('passkey')") &&
    !pairPage.includes("pair('passkey-auth')") &&
    !pairPage.includes("pair('passkey-create')") &&
    phoneEntry.includes("pair('passkey')") &&
    !phoneEntry.includes("pair('passkey-auth')") &&
    !phoneEntry.includes("pair('passkey-create')"),
  'Phone UIs should render exactly one passkey action'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-proof-menu: ok');
