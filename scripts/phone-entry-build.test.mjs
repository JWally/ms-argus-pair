#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';

function fail(message) {
  console.error(`phone-entry-build: ${message}`);
  process.exitCode = 1;
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const mainSource = read('src/main.tsx');
const phoneSource = read('src/phone-main.tsx');
const routerSource = read('cdk/cloudfront/spa-router.js');
const rootSw = read('public/sw.js');
const phoneSw = read('public/phone-sw.js');

if (mainSource.includes('serviceWorker')) {
  fail('desktop entry must not register a service worker');
}
if (!phoneSource.includes('serviceWorker.register') || !phoneSource.includes('/phone-sw.js')) {
  fail('phone entry should be the only place that registers the phone service worker');
}
if (rootSw.includes("addEventListener('fetch'") || rootSw.includes('addEventListener("fetch"')) {
  fail('retired root service worker must not intercept desktop fetches');
}
if (phoneSw.includes("url.pathname.startsWith('/assets/')") && !phoneSw.includes("endsWith('.css')")) {
  fail('phone service worker must not cache all /assets, especially JavaScript');
}
if (phoneSw.includes("endsWith('.js')")) {
  fail('phone service worker must not cache JavaScript');
}
if (!routerSource.includes("request.uri = '/phone.html'")) {
  fail('CloudFront router must send /pair/* to phone.html');
}

const distUrl = new URL('../dist/', import.meta.url);
try {
  const indexHtml = readFileSync(new URL('index.html', distUrl), 'utf8');
  const phoneHtml = readFileSync(new URL('phone.html', distUrl), 'utf8');
  const assets = readdirSync(new URL('assets/', distUrl));
  const indexScripts = [...indexHtml.matchAll(/src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  const phoneScripts = [...phoneHtml.matchAll(/src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);

  if (indexScripts.length === 0) fail('index.html should reference a desktop JS asset');
  if (phoneScripts.length === 0) fail('phone.html should reference a phone JS asset');
  if (indexScripts.some((name) => phoneScripts.includes(name))) {
    fail(`desktop and phone must not share the same entry JS asset: ${indexScripts.join(', ')}`);
  }

  const phoneEntry = phoneScripts.find((name) => name.startsWith('phone-')) ?? phoneScripts[0];
  const phoneBody = readFileSync(new URL(`assets/${phoneEntry}`, distUrl), 'utf8');
  if (phoneBody.includes('Scan · with') || phoneBody.includes('leaderboard')) {
    fail(`${basename(phoneEntry)} should not include desktop demo copy`);
  }
  if (!assets.includes('phone-sw.js') && !readdirSync(distUrl).includes('phone-sw.js')) {
    fail('dist should include phone-sw.js');
  }
} catch (e) {
  fail(`dist build shape unavailable: ${e instanceof Error ? e.message : String(e)}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log('phone-entry-build: ok');
