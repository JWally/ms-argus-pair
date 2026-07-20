import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFetch } from '../src/lib/json-http';
import type { HttpError } from '../src/lib/json-http';

describe('JSON HTTP client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps structured error details for code without exposing raw JSON in the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'challenge_mismatch', internal: 'do-not-render' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const request = jsonFetch('/api/sso/session/validate', { method: 'POST' });
    await expect(request).rejects.toMatchObject({
      status: 409,
      bodyJson: { error: 'challenge_mismatch' },
      message: 'Request failed (409). Please try again.',
    });
    await expect(request).rejects.not.toThrow(/challenge_mismatch|do-not-render/);
  });

  it('uses a friendly message for a non-JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>gateway failure</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          })
      )
    );

    await expect(jsonFetch('/api/sso/start')).rejects.toEqual(
      expect.objectContaining<HttpError>({
        status: 502,
        message: 'Request failed (502). Please try again.',
      })
    );
  });
});
