#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* global fetch */

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function fail(message) {
  console.error(`argus-loader-sri: ${message}`);
  process.exitCode = 1;
}

const match = html.match(
  /src="(https:\/\/static-integrity-dev-jw\.argus\.pw\/argus-bootstrap\.v1\.iife\.js)"[\s\S]*?integrity="([^"]+)"/
);

if (!match) {
  fail('index.html is missing pinned argus-bootstrap.v1.iife.js');
} else {
  const [, url, pinned] = match;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    fail(`failed to fetch ${url}: ${res.status}`);
  } else {
    const body = Buffer.from(await res.arrayBuffer());
    const actual = `sha384-${crypto.createHash('sha384').update(body).digest('base64')}`;
    if (actual !== pinned) {
      fail(`bootstrap SRI drift: pinned ${pinned}, actual ${actual}`);
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('argus-bootstrap-sri: ok');
