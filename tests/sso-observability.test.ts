import { afterEach, describe, expect, it, vi } from 'vitest';
import { logSsoClientEvent } from '../cdk/lib/pair-api/sso-client-observability';
import { withSsoClientStage } from '../src/lib/sso-observability';

describe('SSO client observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('emits start and completion beacons around a client stage', async () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });

    await expect(
      withSsoClientStage(
        'argus-challenge',
        'argus_leg',
        '650b99f1-0a78-44f4-841d-0e80fa529812',
        () => Promise.resolve('done')
      )
    ).resolves.toBe('done');

    expect(sendBeacon).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(sendBeacon.mock.calls[0]?.[1]));
    const secondBody = JSON.parse(String(sendBeacon.mock.calls[1]?.[1]));
    expect(firstBody).toMatchObject({
      stage: 'argus-challenge',
      event: 'argus_leg',
      outcome: 'started',
    });
    expect(secondBody).toMatchObject({ outcome: 'completed' });
  });

  it('logs one bounded server entry with a correlatable session id', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    logSsoClientEvent({
      body: {
        stage: 'merchant-validate',
        event: 'http_request',
        outcome: 'failed',
        elapsedMs: 20_001,
        sessionId: '650b99f1-0a78-44f4-841d-0e80fa529812',
        error: 'ClientDeadlineError',
      },
      ip: '203.0.113.1',
      userAgent: 'Example Browser',
    });

    expect(info).toHaveBeenCalledTimes(1);
    const message = String(info.mock.calls[0]?.[0]);
    expect(message).toContain('[pair] sso_client');
    expect(message).toContain('stage=merchant-validate');
    expect(message).toContain('outcome=failed');
    expect(message).toContain('session=650b99f1-0a78-44f4-841d-0e80fa529812');
    expect(message).toContain('error=ClientDeadlineError');
  });
});
