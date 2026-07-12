#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`sso-routes: ${message}`);
    process.exitCode = 1;
  }
}

const main = read('src/main.tsx');
const pairLib = read('src/lib/pair.ts');
const stack = read('cdk/lib/pair-stack.ts');
const api = read('cdk/lib/pair-api.ts');
const ssoScan = read('cdk/lib/pair-api/sso-scan.ts');

for (const route of ['/merchant', '/sso/challenge/:sessionId', '/merchant/validate']) {
  assert(main.includes(`path="${route}"`), `missing SPA route ${route}`);
}

for (const endpoint of [
  '/api/sso/start',
  '/api/sso/{id}/challenge',
  '/api/sso/{id}/validate',
  '/api/sso/approval/redeem',
]) {
  assert(stack.includes(`path: '${endpoint}'`), `missing CDK HTTP route ${endpoint}`);
}

for (const routeKey of [
  'POST /api/sso/start',
  'POST /api/sso/{id}/challenge',
  'POST /api/sso/{id}/validate',
  'POST /api/sso/approval/redeem',
]) {
  assert(api.includes(`case '${routeKey}'`), `missing Lambda handler for ${routeKey}`);
}

assert(ssoScan.includes('sso_requires_phone'), 'SSO API must reject non-phone scans');
assert(ssoScan.includes('scan?.isPhone === true'), 'SSO API must require phone-classified scans');

for (const clientFn of [
  'startSsoSession',
  'submitSsoChallenge',
  'validateSsoReturn',
  'redeemSsoApproval',
]) {
  assert(
    pairLib.includes(`export async function ${clientFn}`),
    `missing client function ${clientFn}`
  );
}

assert(!stack.includes("path: '/api/sso/{id}/claim'"), 'retired SSO claim route should be removed');
assert(
  !api.includes("case 'POST /api/sso/{id}/claim'"),
  'retired SSO claim handler should be removed'
);
assert(!pairLib.includes('submitSsoClaim'), 'retired SSO claim client should be removed');

if (process.exitCode) process.exit(process.exitCode);
console.log('sso-routes: ok');
