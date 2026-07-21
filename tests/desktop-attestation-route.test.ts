/**
 * Desktop-attestation route contract.
 *
 * Validation and host-preflight policy live in desktop-attest.ts. This suite
 * keeps session state, the single-writer slot, and optimistic projection
 * classification explicit at the application boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDesktopAttestationHandler } from '../cdk/lib/pair-api/desktop-attestation-route';
import type { StoredDesktopAttestation } from '../cdk/lib/pair-api/desktop-attest';

const SESSION_ID = 'pair-session-1';
const BODY = { attestation: { envelope: 'desktop-envelope' } };
const STORED = {
  argusSessionId: 'argus-session-1',
  envelope: 'desktop-envelope',
  signature: 'signature',
  publicKey: 'public-key',
  keyId: 'key-id',
  receivedAt: 123,
  envelopeDecoded: {
    v: 1,
    purpose: 'argus-pair-v1',
    payload: {},
    iat: 100,
    exp: 200,
    keyId: 'key-id',
  },
} satisfies StoredDesktopAttestation;

function session(overrides: Record<string, unknown> = {}) {
  return {
    nonce: 'pair-nonce',
    challengeId: 'challenge-1',
    cpi: 'cpi-1',
    hostPreflightRequired: true,
    hostOrigin: 'https://merchant.example',
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    loadSession: vi.fn().mockResolvedValue(session()),
    prepareDesktopAttestation: vi.fn().mockResolvedValue({ ok: true, stored: STORED }),
    storeDesktopAttestation: vi.fn().mockResolvedValue(true),
    classifyDesktop: vi.fn().mockResolvedValue({
      clean: true,
      summary: { browser: 'Chrome', individualScore: 0 },
    }),
    logWarn: vi.fn(),
    ...overrides,
  };
}

function bodyOf(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('desktop-attestation route state and preparation', () => {
  it('returns not found without attempting to prepare an expired session', async () => {
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue(null) });
    const response = await createDesktopAttestationHandler(deps)(BODY, SESSION_ID);

    expect(response.statusCode).toBe(404);
    expect(bodyOf(response)).toEqual({ error: 'session_not_found' });
    expect(deps.prepareDesktopAttestation).not.toHaveBeenCalled();
    expect(deps.storeDesktopAttestation).not.toHaveBeenCalled();
  });

  it('rejects an occupied desktop slot before validation or projection work', async () => {
    const deps = dependencies({
      loadSession: vi.fn().mockResolvedValue(session({ desktopAttestation: STORED })),
    });
    const response = await createDesktopAttestationHandler(deps)(BODY, SESSION_ID);

    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toEqual({ error: 'already_attested' });
    expect(deps.prepareDesktopAttestation).not.toHaveBeenCalled();
    expect(deps.classifyDesktop).not.toHaveBeenCalled();
  });

  it('passes exact session binding context and forwards preparation failures', async () => {
    const deps = dependencies({
      prepareDesktopAttestation: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        body: { error: 'argus_session_already_claimed', reason: 'claimed' },
      }),
    });
    const response = await createDesktopAttestationHandler(deps)(BODY, SESSION_ID);

    expect(deps.prepareDesktopAttestation).toHaveBeenCalledWith(BODY, {
      pairSessionId: SESSION_ID,
      nonce: 'pair-nonce',
      challengeId: 'challenge-1',
      cpi: 'cpi-1',
      hostPreflightRequired: true,
      hostOrigin: 'https://merchant.example',
    });
    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toEqual({
      error: 'argus_session_already_claimed',
      reason: 'claimed',
    });
    expect(deps.storeDesktopAttestation).not.toHaveBeenCalled();
  });

  it('maps a lost single-writer race to already attested', async () => {
    const deps = dependencies({
      storeDesktopAttestation: vi.fn().mockResolvedValue(false),
    });
    const response = await createDesktopAttestationHandler(deps)(BODY, SESSION_ID);

    expect(deps.storeDesktopAttestation).toHaveBeenCalledWith(SESSION_ID, STORED);
    expect(response.statusCode).toBe(409);
    expect(bodyOf(response)).toEqual({ error: 'already_attested' });
    expect(deps.classifyDesktop).not.toHaveBeenCalled();
  });
});

describe('desktop-attestation optimistic classification', () => {
  it('returns the best-effort desktop summary after committing the attestation', async () => {
    const deps = dependencies();
    const response = await createDesktopAttestationHandler(deps)(BODY, SESSION_ID);

    expect(deps.classifyDesktop).toHaveBeenCalledWith(STORED.argusSessionId);
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({
      ok: true,
      clean: true,
      summary: { browser: 'Chrome', individualScore: 0 },
    });
  });

  it('uses the existing conservative defaults when no projection is ready', async () => {
    const deps = dependencies({ classifyDesktop: vi.fn().mockResolvedValue(null) });
    const response = await createDesktopAttestationHandler(deps)(BODY, SESSION_ID);

    expect(bodyOf(response)).toEqual({ ok: true, clean: false, summary: null });
  });

  it('logs projection failures without failing the committed attestation', async () => {
    const deps = dependencies({
      classifyDesktop: vi.fn().mockRejectedValue(new Error('projection unavailable')),
    });
    const response = await createDesktopAttestationHandler(deps)(BODY, SESSION_ID);

    expect(bodyOf(response)).toEqual({ ok: true, clean: false, summary: null });
    expect(deps.logWarn).toHaveBeenCalledWith(
      '[pair] desktop-attest optimistic classify failed: projection unavailable'
    );
  });
});
