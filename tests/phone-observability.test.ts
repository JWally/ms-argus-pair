import { afterEach, describe, expect, it, vi } from 'vitest';
import { logPhonePerfEvent } from '../cdk/lib/pair-api/phone-observability.ts';

describe('phone performance observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one bounded log entry for a performance batch', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    logPhonePerfEvent({
      body: {
        version: 1,
        reason: 'attest_done',
        elapsedMs: 2_953,
        sessionId: '650b99f1-0a78-44f4-841d-0e80fa529812',
        phase: 'challenge',
        pathKind: 'pair',
        events: [
          { event: 'bootstrap_start', elapsedMs: 79 },
          { event: 'scan_done', elapsedMs: 2_101, durationMs: 1_913 },
          { event: 'attest_done', elapsedMs: 2_953, verdict: 'complete' },
        ],
      },
      ip: '203.0.113.1',
      userAgent: 'Example Browser',
    });

    expect(info).toHaveBeenCalledTimes(1);
    const message = String(info.mock.calls[0]?.[0]);
    expect(message).toContain('[pair] phone_perf_batch');
    expect(message).toContain('reason=attest_done');
    expect(message).toContain('elapsed_ms=2953');
    expect(message).toContain('event_count=3');
    expect(message).toContain('session=650b99f1-0a78-44f4-841d-0e80fa529812');
    expect(message).toContain('"event":"scan_done"');
    expect(message).toContain('"duration_ms":1913');
    expect(message).toContain('"verdict":"complete"');
  });

  it('keeps accepting legacy single-event payloads from cached clients', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    logPhonePerfEvent({
      body: {
        event: 'scan_done',
        elapsedMs: 2_101,
        durationMs: 1_913,
        sessionId: '650b99f1-0a78-44f4-841d-0e80fa529812',
      },
      ip: '203.0.113.1',
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('[pair] phone_perf event=scan_done');
  });
});
