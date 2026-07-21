import { describe, expect, it, vi } from 'vitest';
import { createProjectionClient, splitCredential } from '../cdk/lib/pair-api/projection-client.ts';
import { parseMerchantProjection } from '../cdk/lib/pair-api/projection-contract.ts';

const VALID_PROJECTION = {
  schema_version: 1,
  session_id: 'session-1',
  created_at: 1_784_554_000_000,
  automation: 0,
  device_tampering: 5,
  network_tampering: 10,
  verdict: 'clean',
  identification: {
    browserDetails: {
      browserName: 'Chrome',
      browserVersion: '150',
      os: 'Windows',
      device: 'desktop',
      userAgent: 'Mozilla/5.0',
    },
  },
  ip: '203.0.113.7',
  ipLocation: { city: 'Blooming Grove', country: 'US' },
  ipInfo: {
    asn: { organization: 'Frontier Communications of America' },
    datacenter: { result: false },
    mobile: { result: false },
    vpn: { result: false },
    hosting: { result: false },
  },
  tags: [],
  worker_scope_evidence: null,
} as const;

function clientFor(fetchImplementation: typeof fetch) {
  return createProjectionClient({
    apiUrl: 'https://api.example.test',
    credential: 'key-id.secret.token',
    cpi: 'argus_cpi_test_1234567890',
    fetch: fetchImplementation,
    warn: vi.fn(),
  });
}

describe('splitCredential', () => {
  it('splits key id and token on the first separator', () => {
    expect(splitCredential('key.token.with.dots')).toEqual({
      keyId: 'key',
      token: 'token.with.dots',
    });
  });

  it('rejects credentials without a key id separator', () => {
    expect(() => splitCredential('token-only')).toThrow(/non-empty keyId\.token/);
    expect(() => splitCredential('key-id.')).toThrow(/non-empty keyId\.token/);
  });
});

describe('parseMerchantProjection', () => {
  it('accepts the versioned API projection used by Pair policy', () => {
    expect(parseMerchantProjection(VALID_PROJECTION)).toEqual({
      ok: true,
      projection: VALID_PROJECTION,
    });
  });

  it.each([
    ['non-object body', null],
    ['unknown schema version', { ...VALID_PROJECTION, schema_version: 2 }],
    ['missing session id', { ...VALID_PROJECTION, session_id: undefined }],
    ['blank session id', { ...VALID_PROJECTION, session_id: '   ' }],
    ['missing timestamp', { ...VALID_PROJECTION, created_at: null }],
    ['invalid timestamp', { ...VALID_PROJECTION, created_at: -1 }],
    ['score outside 0-100', { ...VALID_PROJECTION, automation: 101 }],
    ['unknown verdict', { ...VALID_PROJECTION, verdict: 'allow' }],
    ['malformed tags', { ...VALID_PROJECTION, tags: ['vpn', 7] }],
    ['missing browser details', { ...VALID_PROJECTION, identification: {} }],
    [
      'malformed network flag',
      {
        ...VALID_PROJECTION,
        ipInfo: { ...VALID_PROJECTION.ipInfo, vpn: { result: 'yes' } },
      },
    ],
  ])('rejects %s', (_label, body) => {
    expect(parseMerchantProjection(body)).toMatchObject({ ok: false });
  });
});

describe('projection client', () => {
  it('sends the merchant credential and returns a parsed projection', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(VALID_PROJECTION), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(clientFor(fetchMock).fetchProjection('session/a')).resolves.toEqual({
      ok: true,
      projection: VALID_PROJECTION,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/session/argus_cpi_test_1234567890/session%2Fa',
      {
        method: 'GET',
        headers: { 'x-api-key': 'key-id', 'x-argus-token': 'secret.token' },
      }
    );
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'insufficient_credits'],
    [404, 'not_found'],
    [409, 'conflict'],
    [503, 'upstream_error'],
  ] as const)('maps HTTP %s to %s', async (status, reason) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status }));

    await expect(clientFor(fetchMock).fetchProjection('session-1')).resolves.toMatchObject({
      ok: false,
      reason,
      status,
    });
  });

  it('rejects successful JSON with an incompatible contract', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ...VALID_PROJECTION, schema_version: 2 })));

    await expect(clientFor(fetchMock).fetchProjection('session-1')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_projection',
    });
  });

  it('tags invalid JSON independently from a network failure', async () => {
    const invalidJson = vi.fn<typeof fetch>().mockResolvedValue(new Response('{'));
    const networkFailure = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));

    await expect(clientFor(invalidJson).fetchProjection('session-1')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_json',
    });
    await expect(clientFor(networkFailure).fetchProjection('session-1')).resolves.toMatchObject({
      ok: false,
      reason: 'network_error',
    });
  });

  it('fails closed on missing config or a malformed credential', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const missingConfig = createProjectionClient({
      apiUrl: '',
      credential: '',
      cpi: '',
      fetch: fetchMock,
      warn: vi.fn(),
    });
    const malformedCredential = createProjectionClient({
      apiUrl: 'https://api.example.test',
      credential: 'not-split',
      cpi: 'argus_cpi_test_1234567890',
      fetch: fetchMock,
      warn: vi.fn(),
    });

    await expect(missingConfig.fetchProjection('session-1')).resolves.toMatchObject({
      ok: false,
      reason: 'config_missing',
    });
    await expect(malformedCredential.fetchProjection('session-1')).resolves.toMatchObject({
      ok: false,
      reason: 'credential_malformed',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
