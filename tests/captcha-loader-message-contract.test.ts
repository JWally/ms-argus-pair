import { describe, expect, it } from 'vitest';
import { parseCaptchaMessage } from '../loader/message-contract.ts';

const expectedOrigin = 'https://captcha-dev-jw.argus.pw';
const expectedSource = {};

const envelope = (data: unknown) => ({
  origin: expectedOrigin,
  source: expectedSource,
  data,
});

describe('captcha loader message contract', () => {
  it('accepts a result only from the exact iframe origin and window', () => {
    const parsed = parseCaptchaMessage(
      envelope({
        source: 'argus-captcha',
        event: 'result',
        sessionId: 'session-123',
        verdict: 'passed',
        reason: null,
        token: 'signed-token',
      }),
      expectedOrigin,
      expectedSource
    );

    expect(parsed?.result).toEqual({
      sessionId: 'session-123',
      verdict: 'passed',
      reason: null,
      token: 'signed-token',
    });
    expect(parsed?.payload.event).toBe('result');
  });

  it('relays a lifecycle event without inventing a result or resize', () => {
    const parsed = parseCaptchaMessage(
      envelope({ source: 'argus-captcha', event: 'connected', transport: 'websocket' }),
      expectedOrigin,
      expectedSource
    );

    expect(parsed?.payload.event).toBe('connected');
    expect(parsed?.result).toBeNull();
    expect(parsed?.sizeHeight).toBeNull();
  });

  it('accepts a finite iframe resize height', () => {
    const parsed = parseCaptchaMessage(
      envelope({ source: 'argus-captcha', event: 'size', height: 420.5 }),
      expectedOrigin,
      expectedSource
    );

    expect(parsed?.sizeHeight).toBe(420.5);
  });

  it.each([
    [
      'wrong origin',
      { ...envelope({ source: 'argus-captcha', event: 'ready' }), origin: 'https://evil.example' },
    ],
    [
      'wrong source window',
      { ...envelope({ source: 'argus-captcha', event: 'ready' }), source: {} },
    ],
    ['null payload', envelope(null)],
    ['array payload', envelope([{ source: 'argus-captcha', event: 'ready' }])],
    ['missing marker', envelope({ event: 'ready' })],
    ['wrong marker', envelope({ source: 'another-widget', event: 'ready' })],
  ])('rejects %s', (_name, rejectedEnvelope) => {
    expect(parseCaptchaMessage(rejectedEnvelope, expectedOrigin, expectedSource)).toBeNull();
  });

  it.each([
    ['empty session id', { sessionId: '', verdict: 'passed', reason: null, token: 'signed-token' }],
    [
      'empty verdict',
      { sessionId: 'session-123', verdict: '', reason: null, token: 'signed-token' },
    ],
    [
      'non-string reason',
      { sessionId: 'session-123', verdict: 'passed', reason: 7, token: 'signed-token' },
    ],
    ['non-string token', { sessionId: 'session-123', verdict: 'passed', reason: null, token: {} }],
  ])('does not promote a result with %s', (_name, malformedResult) => {
    const parsed = parseCaptchaMessage(
      envelope({ source: 'argus-captcha', event: 'result', ...malformedResult }),
      expectedOrigin,
      expectedSource
    );

    expect(parsed?.payload.event).toBe('result');
    expect(parsed?.result).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '420'])(
    'rejects invalid resize height %s',
    (height) => {
      const parsed = parseCaptchaMessage(
        envelope({ source: 'argus-captcha', event: 'size', height }),
        expectedOrigin,
        expectedSource
      );

      expect(parsed?.sizeHeight).toBeNull();
    }
  );
});
