#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const phoneEntry = fs.readFileSync(path.join(root, 'src/phone-main.tsx'), 'utf8');
const phoneProofFlow = fs.readFileSync(path.join(root, 'src/lib/phone-proof-flow.ts'), 'utf8');
const pairFailure = fs.readFileSync(path.join(root, 'src/lib/phone-pair-failure.ts'), 'utf8');
const phoneAttestation = fs.readFileSync(path.join(root, 'src/lib/phone-attestation.ts'), 'utf8');
const phoneAttestationRequest = fs.readFileSync(
  path.join(root, 'cdk/lib/pair-api/phone-attestation-request.ts'),
  'utf8'
);

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
    phoneAttestation.includes(
      'request.info.freshProofRequired ? null : await deps.loadTrustToken()'
    ) &&
    phoneAttestationRequest.includes('session.freshProofRequired && deviceTrustToken'),
  'forceauth should bypass cached trust in the phone UI and reject it on the server'
);

assert(
  phoneEntry.includes('runPhoneProofFlow') &&
    phoneProofFlow.includes('export async function runPhoneProofFlow'),
  'the canonical phone entry should delegate proof policy to the tested phone-proof-flow boundary'
);

assert(
  phoneProofFlow.includes('pairOperations.clearPasskeyHint()'),
  'the proof flow should clear stale passkey hints when the server rejects a credential'
);

assert(
  phoneProofFlow.includes('proofMode?: PhoneProofMode') &&
    pairFailure.includes("'integrity' | 'passkey' | 'passkey-create' | 'google'"),
  'the proof flow should model integrity-only, passkey use, passkey create, and Google'
);

assert(
  phoneProofFlow.includes(
    "const passkeyMode = proofMode === 'passkey-create' ? 'passkey-create' : 'passkey-auth'"
  ) &&
    phoneProofFlow.includes("proofMode === 'integrity'") &&
    phoneEntry.includes("void pair('integrity', { keepDrawingBoard: true })"),
  'integrity-only sessions should submit without opening a passkey or OAuth ceremony'
);

assert(
  phoneProofFlow.includes('deps.runGoogleProof(info.nonce)'),
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
  phoneAttestation.includes("mode?: 'integrity' | 'passkey-create' | 'passkey-auth' | 'oauth'"),
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
