/*
 * Live SSO infrastructure contracts.
 *
 * These tests seed short-lived, UUID-isolated SSO states in the real dev-jw
 * Pair DynamoDB table, then exercise them only through the deployed HTTP API.
 * This proves API Gateway/Lambda/DynamoDB request mapping and atomic replay
 * protection without adding a test-only production route. Genuine Argus/PAT
 * issuance remains a physical-browser test boundary.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteSsoFixture,
  getSsoFixture,
  putSsoFixture,
  resolveLivePairInfra,
  type LivePairInfra,
} from './live-pair-infra';

const HOST = process.env.PAIR_HOST ?? 'https://captcha-dev-jw.argus.pw';
const CPI = 'argus_cpi_test_Example12345.fastpass';
const OTHER_CPI = 'argus_cpi_test_Example12345.stepup';
const CALLBACK = 'https://www-dev-jw.argus.pw/api/captcha/sso-return';
const APPROVAL_COOKIE = '__Secure-argus_sso_approval';

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

let infra: LivePairInfra;
const fixtureIds = new Set<string>();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function returnCodeHash(code: string): string {
  return sha256(`argus-pair-sso-return:${code}`);
}

function newFixtureId(): string {
  const sessionId = randomUUID();
  fixtureIds.add(sessionId);
  return sessionId;
}

function approvedFixture({
  token,
  challengeId,
  cpi = CPI,
}: {
  token: string;
  challengeId?: string;
  cpi?: string;
}): Record<string, unknown> {
  return {
    nonce: randomUUID(),
    merchantSessionId: `merchant-${randomUUID()}`,
    cpi,
    proofRequired: false,
    freshProofRequired: false,
    verdict: 'approved',
    approvalTokenHash: sha256(token),
    ...(challengeId ? { merchantChallengeId: challengeId, merchantCallbackUrl: CALLBACK } : {}),
  };
}

async function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<ApiResponse> {
  const response = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed, headers: response.headers };
}

async function postAfterFixture(
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<ApiResponse> {
  const deadline = Date.now() + 5_000;
  let response = await post(path, body, headers);
  while (response.status === 410 && response.body.error === 'sso_session_not_found') {
    if (Date.now() >= deadline) return response;
    await new Promise((resolve) => setTimeout(resolve, 100));
    response = await post(path, body, headers);
  }
  return response;
}

beforeAll(async () => {
  infra = await resolveLivePairInfra();
});

afterEach(async () => {
  const pending = [...fixtureIds];
  fixtureIds.clear();
  await Promise.all(pending.map((sessionId) => deleteSsoFixture(infra, sessionId)));
});

describe('deployed SSO API and return-code contracts', () => {
  it('rejects malformed starts and unknown sessions at the live API boundary', async () => {
    expect(await post('/api/sso/start', {})).toMatchObject({
      status: 400,
      body: { error: 'missing_cpi' },
    });
    expect(await post('/api/sso/start', { cpi: 'not-a-cpi' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_cpi' },
    });

    const missingId = randomUUID();
    expect(await post(`/api/sso/${missingId}/challenge`, {})).toMatchObject({
      status: 404,
      body: { error: 'sso_session_not_found' },
    });
    expect(await post(`/api/sso/${missingId}/validate`, {})).toMatchObject({
      status: 404,
      body: { error: 'sso_session_not_found' },
    });
  });

  it('enforces return-code lifecycle states loaded from real DynamoDB', async () => {
    const code = `sso_${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);

    const pendingId = newFixtureId();
    await putSsoFixture(infra, pendingId, { verdict: 'pending', cpi: CPI });
    expect(await post(`/api/sso/${pendingId}/validate`, { returnCode: code })).toMatchObject({
      status: 409,
      body: { error: 'sso_challenge_not_completed' },
    });

    const invalidId = newFixtureId();
    await putSsoFixture(infra, invalidId, {
      verdict: 'pending',
      cpi: CPI,
      challengeProfile: { argusSessionId: 'fixture' },
      returnCodeHash: returnCodeHash(code),
      returnCodeExpiresAt: now + 60,
    });
    expect(
      await post(`/api/sso/${invalidId}/validate`, { returnCode: `${code}-wrong` })
    ).toMatchObject({ status: 401, body: { error: 'sso_return_code_invalid' } });

    const expiredId = newFixtureId();
    await putSsoFixture(infra, expiredId, {
      verdict: 'pending',
      cpi: CPI,
      challengeProfile: { argusSessionId: 'fixture' },
      returnCodeHash: returnCodeHash(code),
      returnCodeExpiresAt: now - 1,
    });
    expect(await post(`/api/sso/${expiredId}/validate`, { returnCode: code })).toMatchObject({
      status: 401,
      body: { error: 'sso_return_code_expired' },
    });

    const consumedId = newFixtureId();
    await putSsoFixture(infra, consumedId, {
      verdict: 'pending',
      cpi: CPI,
      challengeProfile: { argusSessionId: 'fixture' },
      returnCodeHash: returnCodeHash(code),
      returnCodeExpiresAt: now + 60,
      returnCodeConsumedAt: now,
    });
    expect(await post(`/api/sso/${consumedId}/validate`, { returnCode: code })).toMatchObject({
      status: 409,
      body: { error: 'sso_return_code_consumed' },
    });
  });
});

describe('deployed SSO approval contracts', () => {
  it('atomically exchanges a merchant-bound approval once', async () => {
    const sessionId = newFixtureId();
    const token = `approval-${randomUUID()}`;
    const challengeId = `checkout_${randomUUID().replaceAll('-', '')}`;
    await putSsoFixture(infra, sessionId, approvedFixture({ token, challengeId }));

    const request = { sessionId, code: token, cpi: CPI, challengeId };
    const first = await postAfterFixture('/api/sso/approval/exchange', request);
    expect(first).toMatchObject({
      status: 200,
      body: {
        valid: true,
        passed: true,
        verdict: 'approved',
        cpi: CPI,
        scope: 'fastpass',
        challengeId,
      },
    });

    expect(await post('/api/sso/approval/exchange', request)).toMatchObject({
      status: 409,
      body: { error: 'sso_approval_consumed' },
    });
    const stored = await getSsoFixture(infra, sessionId);
    expect(stored?.approvalRedeemedAt).toEqual(expect.any(Number));
    expect(stored?.approvalTokenHash).toBeUndefined();
  });

  it('does not consume an approval on challenge or CPI substitution', async () => {
    const sessionId = newFixtureId();
    const token = `approval-${randomUUID()}`;
    const challengeId = `checkout_${randomUUID().replaceAll('-', '')}`;
    await putSsoFixture(infra, sessionId, approvedFixture({ token, challengeId }));

    expect(
      await postAfterFixture('/api/sso/approval/exchange', {
        sessionId,
        code: token,
        cpi: CPI,
        challengeId: `checkout_${randomUUID().replaceAll('-', '')}`,
      })
    ).toMatchObject({ status: 409, body: { error: 'sso_approval_challenge_mismatch' } });
    expect(
      await post('/api/sso/approval/exchange', {
        sessionId,
        code: token,
        cpi: OTHER_CPI,
        challengeId,
      })
    ).toMatchObject({ status: 409, body: { error: 'sso_approval_cpi_mismatch' } });

    expect((await getSsoFixture(infra, sessionId))?.approvalTokenHash).toBe(sha256(token));
    expect(
      await post('/api/sso/approval/exchange', { sessionId, code: token, cpi: CPI, challengeId })
    ).toMatchObject({ status: 200, body: { verdict: 'approved' } });
  });

  it('maps the secure approval cookie and clears it after one redemption', async () => {
    const sessionId = newFixtureId();
    const token = `approval-${randomUUID()}`;
    await putSsoFixture(infra, sessionId, approvedFixture({ token }));
    const request = { sessionId, cpi: CPI };
    const headers = { cookie: `${APPROVAL_COOKIE}=${encodeURIComponent(token)}` };

    const first = await postAfterFixture('/api/sso/approval/redeem', request, headers);
    expect(first).toMatchObject({
      status: 200,
      body: { verdict: 'approved', cpi: CPI, scope: 'fastpass' },
    });
    expect(first.headers.get('set-cookie')).toContain(`${APPROVAL_COOKIE}=`);
    expect(first.headers.get('set-cookie')).toContain('Max-Age=0');

    expect(await post('/api/sso/approval/redeem', request, headers)).toMatchObject({
      status: 409,
      body: { error: 'sso_approval_consumed' },
    });
  });
});
