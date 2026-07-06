import { describe, expect, it } from 'vitest';
import {
  buildSessionStartRateLimit,
  SESSION_START_RL_MAX,
  SESSION_START_RL_WINDOW_SEC,
} from '../cdk/lib/pair-api/session-start-rate-limit.ts';

describe('session-start rate-limit helpers', () => {
  it('builds a stable fixed-window bucket for the viewer IP', () => {
    const first = buildSessionStartRateLimit('203.0.113.10', 1_783_341_070_123);
    const sameWindow = buildSessionStartRateLimit('203.0.113.10', 1_783_341_099_999);

    expect(first.bucket).toMatch(/^[0-9a-f]{32}$/);
    expect(first.window).toBe(sameWindow.window);
    expect(first.bucket).toBe(sameWindow.bucket);
    expect(first.ddbKey).toEqual({ PK: `RL#${first.bucket}#${first.window}`, SK: 'CT' });
  });

  it('normalizes missing IPs and rolls to the next window by time', () => {
    const first = buildSessionStartRateLimit('', 1_783_341_070_000);
    const nextWindow = buildSessionStartRateLimit('', 1_783_341_130_000);

    expect(first.bucket).toBe(buildSessionStartRateLimit('unknown', 1_783_341_070_000).bucket);
    expect(nextWindow.window).toBe(first.window + 1);
  });

  it('keeps DDB and Valkey caps aligned at exactly the configured max', () => {
    const gate = buildSessionStartRateLimit('198.51.100.20', 1_783_341_070_000);

    expect(gate.max).toBe(SESSION_START_RL_MAX);
    expect(gate.windowSec).toBe(SESSION_START_RL_WINDOW_SEC);
    expect(gate.valkeyCap).toBe(SESSION_START_RL_MAX + 1);
    expect(gate.ttlSeconds).toBe(SESSION_START_RL_WINDOW_SEC + 60);
  });
});
