import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [embed, loader, css] = await Promise.all([
  read('src/pages/Embed.tsx'),
  read('loader/loader.ts'),
  read('src/pages/embed.css'),
]);

assert.doesNotMatch(embed, /className="ax-sso"/);
assert.doesNotMatch(embed, /ssoReturnUrl/);
assert.doesNotMatch(embed, />\s*MOBILE SSO/);
assert.doesNotMatch(loader, /data-sso-return-url/);
assert.doesNotMatch(loader, /&ssoReturnUrl=/);
assert.match(loader, /function startMobileSso/);
assert.match(loader, /\/sso\/mobile/);
assert.match(loader, /returnUrl/);
assert.match(loader, /win\.argusCaptcha = \{ render, startMobileSso/);
assert.match(loader, /DEFAULT_WIDGET_MAX_WIDTH = '28rem'/);
assert.match(loader, /max-width:\$\{DEFAULT_WIDGET_MAX_WIDTH\}/);
assert.doesNotMatch(css, /\.ax-sso/);
assert.doesNotMatch(css, /\.ax-body/);
assert.doesNotMatch(css, /\.ax-context/);
assert.doesNotMatch(css, /grid-template-columns:\s*minmax\(220px, 248px\)/);

console.log('sso-widget-entry: ok');
