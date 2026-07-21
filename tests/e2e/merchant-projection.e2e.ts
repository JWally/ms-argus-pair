/*
 * Live ms-argus-api -> Pair projection contract.
 *
 * The fixture owns a short-lived dev-jw merchant, signed credential, and
 * integrity row. It uses the stack's stable dev-jw E2E gateway key; requests
 * still travel through the custom domain, API Gateway, Lambda, and DynamoDB.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectionClient } from '../../cdk/lib/pair-api/projection-client.ts';
import {
  createLiveMerchantProjectionFixture,
  type LiveMerchantProjectionFixture,
} from './live-merchant-projection.ts';

let fixture: LiveMerchantProjectionFixture;

beforeAll(async () => {
  fixture = await createLiveMerchantProjectionFixture();
});

beforeEach(async () => {
  await fixture.reset();
});

afterAll(async () => {
  await fixture?.cleanup();
});

function client(credential = fixture.credential) {
  return createProjectionClient({
    apiUrl: fixture.apiUrl,
    credential,
    cpi: fixture.cpi,
    fetch,
    warn: vi.fn(),
  });
}

describe('deployed merchant projection boundary', () => {
  it('proves auth, success, missing-session debit, and credit exhaustion', async () => {
    const invalidCredential = `${fixture.keyId}.invalid.invalid`;
    await expect(client(invalidCredential).fetchProjection(fixture.sessionId)).resolves.toEqual({
      ok: false,
      reason: 'unauthorized',
      status: 401,
    });

    await expect(client().fetchProjection(fixture.sessionId)).resolves.toMatchObject({
      ok: true,
      projection: {
        schema_version: 1,
        session_id: fixture.sessionId,
        verdict: expect.stringMatching(/^(clean|suspect|block)$/),
        automation: expect.any(Number),
        device_tampering: expect.any(Number),
        network_tampering: expect.any(Number),
      },
    });

    await expect(client().fetchProjection(randomUUID())).resolves.toEqual({
      ok: false,
      reason: 'not_found',
      status: 404,
    });

    await expect(client().fetchProjection(fixture.sessionId)).resolves.toEqual({
      ok: false,
      reason: 'insufficient_credits',
      status: 402,
    });
    await expect(fixture.creditsRemaining()).resolves.toBe(0);
  });
});
