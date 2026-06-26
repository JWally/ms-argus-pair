#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const api = fs.readFileSync(path.join(root, 'cdk/lib/pair-api.ts'), 'utf8');
const stack = fs.readFileSync(path.join(root, 'cdk/lib/pair-stack.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`hosted-verify-api-contract: ${message}`);
    process.exitCode = 1;
  }
}

for (const route of [
  'POST /api/hosted/start',
  'POST /api/hosted/{id}/merchant-attest',
  'POST /api/hosted/{id}/hosted-attest',
  'POST /api/hosted/redeem',
]) {
  assert(api.includes(`case '${route}'`), `handler missing ${route}`);
}

for (const pathName of [
  '/api/hosted/start',
  '/api/hosted/{id}/merchant-attest',
  '/api/hosted/{id}/hosted-attest',
  '/api/hosted/redeem',
]) {
  assert(stack.includes(`path: '${pathName}'`), `CDK route missing ${pathName}`);
}

assert(api.includes('HOSTED#'), 'hosted sessions should be stored under a separate PK prefix');
assert(api.includes('HOSTED_CODE#'), 'hosted callback codes should be stored under a separate PK prefix');
assert(api.includes('attribute_not_exists(redeemedAt)'), 'redeem should be one-shot');
assert(api.includes('validateHostedVerifyReturnUrl'), 'hosted start should validate merchant return URLs');
assert(api.includes('buildHostedVerifyCallbackUrl'), 'hosted attest should return code+state callback URLs');

if (process.exitCode) process.exit(process.exitCode);
console.log('hosted-verify-api-contract: ok');
