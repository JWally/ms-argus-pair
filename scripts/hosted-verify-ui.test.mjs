#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const main = fs.readFileSync(path.join(root, 'src/main.tsx'), 'utf8');
const demo = fs.readFileSync(path.join(root, 'src/pages/Demo.tsx'), 'utf8');
const hosted = fs.readFileSync(path.join(root, 'src/lib/hosted.ts'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'src/pages/HostedVerify.tsx'), 'utf8');
const callback = fs.readFileSync(path.join(root, 'src/pages/HostedCallback.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`hosted-verify-ui: ${message}`);
    process.exitCode = 1;
  }
}

assert(main.includes('path="/verify/:hostedSessionId"'), 'SPA should route hosted verify page');
assert(main.includes('path="/hosted/callback"'), 'SPA should route hosted callback page');
assert(demo.includes('Try mobile redirect'), 'demo should expose hosted redirect CTA');
assert(
  demo.includes('submitHostedMerchantLeg(start)'),
  'demo should submit merchant leg before redirect'
);
assert(hosted.includes("role: 'merchant'"), 'merchant leg should use merchant attestation role');
assert(hosted.includes("role: 'hosted'"), 'hosted leg should use hosted attestation role');
assert(verify.includes('runHostedChallenge'), 'hosted page should submit hosted attestation');
assert(callback.includes('redeemHostedCode'), 'callback page should redeem one-shot code');

if (process.exitCode) process.exit(process.exitCode);
console.log('hosted-verify-ui: ok');
