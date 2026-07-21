/**
 * Phone verdict decision contract.
 *
 * This policy must fail closed before persistence or verdict disclosure. The
 * route supplies already-verified proof and projection inputs; this module
 * decides whether those inputs are sufficient to pair.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decidePhoneVerdict } from '../cdk/lib/pair-api/phone-verdict-decision';
import { classifyScan } from '../cdk/lib/pair-api/projection-verdict';
import type { MerchantProjection } from '../cdk/lib/pair-api/merchant-projection';
import { merchantProjection } from './fixtures/merchant-projection';

const NOW = new Date('2026-07-21T19:00:00.000Z');

function phoneProjection(overrides: Partial<MerchantProjection> = {}) {
  return merchantProjection({
    session_id: 'phone-session',
    identification: {
      browserDetails: {
        browserName: 'Chrome',
        browserVersion: '150',
        device: 'mobile',
        os: 'iOS',
        userAgent: 'Mozilla/5.0 (iPhone) Mobile',
      },
    },
    ...overrides,
  });
}

function inputs(overrides: Record<string, unknown> = {}) {
  const desktopProjection = merchantProjection({ session_id: 'desktop-session' });
  const phone = phoneProjection();
  return {
    proofRequired: true,
    proofAnnotations: {
      phone_webauthn_attested: true,
      phone_webauthn_format: 'none',
    },
    desktopProjection,
    phoneProjection: phone,
    desktopScan: classifyScan(desktopProjection, 'desktop'),
    phoneScan: classifyScan(phone, 'phone'),
    hostAnnotations: { host_preflight_bound: true, host_iframe_ip_match: true },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('phone verdict proof and projection gates', () => {
  it('fails proof-required sessions before projection policy', () => {
    const result = decidePhoneVerdict(
      inputs({
        proofAnnotations: {
          phone_webauthn_attested: false,
          phone_webauthn_error: 'missing',
        },
        desktopProjection: null,
        phoneProjection: null,
        desktopScan: null,
        phoneScan: null,
      })
    );

    expect(result).toEqual({
      verdict: 'failed',
      reason: 'no_proof_of_life',
      proofOfLife: false,
      annotations: {
        desktop_projection_present: false,
        phone_projection_present: false,
        phone_webauthn_attested: false,
        phone_webauthn_error: 'missing',
        host_preflight_bound: true,
        host_iframe_ip_match: true,
      },
    });
  });

  it('fails closed when either classified scan is unavailable', () => {
    const result = decidePhoneVerdict(inputs({ phoneScan: null }));

    expect(result).toMatchObject({
      verdict: 'failed',
      reason: 'projection_lookup_failed',
      proofOfLife: true,
      annotations: {
        score_lookup_skipped: true,
        desktop_projection_present: true,
        phone_projection_present: true,
        phone_webauthn_attested: true,
        host_preflight_bound: true,
      },
    });
  });

  it('rejects stale projections and reports their server-observed ages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const staleDesktop = merchantProjection({
      session_id: 'desktop-session',
      created_at: NOW.getTime() - 300_000,
    });
    const phone = phoneProjection({ created_at: NOW.getTime() });
    const result = decidePhoneVerdict(
      inputs({
        desktopProjection: staleDesktop,
        phoneProjection: phone,
        desktopScan: classifyScan(staleDesktop, 'desktop'),
        phoneScan: classifyScan(phone, 'phone'),
      })
    );

    expect(result).toMatchObject({
      verdict: 'failed',
      reason: 'projection_stale',
      proofOfLife: true,
      annotations: {
        desktop_projection_age_sec: 300,
        phone_projection_age_sec: 0,
        freshness_window_sec: 180,
        host_preflight_bound: true,
      },
    });
  });
});

describe('phone verdict computed policy', () => {
  it('allows proof-optional sessions while preserving the negative proof annotation', () => {
    const result = decidePhoneVerdict(
      inputs({
        proofRequired: false,
        proofAnnotations: {
          phone_webauthn_attested: false,
          phone_webauthn_error: 'missing',
        },
      })
    );

    expect(result).toMatchObject({
      verdict: 'paired',
      reason: 'paired_desktop_and_phone',
      proofOfLife: false,
      annotations: {
        proof_of_life: false,
        phone_webauthn_attested: false,
        phone_webauthn_error: 'missing',
        desktop_score: 0,
        phone_score: 0,
        host_iframe_ip_match: true,
      },
    });
  });

  it('preserves computed risk failures and host evidence', () => {
    const desktopProjection = merchantProjection({
      session_id: 'desktop-session',
      tags: ['proxy'],
    });
    const result = decidePhoneVerdict(
      inputs({
        desktopProjection,
        desktopScan: classifyScan(desktopProjection, 'desktop'),
      })
    );

    expect(result).toMatchObject({
      verdict: 'failed',
      reason: 'desktop_on_proxy',
      proofOfLife: true,
      annotations: {
        desktop_is_proxy: true,
        proof_of_life: true,
        host_preflight_bound: true,
      },
    });
  });
});
