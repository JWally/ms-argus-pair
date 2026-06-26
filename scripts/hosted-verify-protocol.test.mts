#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  buildHostedVerifyCallbackUrl,
  buildHostedVerifyRedirectUrl,
  validateHostedVerifyReturnUrl,
} from '../cdk/lib/hosted-verify/protocol';

const allowedReturnOrigins = ['https://shop.example'];

assert.equal(
  validateHostedVerifyReturnUrl(
    'https://shop.example/checkout/argus/callback',
    allowedReturnOrigins
  ).ok,
  true
);

assert.equal(
  validateHostedVerifyReturnUrl('http://shop.example/checkout/argus/callback', allowedReturnOrigins)
    .ok,
  false
);

assert.equal(
  validateHostedVerifyReturnUrl(
    'https://evil.example/checkout/argus/callback',
    allowedReturnOrigins
  ).ok,
  false
);

{
  const url = buildHostedVerifyRedirectUrl({
    verifyBaseUrl: 'https://verify.argus.pw',
    sessionId: 'verify_session_123',
    merchantId: 'merchant_gap',
    state: 'opaque_state',
    nonce: 'nonce_123',
  });
  assert.equal(
    url,
    'https://verify.argus.pw/verify/verify_session_123?m=merchant_gap&state=opaque_state&n=nonce_123'
  );
}

{
  const url = buildHostedVerifyCallbackUrl({
    returnUrl: 'https://shop.example/checkout/argus/callback?cart=abc',
    code: 'one_time_code',
    state: 'opaque_state',
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://shop.example');
  assert.equal(parsed.searchParams.get('cart'), 'abc');
  assert.equal(parsed.searchParams.get('code'), 'one_time_code');
  assert.equal(parsed.searchParams.get('state'), 'opaque_state');
  assert.equal(parsed.searchParams.has('verdict'), false);
  assert.equal(parsed.searchParams.has('passed'), false);
  assert.equal(parsed.searchParams.has('token'), false);
}

console.log('hosted-verify-protocol: ok');
