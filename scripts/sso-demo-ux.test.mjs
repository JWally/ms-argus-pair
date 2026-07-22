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

const merchant = read('src/pages/MerchantSso.tsx');
const challenge = read('src/pages/SsoChallenge.tsx');
const validate = read('src/pages/MerchantValidate.tsx');
const mobile = read('src/pages/MobileSso.tsx');
const ssoClient = read('src/lib/sso-client.ts');
const argusClient = read('src/lib/argus-client.ts');
const main = read('src/main.tsx');
const shell = read('src/components/SsoStatusShell.tsx');
const brand = read('src/components/Brand.tsx');
const ssoLegBody = ssoClient.match(/function runSsoLeg[\s\S]*?\n}\n\nfunction/)?.[0];

assert(
  !validate.includes('nameInput') && !validate.includes('submitSsoClaim'),
  'merchant validate page should not contain the retired game claim'
);
assert(
  validate.includes('proof required') &&
    validate.includes('Use passkey') &&
    validate.includes('Create passkey') &&
    validate.includes('Continue with Google'),
  'merchant validate page should gate SSO validation behind proof buttons'
);
assert(
  merchant.includes('Session is Valid') && merchant.includes("'approved'"),
  'final merchant page should show the exact approved session state'
);
assert(
  validate.includes('useNavigate') &&
    validate.includes("complete: '1'") &&
    validate.includes('cpi') &&
    validate.includes('replace: true'),
  'approved validation should automatically continue to approval-cookie redemption'
);
assert(
  validate.includes("endsWith('.fastpass')") &&
    validate.includes("mode: 'integrity-only'") &&
    validate.includes("endsWith('.forceauth')"),
  'merchant validation UI should honor fastpass and forceauth policy UX'
);
assert(
  merchant.includes('redeemSsoApproval(approvalSessionId, requestedCpi)') &&
    challenge.includes('submitSsoChallenge(sessionId, nonce, cpi)'),
  'every SSO browser leg should preserve the exact scoped CPI'
);
assert(
  !challenge.includes('<Dialpad') &&
    !challenge.includes('actionLabel="DONE"') &&
    challenge.includes('You will return automatically') &&
    merchant.includes('DONE'),
  'the hosted SSO scan should return automatically without a drawing gate'
);
assert(
  !challenge.includes('Session check failed') && !validate.includes('Session is Not Valid'),
  'Argus-hosted SSO pages should not disclose the merchant verdict'
);
assert(
  merchant.includes('merchant-page') && validate.includes('merchant-page'),
  'both merchant legs should use the daylight merchant theme'
);
assert(
  shell.includes('argus-page') && !challenge.includes('sso-route'),
  'the hosted Argus leg should stay dark and omit the redundant route map'
);
assert(
  !merchant.includes('sso-route') && !validate.includes('sso-route'),
  'merchant pages should omit the redundant route map'
);
assert(
  merchant.includes('https://www-dev-jw.argus.pw/captcha') &&
    merchant.includes('window.setTimeout') &&
    merchant.includes('3_000'),
  'approved merchant return should redirect to the captcha demo after three seconds'
);
assert(
  merchant.includes('merchant-done-flat') && merchant.includes('DONE'),
  'approved merchant return should also expose a flat DONE action'
);
assert(
  brand.includes('merchant-demo-badge') && brand.includes('DEMO'),
  'merchant SSO wordmark should identify the experience as a demo'
);
assert(
  merchant.includes('Try the SSO demo') &&
    merchant.includes('No account or sign-in is required') &&
    merchant.includes('Run demo'),
  'merchant entry should make clear that no real sign-in is required'
);
assert(
  main.includes("import('./pages/SsoRoutes')") &&
    main.includes('<SsoRoute page="mobile" />') &&
    main.includes('<SsoRoute page="challenge" />') &&
    main.includes('<SsoRoute page="validate" />'),
  'all hosted SSO stages should share one loaded route chunk'
);
assert(
  mobile.includes('<SsoStatusShell') &&
    challenge.includes('<SsoStatusShell') &&
    validate.includes('<SsoStatusShell'),
  'hosted SSO stages should keep one stable Argus presentation'
);
assert(
  challenge.includes('useNavigate') &&
    challenge.includes('navigate(challenge.returnUrl, { replace: true })') &&
    !challenge.includes('window.location.replace(challenge.returnUrl)'),
  'the same-origin challenge handoff should not reload the document'
);
assert(
  shell.includes('Secure session check') &&
    !merchant.includes('Merchant response') &&
    !challenge.includes('Return to merchant') &&
    !challenge.includes('return to the merchant') &&
    !mobile.includes('Return to merchant') &&
    !validate.includes('Returning to merchant') &&
    !validate.includes('Merchant response'),
  'customer-facing SSO copy should not call the destination a merchant'
);
assert(
  shell.includes('Step ${step} of 3') &&
    shell.includes('const countdown = 4 - step') &&
    shell.includes('{countdown}') &&
    shell.includes('sso-stage-value') &&
    shell.includes('sso-progress-step') &&
    !shell.includes('sso-stage-total') &&
    mobile.includes('step={1}') &&
    challenge.includes('step={2}') &&
    validate.includes('step={3}'),
  'the stable SSO shell should show progress tied to the three real protocol stages'
);
assert(
  !shell.includes('setInterval') && !shell.includes('setTimeout'),
  'SSO progress should follow completed stages instead of a fake timed countdown'
);
assert(
  ssoLegBody?.includes('deps.runAttestedScan') &&
    argusClient.includes('await waitForArgus()') &&
    !ssoLegBody.includes('window.argus'),
  'SSO scan legs must wait for the signed Argus SDK bootstrap before reading window.argus'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('sso-demo-ux: ok');
