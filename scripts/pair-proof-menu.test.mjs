#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairPage = fs.readFileSync(path.join(root, 'src/pages/Pair.tsx'), 'utf8');
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
  pairPage.includes("type ProofChoice = 'passkey-auth' | 'passkey-create' | 'google'"),
  'Pair page should model explicit proof choices'
);

assert(
  pairPage.includes("mode: proofMode === 'google' ? 'oauth' : proofMode"),
  'submitPhoneAttestation should receive explicit passkey/oauth modes from the menu'
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

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-proof-menu: ok');
