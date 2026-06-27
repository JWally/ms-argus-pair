import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../cdk/cloudfront/spa-router.js', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(`${source}\nthis.handler = handler;`, context);

function route(uri) {
  const out = context.handler({ request: { uri } });
  return out.uri;
}

const cases = [
  ['/', '/index.html'],
  ['', '/index.html'],
  ['/pair/abc', '/phone.html'],
  ['/pair/abc/step', '/phone.html'],
  ['/assets/missing.js', '/assets/missing.js'],
  ['/assets/index.css', '/assets/index.css'],
  ['/api/session/start', '/api/session/start'],
  ['/favicon.svg', '/favicon.svg'],
  ['/robots.txt', '/robots.txt'],
  ['/manifest.webmanifest', '/manifest.webmanifest'],
  ['/source.js.map', '/source.js.map'],
];

for (const [input, expected] of cases) {
  const actual = route(input);
  if (actual !== expected) {
    console.error(`[spa-router] ${input}: expected ${expected}, got ${actual}`);
    process.exitCode = 1;
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('[spa-router] ok');
