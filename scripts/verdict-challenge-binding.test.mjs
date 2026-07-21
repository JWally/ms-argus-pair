import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [api, desktopRoute, sessionStart, verifyRoute, store, pair, embed, loader, readme] =
  await Promise.all([
    read('cdk/lib/pair-api.ts'),
    read('cdk/lib/pair-api/desktop-attestation-route.ts'),
    read('cdk/lib/pair-api/session-start.ts'),
    read('cdk/lib/pair-api/verdict-verification-route.ts'),
    read('cdk/lib/session-store.ts'),
    read('src/lib/pair.ts'),
    read('src/pages/Embed.tsx'),
    read('loader/loader.ts'),
    read('README.md'),
  ]);

assert.match(sessionStart, /parseMerchantChallenge\(body\.challengeId\)/);
assert.match(sessionStart, /challengeId/);
assert.match(api, /createDesktopAttestationHandler/);
assert.match(desktopRoute, /challengeId: session\.challengeId/);
assert.match(desktopRoute, /nonce: session\.nonce/);
assert.match(verifyRoute, /verifyVerdictForContext/);
assert.match(verifyRoute, /missing_challenge_id/);
assert.match(store, /challengeId: string/);
assert.match(pair, /challengeId\?: string/);
assert.match(loader, /getAttribute\('data-challenge-id'\)/);
assert.match(loader, /opts\.challengeId/);
assert.match(loader, /&challengeId=/);
assert.match(embed, /challengeId/);
assert.match(embed, /Missing or invalid merchant challenge/);
assert.match(readme, /merchant backend/i);
assert.match(readme, /challengeId/);

console.log('verdict-challenge-binding: ok');
