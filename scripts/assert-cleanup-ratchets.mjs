import { readFileSync } from 'node:fs';

const ratchets = [
  {
    file: 'cdk/lib/pair-api.ts',
    maxLines: 1387,
    why: 'keep the pair API route from absorbing extracted feature-slice helpers',
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
