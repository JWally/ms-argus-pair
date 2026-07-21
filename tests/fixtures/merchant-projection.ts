import type { MerchantProjection } from '../../cdk/lib/pair-api/merchant-projection.ts';

export function merchantProjection(
  overrides: Partial<MerchantProjection> = {}
): MerchantProjection {
  return {
    schema_version: 1,
    session_id: 'session-fixture',
    created_at: Date.now(),
    automation: 0,
    device_tampering: 0,
    network_tampering: 0,
    verdict: 'clean',
    identification: {
      browserDetails: {
        browserName: 'Chrome',
        browserVersion: '150',
        device: 'desktop',
        os: 'Windows',
        userAgent: 'Mozilla/5.0',
      },
    },
    ip: '203.0.113.10',
    ipLocation: { city: 'Dallas', country: 'US' },
    ipInfo: {
      asn: { organization: 'Example ASN' },
      datacenter: { result: false },
      mobile: { result: false },
      vpn: { result: false },
      hosting: { result: false },
    },
    tags: [],
    worker_scope_evidence: null,
    ...overrides,
  };
}
