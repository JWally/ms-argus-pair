#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`sso-demo-ux: ${message}`);
    process.exitCode = 1;
  }
}

const validate = read('src/pages/MerchantValidate.tsx');
const valkey = read('cdk/lib/valkey-client.ts');

assert(validate.includes('nameInput'), 'merchant validate page should capture a demo name');
assert(
  validate.includes('submitSsoClaim'),
  'merchant validate page should submit names to backend claim gate'
);
assert(
  validate.includes('proof required') &&
    validate.includes('Use passkey') &&
    validate.includes('Create passkey') &&
    validate.includes('Continue with Google'),
  'merchant validate page should gate SSO validation behind proof buttons'
);
assert(validate.includes('Your name'), 'merchant validate page should expose a clear name field');
assert(
  validate.includes('VERIFIED') && validate.includes('NOT VERIFIED'),
  'merchant validate page should show explicit validity state'
);
assert(validate.includes('DONE'), 'merchant validate page should offer a bottom DONE action');
assert(
  valkey.includes('return tonumber(ARGV[1]) + 1'),
  'Valkey rate limiter should return an over-cap value once the cap is reached'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('sso-demo-ux: ok');
