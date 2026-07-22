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
const ssoClient = read('src/lib/sso-client.ts');
const stack = read('cdk/lib/pair-stack.ts');
const api = read('cdk/lib/pair-api.ts');
const router = read('cdk/lib/pair-api/router.ts');
const ssoScan = read('cdk/lib/pair-api/sso-scan.ts');
const ssoStart = read('cdk/lib/pair-api/sso-start.ts');
const ssoChallenge = read('cdk/lib/pair-api/sso-challenge.ts');
const ssoValidation = read('cdk/lib/pair-api/sso-validation.ts');
const ssoApproval = read('cdk/lib/pair-api/sso-approval.ts');
const verifyRoute = read('cdk/lib/pair-api/verdict-verification-route.ts');

for (const route of [
  '/merchant',
  '/sso/mobile',
  '/sso/challenge/:sessionId',
  '/merchant/validate',
]) {
  assert(main.includes(`path="${route}"`), `missing SPA route ${route}`);
}

for (const endpoint of [
  '/api/sso/start',
  '/api/sso/{id}/challenge',
  '/api/sso/{id}/validate',
  '/api/sso/approval/redeem',
  '/api/sso/approval/exchange',
]) {
  assert(stack.includes(`path: '${endpoint}'`), `missing CDK HTTP route ${endpoint}`);
}

for (const routeKey of [
  'POST /api/sso/start',
  'POST /api/sso/{id}/challenge',
  'POST /api/sso/{id}/validate',
  'POST /api/sso/approval/redeem',
  'POST /api/sso/approval/exchange',
]) {
  assert(router.includes(`'${routeKey}'`), `missing Lambda handler for ${routeKey}`);
}

assert(ssoScan.includes('sso_requires_phone'), 'SSO API must reject non-phone scans');
assert(ssoScan.includes('scan?.isPhone === true'), 'SSO API must require phone-classified scans');
assert(
  ssoStart.includes('parseScopedCpi(body.cpi)') &&
    ssoStart.includes('proofRequired') &&
    ssoStart.includes('freshProofRequired'),
  'SSO start must snapshot the server-resolved scoped CPI policy'
);
assert(
  api.includes('challengeSsoSessionRequest') &&
    ssoChallenge.includes('requirePhoneSsoScan') &&
    ssoChallenge.includes('storeChallenge'),
  'SSO challenge must stay behind its tested application boundary'
);
assert(
  api.includes('validateSsoSessionRequest') &&
    ssoValidation.includes('readReturnCode') &&
    ssoValidation.includes('verifyProof') &&
    ssoValidation.includes('storeValidation'),
  'SSO validation must stay behind its tested application boundary'
);
assert(
  verifyRoute.includes("error: 'missing_cpi'") &&
    verifyRoute.includes('verifyVerdictForContext') &&
    !verifyRoute.includes('verifyVerdictToken'),
  'verdict verification must require an exact merchant CPI assertion'
);
assert(
  ssoApproval.includes('cpi_mismatch') && ssoClient.includes('expectedCpi'),
  'one-time SSO approval redemption must require the merchant expected CPI'
);
assert(
  ssoClient.includes("| 'integrity-only'") && ssoClient.includes('freshProofRequired'),
  'SSO clients must support integrity-only and forceauth policy behavior'
);

for (const clientFn of [
  'startSsoSession',
  'submitSsoChallenge',
  'validateSsoReturn',
  'redeemSsoApproval',
]) {
  assert(
    ssoClient.includes(`export const ${clientFn}`),
    `missing client function ${clientFn}`
  );
}

assert(!stack.includes("path: '/api/sso/{id}/claim'"), 'retired SSO claim route should be removed');
assert(
  !router.includes("'POST /api/sso/{id}/claim'"),
  'retired SSO claim handler should be removed'
);
assert(!ssoClient.includes('submitSsoClaim'), 'retired SSO claim client should be removed');

if (process.exitCode) process.exit(process.exitCode);
console.log('sso-routes: ok');
