// cspell:ignore unstub
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearWorkerIntegrityCacheForTests,
  verifyWorkerIntegrity,
} from '../cdk/lib/pair-api/worker-integrity.ts';

const OLD_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

function sha256(bytes: string): string {
  return `sha256-${createHash('sha256').update(Buffer.from(bytes)).digest('base64url')}`;
}

afterEach(() => {
  process.env.ALLOWED_ORIGINS = OLD_ALLOWED_ORIGINS;
  vi.unstubAllGlobals();
  clearWorkerIntegrityCacheForTests();
});

describe('verifyWorkerIntegrity', () => {
  it('accepts a worker hash matching the server-fetched asset bytes', async () => {
    process.env.ALLOWED_ORIGINS = 'https://captcha-dev-jw.argus.pw';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('worker-source', { status: 200 }))
    );

    await expect(
      verifyWorkerIntegrity({
        workerUrl: 'https://captcha-dev-jw.argus.pw/assets/pair-qr-worker.js',
        workerSha256: sha256('worker-source'),
      })
    ).resolves.toEqual({ ok: true });
  });

  it('rejects rewritten worker bytes reported by the client', async () => {
    process.env.ALLOWED_ORIGINS = 'https://captcha-dev-jw.argus.pw';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('real-worker-source', { status: 200 }))
    );

    await expect(
      verifyWorkerIntegrity({
        workerUrl: 'https://captcha-dev-jw.argus.pw/assets/pair-qr-worker.js',
        workerSha256: sha256('rewritten-worker-source'),
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'worker_integrity_invalid',
      reason: 'hash_mismatch',
    });
  });

  it('rejects off-origin worker URLs', async () => {
    process.env.ALLOWED_ORIGINS = 'https://captcha-dev-jw.argus.pw';

    await expect(
      verifyWorkerIntegrity({
        workerUrl: 'https://evil.example/assets/pair-qr-worker.js',
        workerSha256: sha256('anything'),
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: 'bad_origin',
    });
  });
});
