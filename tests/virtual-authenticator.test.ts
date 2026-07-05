/*
 * Locks the virtual-authenticator AAGUID check. The load-bearing invariant is
 * NEGATIVE: it must reject the CDP virtual authenticator WITHOUT ever
 * false-positive a real device — real iOS/Android platform authenticators
 * report all-zero AAGUIDs for privacy, and hardware keys report real vendor
 * AAGUIDs. Rejecting either would break real users (the exact regression the
 * old "gate on non-zero AAGUID" attempt caused).
 */
import { describe, expect, it } from 'vitest';
import { isVirtualAuthenticator } from '../cdk/lib/pair-api/virtual-authenticator.ts';

describe('isVirtualAuthenticator', () => {
  it('flags the Chromium CDP virtual authenticator', () => {
    expect(isVirtualAuthenticator('01020304-0506-0708-0102-030405060708')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isVirtualAuthenticator('01020304-0506-0708-0102-030405060708'.toUpperCase())).toBe(true);
  });

  it('does NOT flag the all-zero AAGUID (real iOS/Android privacy default)', () => {
    expect(isVirtualAuthenticator('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('does NOT flag a real vendor AAGUID (e.g. a YubiKey)', () => {
    expect(isVirtualAuthenticator('ee882879-721c-4913-9775-3dfcce97072a')).toBe(false);
  });

  it('does NOT flag absent/empty AAGUIDs', () => {
    expect(isVirtualAuthenticator(undefined)).toBe(false);
    expect(isVirtualAuthenticator(null)).toBe(false);
    expect(isVirtualAuthenticator('')).toBe(false);
  });
});
