import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [embed, loader, css] = await Promise.all([
  read('src/pages/Embed.tsx'),
  read('loader/loader.ts'),
  read('src/pages/embed.css'),
]);

assert.match(embed, /className="ax-sso"/);
assert.match(embed, /\/sso\/mobile\?/);
assert.match(embed, /VITE_PAIR_URL_BASE/);
assert.doesNotMatch(embed, /\/merchant\?/);
assert.match(embed, /cpi/);
assert.match(embed, /challengeId/);
assert.match(embed, /ssoReturnUrl/);
assert.match(embed, /target="_top"/);
assert.match(embed, />\s*MOBILE SSO/);
assert.match(loader, /ssoReturnUrl\?: string/);
assert.match(loader, /ssoReturnUrl/);
assert.match(loader, /data-sso-return-url/);
assert.match(css, /\.aegis \.ax-sso/);
assert.match(css, /\.aegis\.compact \.ax-sso[^}]*display: flex/s);

console.log('sso-widget-entry: ok');
