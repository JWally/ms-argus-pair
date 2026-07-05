import { describe, expect, it } from 'vitest';
import {
  classifyScan,
  computeVerdict,
  isProjectionFresh,
  summarizeDesktopScan,
  type ClassifiedScan,
  type MerchantProjection,
} from '../cdk/lib/pair-api/projection-verdict.ts';

function scan(overrides: Partial<ClassifiedScan> = {}): ClassifiedScan {
  return {
    individualScore: 0,
    isPhone: false,
    isDatacenter: false,
    isProxy: false,
    patAttested: false,
    ok: true,
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
    ...overrides,
  };
}

describe('projection verdict', () => {
  it('classifies mobile projections from browser details and UA', () => {
    const projection: MerchantProjection = {
      verdict: 'PASS',
      automation: 2,
      device_tampering: 3,
      network_tampering: 4,
      identification: {
        browserDetails: {
          device: 'mobile',
          os: 'iOS',
        },
      },
    };

    expect(classifyScan(projection, 'phone')).toMatchObject({
      individualScore: 4,
      isPhone: true,
      ok: true,
    });
  });

  it('preserves verdict reason strings used by the API contract', () => {
    expect(computeVerdict(scan({ isProxy: true }), scan({ isPhone: true })).reason).toBe(
      'desktop_on_proxy'
    );
    expect(computeVerdict(scan(), scan({ isPhone: true, isDatacenter: true })).reason).toBe(
      'phone_on_datacenter'
    );
    expect(computeVerdict(scan(), scan()).reason).toBe('both_sides_desktop');
    expect(computeVerdict(scan(), scan({ isPhone: true })).reason).toBe('paired_desktop_and_phone');
    expect(computeVerdict(scan({ isPhone: true }), scan({ isPhone: true })).reason).toBe(
      'paired_phone_to_phone'
    );
  });

  it('summarizes the optimistic desktop clean hint', () => {
    expect(summarizeDesktopScan(scan({ patAttested: true })).clean).toBe(true);
    expect(summarizeDesktopScan(scan({ patAttested: true, isDatacenter: true })).clean).toBe(false);
  });

  it('requires fresh created_at timestamps', () => {
    expect(isProjectionFresh({ created_at: Date.now() })).toBe(true);
    expect(isProjectionFresh({ created_at: Date.now() - 300_000 })).toBe(false);
    expect(isProjectionFresh({})).toBe(false);
  });
});
