/**
 * Pair-token mint route contract.
 *
 * The desktop is allowed to relay bootstrap material, but it must not select
 * proof policy, bypass worker integrity, or receive a plaintext token when QR
 * sealing fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPairTokenMintHandler } from '../cdk/lib/pair-api/pair-token-mint-route';

const EVENT = { queryStringParameters: { t: 'desktop-token' } };
const SESSION_ID = 'session-1';
const VALID_BODY = {
  wsUrl: 'wss://pair.example/ws',
  e: 'desktop-envelope',
  pt: 'phone-token',
  n: 'session-nonce',
  cPub: 'client-public-key',
  workerUrl: 'https://captcha-dev-jw.argus.pw/assets/pair-qr-worker.js',
  workerSha256: 'sha256-worker',
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    authenticateParticipant: vi.fn().mockResolvedValue(true),
    loadSession: vi.fn().mockResolvedValue({ proofRequired: false, freshProofRequired: true }),
    verifyWorkerIntegrity: vi.fn().mockResolvedValue({ ok: true }),
    mintToken: vi.fn().mockResolvedValue('minted-token'),
    sealQr: vi.fn().mockResolvedValue({ enc: 'sealed-frames', kind: 'png-frames' }),
    pairOrigin: 'https://captcha-dev-jw.argus.pw',
    proofRequiredByDefault: true,
    logWarn: vi.fn(),
    ...overrides,
  };
}

function bodyOf(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('pair-token mint route authorization and validation', () => {
  it('rejects an unauthenticated caller before loading session state', async () => {
    const deps = dependencies({ authenticateParticipant: vi.fn().mockResolvedValue(false) });
    const response = await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, VALID_BODY);

    expect(response.statusCode).toBe(401);
    expect(bodyOf(response)).toEqual({ error: 'pair_token_unauthorized' });
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.mintToken).not.toHaveBeenCalled();
  });

  it('rejects malformed bootstrap fields before storage or worker checks', async () => {
    const deps = dependencies();
    const response = await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, {
      ...VALID_BODY,
      cPub: 123,
    });

    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual({ error: 'invalid_pair_blob' });
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.verifyWorkerIntegrity).not.toHaveBeenCalled();
  });

  it('returns not found when the authenticated session has expired', async () => {
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue(null) });
    const response = await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, VALID_BODY);

    expect(response.statusCode).toBe(404);
    expect(bodyOf(response)).toEqual({ error: 'session_not_found' });
    expect(deps.verifyWorkerIntegrity).not.toHaveBeenCalled();
  });

  it('fails closed when the server cannot verify the QR worker', async () => {
    const deps = dependencies({
      verifyWorkerIntegrity: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        error: 'worker_integrity_invalid',
        reason: 'hash_mismatch',
      }),
    });
    const response = await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, VALID_BODY);

    expect(bodyOf(response)).toEqual({
      error: 'worker_integrity_invalid',
      reason: 'hash_mismatch',
    });
    expect(deps.mintToken).not.toHaveBeenCalled();
  });
});

describe('pair-token mint route server-owned policy and sealing', () => {
  it('mints server policy and seals the token with the requested debug suffix', async () => {
    const deps = dependencies();
    const response = await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, {
      ...VALID_BODY,
      debug: true,
      proofRequired: true,
      freshProofRequired: false,
    });

    expect(deps.mintToken).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      wsUrl: VALID_BODY.wsUrl,
      e: VALID_BODY.e,
      pt: VALID_BODY.pt,
      n: VALID_BODY.n,
      proofRequired: false,
      freshProofRequired: true,
    });
    expect(deps.sealQr).toHaveBeenCalledWith({
      pairOrigin: deps.pairOrigin,
      token: 'minted-token',
      suffix: '?debug=true',
      clientPublicKey: VALID_BODY.cPub,
      compression: 'none',
    });
    expect(response.statusCode).toBe(200);
    expect(bodyOf(response)).toEqual({ enc: 'sealed-frames', kind: 'png-frames' });
  });

  it('uses configured proof defaults for legacy session rows', async () => {
    const deps = dependencies({ loadSession: vi.fn().mockResolvedValue({}) });
    await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, VALID_BODY);

    expect(deps.mintToken).toHaveBeenCalledWith(
      expect.objectContaining({ proofRequired: true, freshProofRequired: false })
    );
  });

  it('refuses plaintext fallback when QR sealing rejects the client key', async () => {
    const deps = dependencies({ sealQr: vi.fn().mockRejectedValue(new Error('bad key')) });
    const response = await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, VALID_BODY);

    expect(response.statusCode).toBe(400);
    expect(bodyOf(response)).toEqual({ error: 'bad_client_pubkey' });
    expect(response.body).not.toContain('minted-token');
    expect(deps.logWarn).toHaveBeenCalledWith(
      '[pair] pair-token seal failed, refusing plaintext: bad key'
    );
  });

  it('logs non-Error sealing failures without weakening the response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = dependencies({
      sealQr: vi.fn().mockRejectedValue('key import rejected'),
      logWarn: undefined,
    });
    const response = await createPairTokenMintHandler(deps)(EVENT, SESSION_ID, VALID_BODY);

    expect(bodyOf(response)).toEqual({ error: 'bad_client_pubkey' });
    expect(warn).toHaveBeenCalledWith(
      '[pair] pair-token seal failed, refusing plaintext: key import rejected'
    );
    warn.mockRestore();
  });
});
