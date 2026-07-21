import { readFileSync } from 'node:fs';

const ratchets = [
  {
    file: 'cdk/lib/pair-api.ts',
    maxLines: 1146,
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
    file: 'src/lib/pair.ts',
    maxLines: 1367,
    why: 'keep desktop workflow state moving into named, tested client modules',
  },
  {
    file: 'src/lib/desktop-verdict-gate.ts',
    maxLines: 153,
    why: 'keep verdict reveal timing independent from transport and page orchestration',
  },
  {
    file: 'cdk/lib/pair-api/sso-start.ts',
    maxLines: 77,
    why: 'keep SSO start policy independent from AWS and API Gateway response shaping',
  },
  {
    file: 'cdk/lib/pair-api/sso-challenge.ts',
    maxLines: 84,
    why: 'keep SSO challenge policy independent from AWS and API Gateway response shaping',
  },
  {
    file: 'cdk/lib/pair-api/sso-challenge-store.ts',
    maxLines: 22,
    why: 'keep SSO challenge persistence as a narrow DynamoDB adapter',
  },
  {
    file: 'cdk/lib/pair-api/sso-validation.ts',
    maxLines: 168,
    why: 'keep SSO validation orchestration independent from AWS and API Gateway responses',
  },
  {
    file: 'cdk/lib/pair-api/sso-validation-proof.ts',
    maxLines: 102,
    why: 'keep SSO proof policy isolated from continuity and persistence',
  },
  {
    file: 'cdk/lib/pair-api/sso-validation-store.ts',
    maxLines: 36,
    why: 'keep SSO validation persistence as a narrow DynamoDB adapter',
  },
  {
    file: 'cdk/lib/pair-api/sso-session.ts',
    maxLines: 25,
    why: 'keep shared SSO session state explicit and free of route implementation',
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
