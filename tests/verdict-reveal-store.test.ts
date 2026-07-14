import { describe, expect, it, vi } from 'vitest';
import {
  loadVerdictRevealState,
  markPhoneChallenge,
  markPhoneDone,
  shouldReleaseVerdict,
} from '../cdk/lib/pair-api/verdict-reveal-store';

function fakeDdb(returnedAttributes: Record<string, unknown> = {}) {
  return {
    send: vi.fn().mockResolvedValue({ Attributes: returnedAttributes, Item: returnedAttributes }),
  };
}

describe('verdict reveal store', () => {
  it('records challenge presence before the phone is allowed to continue', async () => {
    const ddb = fakeDdb({ challenge: true, phoneDone: false });
    await markPhoneChallenge(ddb as never, 'table', 'session-a', true, 1_000);

    expect(ddb.send).toHaveBeenCalledOnce();
    expect(ddb.send.mock.calls[0]?.[0]?.input).toMatchObject({
      TableName: 'table',
      Key: { PK: 'REVEAL#session-a', SK: 'STATE' },
      ExpressionAttributeValues: expect.objectContaining({ ':challenge': true }),
    });
  });

  it('records Done safely on retries and returns the released state', async () => {
    const ddb = fakeDdb({ challenge: true, phoneDone: true });
    const state = await markPhoneDone(ddb as never, 'table', 'session-a', 1_000);

    expect(state).toMatchObject({ challenge: true, phoneDone: true });
    expect(ddb.send.mock.calls[0]?.[0]?.input).toMatchObject({
      ExpressionAttributeValues: expect.objectContaining({ ':done': true }),
    });
  });

  it('loads reconnect state consistently', async () => {
    const ddb = fakeDdb({ challenge: true, phoneDone: true, expiresAt: 1_000 });
    await expect(loadVerdictRevealState(ddb as never, 'table', 'session-a')).resolves.toMatchObject(
      {
        challenge: true,
        phoneDone: true,
      }
    );
  });

  it('withholds only an active unfinished challenge and preserves the abandonment cap', () => {
    expect(shouldReleaseVerdict(null, 100, 101)).toBe(true);
    expect(shouldReleaseVerdict({ challenge: false, phoneDone: false }, 100, 101)).toBe(true);
    expect(shouldReleaseVerdict({ challenge: true, phoneDone: true }, 100, 101)).toBe(true);
    expect(shouldReleaseVerdict({ challenge: true, phoneDone: false }, 100, 189)).toBe(false);
    expect(shouldReleaseVerdict({ challenge: true, phoneDone: false }, 100, 190)).toBe(true);
  });
});
