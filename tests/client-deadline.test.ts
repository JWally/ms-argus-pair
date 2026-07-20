import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitWithDeadline,
  ClientDeadlineError,
  fetchWithDeadline,
} from '../src/lib/client-deadline';

describe('client deadlines', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects a stalled bootstrap with its named stage', async () => {
    vi.useFakeTimers();
    const stalled = new Promise<void>(() => undefined);
    const result = awaitWithDeadline(stalled, 15_000, 'argus_bootstrap');

    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(rejection).resolves.toMatchObject({
      name: 'ClientDeadlineError',
      stage: 'argus_bootstrap',
    });
  });

  it('returns a value that arrives before the deadline', async () => {
    await expect(
      awaitWithDeadline(Promise.resolve('ready'), 15_000, 'argus_bootstrap')
    ).resolves.toBe('ready');
  });

  it('aborts a stalled fetch and reports the request stage', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        });
      })
    );

    const request = fetchWithDeadline('/api/sso/start', {}, 12_000, 'sso_start_http');
    const rejection = request.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(rejection).resolves.toBeInstanceOf(ClientDeadlineError);
  });
});
