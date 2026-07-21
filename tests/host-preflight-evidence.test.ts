import { describe, expect, it } from 'vitest';
import {
  buildHostPreflightEvidence,
  type HostPreflightEvidenceInput,
} from '../cdk/lib/pair-api/host-preflight-evidence.ts';
import type { ClassifiedScan } from '../cdk/lib/pair-api/projection-verdict.ts';
import type { MerchantProjection } from '../cdk/lib/pair-api/merchant-projection.ts';
import { merchantProjection } from './fixtures/merchant-projection.ts';

function scan(overrides: Partial<ClassifiedScan> = {}): ClassifiedScan {
  return {
    individualScore: 3,
    isPhone: false,
    isDatacenter: false,
    isProxy: false,
    patAttested: false,
    browserName: 'Chrome',
    browserVersion: '126',
    os: 'Linux',
    ip: '203.0.113.10',
    ua: 'Mozilla/5.0',
    asnName: 'Example ASN',
    city: 'Dallas',
    country: 'US',
    isMobileNetwork: false,
    isVpn: false,
    isIsolatedLocationMismatch: false,
    ...overrides,
  };
}

function projection(overrides: Partial<MerchantProjection> = {}): MerchantProjection {
  return merchantProjection({
    automation: 1,
    device_tampering: 2,
    network_tampering: 3,
    ...overrides,
  });
}

describe('buildHostPreflightEvidence', () => {
  it('records that direct embeds did not supply a host preflight', () => {
    expect(
      buildHostPreflightEvidence({
        bound: false,
        hostProjection: null,
        hostScan: null,
        iframeProjection: projection(),
        iframeScan: scan(),
      })
    ).toEqual({ host_preflight_bound: false });
  });

  it('compares host and iframe observations without producing a verdict', () => {
    const input: HostPreflightEvidenceInput = {
      bound: true,
      hostProjection: projection(),
      hostScan: scan(),
      iframeProjection: projection({ automation: 8 }),
      iframeScan: scan({ individualScore: 8 }),
    };

    expect(buildHostPreflightEvidence(input)).toMatchObject({
      host_preflight_bound: true,
      host_projection_present: true,
      host_projection_fresh: true,
      host_score: 3,
      iframe_score: 8,
      host_iframe_ip_match: true,
      host_iframe_browser_match: true,
      host_iframe_os_match: true,
      host_automation: 1,
      iframe_automation: 8,
    });
    expect(buildHostPreflightEvidence(input)).not.toHaveProperty('verdict');
    expect(buildHostPreflightEvidence(input)).not.toHaveProperty('reason');
  });
});
