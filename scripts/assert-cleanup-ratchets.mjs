import { readFileSync } from 'node:fs';

const ratchets = [
  {
    file: 'cdk/lib/pair-api.ts',
    maxLines: 1335,
    why: 'keep the pair API route from absorbing extracted feature-slice helpers',
  },
  {
    file: 'cdk/lib/pair-api/session-start.ts',
    maxLines: 116,
    why: 'keep the session-start application flow independent from AWS and route multiplexing',
  },
  {
    file: 'cdk/lib/pair-api/session-start-store.ts',
    maxLines: 92,
    why: 'keep session-start persistence separate from request policy and response shaping',
  },
  {
    file: 'cdk/lib/pair-api/merchant-projection.ts',
    maxLines: 39,
    why: 'keep the current merchant projection model explicit and transport-free',
  },
  {
    file: 'cdk/lib/pair-api/projection-contract.ts',
    maxLines: 91,
    why: 'keep API wire validation separate from projection policy and transport',
  },
  {
    file: 'cdk/lib/pair-api/projection-client.ts',
    maxLines: 125,
    why: 'keep the merchant HTTP adapter narrow and dependency-injectable',
  },
  {
    file: 'cdk/lib/pair-api/projection-verdict.ts',
    maxLines: 334,
    why: 'keep projection policy from absorbing transport and wire validation',
  },
  {
    file: 'cdk/lib/oauth-providers.ts',
    maxLines: 161,
    why: 'keep retired OAuth provider scaffolding out of the server trust boundary',
  },
  {
    file: 'src/lib/oauth.ts',
    maxLines: 172,
    why: 'keep retired OAuth provider scaffolding out of the browser bundle',
  },
  {
    file: 'cdk/lib/pair-api/sso-approval-route.ts',
    maxLines: 100,
    why: 'keep one-time SSO redemption as a narrow, reviewable trust boundary',
  },
];

function lineCount(file) {
  const body = readFileSync(file, 'utf8');
  return (body.match(/\n/g) ?? []).length + (body.endsWith('\n') ? 0 : 1);
}

let failed = false;
for (const ratchet of ratchets) {
  const lines = lineCount(ratchet.file);
  if (lines > ratchet.maxLines) {
    console.error(
      `[cleanup-ratchets] ${ratchet.file} has ${lines} lines; max is ${ratchet.maxLines} (${ratchet.why})`
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('[cleanup-ratchets] ok');
