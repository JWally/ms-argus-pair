import { describe, expect, it } from 'vitest';
import { validatePairTokenMintBody } from '../cdk/lib/pair-api/pair-token-request.ts';

const validBody = {
  wsUrl: 'wss://pair.example/ws',
  e: 'desktop-envelope',
  pt: 'phone-token',
  n: 'nonce',
  cPub: 'client-pub',
  workerUrl: 'https://captcha-dev-jw.argus.pw/assets/pair-qr-worker.js',
  workerSha256: 'sha256-worker',
};

describe('pair-token mint request validation', () => {
  it('accepts the public bootstrap fields needed to seal the QR', () => {
    expect(validatePairTokenMintBody({ ...validBody, debug: true })).toEqual({
      ok: true,
      body: {
        ...validBody,
        debug: true,
      },
    });
  });

  it('normalizes debug to true only for the boolean true value', () => {
    expect(validatePairTokenMintBody({ ...validBody, debug: 'true' })).toMatchObject({
      ok: true,
      body: { debug: false },
    });
    expect(validatePairTokenMintBody(validBody)).toMatchObject({
      ok: true,
      body: { debug: false },
    });
  });

  it('rejects missing or non-string bootstrap fields', () => {
    expect(validatePairTokenMintBody({ ...validBody, cPub: 123 })).toEqual({
      ok: false,
      status: 400,
      body: { error: 'invalid_pair_blob' },
    });
    expect(validatePairTokenMintBody({ ...validBody, workerSha256: undefined })).toEqual({
      ok: false,
      status: 400,
      body: { error: 'invalid_pair_blob' },
    });
  });
});
