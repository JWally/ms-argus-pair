import { describe, expect, it } from 'vitest';
import {
  applyBraveSharedWorkerPolicy,
  type BraveSharedWorkerPolicyInput,
} from '../cdk/lib/pair-api/brave-shared-worker-policy.ts';
import type { ClassifiedScan, MerchantProjection } from '../cdk/lib/pair-api/projection-verdict.ts';

function projection(overrides: Partial<MerchantProjection> = {}): MerchantProjection {
  return {
    automation: 0,
    device_tampering: 0,
    network_tampering: 0,
    verdict: 'clean',
    created_at: Date.now(),
    worker_scope_evidence: {
      all_scopes_consistent: true,
      main_web_consensus_id: 'consensus-1',
      shared_partition_candidate: false,
      brave_detected: true,
      device_tampering_without_worker: 0,
    },
    ...overrides,
  };
}

function scan(individualScore: number, overrides: Partial<ClassifiedScan> = {}): ClassifiedScan {
  return {
    individualScore,
    isPhone: false,
    isDatacenter: false,
    isProxy: false,
    patAttested: false,
    ok: individualScore < 30,
    browserName: 'Chrome',
    browserVersion: '148 Brave',
    os: 'Linux',
    ip: '107.210.133.127',
    ua: 'Brave Chromium',
    asnName: 'AT&T Services',
    city: 'Dallas',
    country: 'US',
    isMobileNetwork: false,
    isVpn: false,
    ...overrides,
  };
}

function eligibleInput(): BraveSharedWorkerPolicyInput {
  return {
    hostProjection: projection(),
    hostScan: scan(0),
    iframeProjection: projection({
      automation: 20,
      device_tampering: 100,
      verdict: 'block',
      worker_scope_evidence: {
        all_scopes_consistent: false,
        main_web_consensus_id: 'consensus-1',
        shared_partition_candidate: true,
        brave_detected: true,
        device_tampering_without_worker: 0,
      },
    }),
    iframeScan: scan(100, { ok: false }),
  };
}

describe('applyBraveSharedWorkerPolicy', () => {
  it('uses the inner main/web consensus for the exact Brave iframe artifact', () => {
    const input = eligibleInput();
    input.hostProjection = null;
    input.hostScan = null;
    const result = applyBraveSharedWorkerPolicy(input);

    expect(result.effectiveIframeScan).toMatchObject({
      individualScore: 20,
      ok: true,
    });
    expect(result.annotations).toMatchObject({
      brave_shared_worker_adjusted: true,
      brave_shared_worker_basis: 'inner_main_web_consensus',
      iframe_raw_score: 100,
      iframe_effective_score: 20,
    });
  });

  it.each([
    [
      'iframe divergence is not the allowlisted shared-only shape',
      (i: BraveSharedWorkerPolicyInput) => {
        i.iframeProjection!.worker_scope_evidence!.shared_partition_candidate = false;
      },
    ],
    [
      'Brave is not positively identified inside',
      (i: BraveSharedWorkerPolicyInput) => {
        i.iframeProjection!.worker_scope_evidence!.brave_detected = false;
      },
    ],
    [
      'main and dedicated worker have no stable consensus',
      (i: BraveSharedWorkerPolicyInput) => {
        i.iframeProjection!.worker_scope_evidence!.main_web_consensus_id = null;
      },
    ],
    [
      'other iframe tampering remains',
      (i: BraveSharedWorkerPolicyInput) => {
        i.iframeProjection!.worker_scope_evidence!.device_tampering_without_worker = 60;
      },
    ],
    [
      'other iframe automation is suspect',
      (i: BraveSharedWorkerPolicyInput) => {
        i.iframeProjection!.automation = 30;
      },
    ],
    [
      'other iframe network evidence is suspect',
      (i: BraveSharedWorkerPolicyInput) => {
        i.iframeProjection!.network_tampering = 30;
      },
    ],
    [
      'iframe projection is stale',
      (i: BraveSharedWorkerPolicyInput) => {
        i.iframeProjection!.created_at = Date.now() - 10 * 60 * 1000;
      },
    ],
  ])('keeps the raw block when %s', (_name, mutate) => {
    const input = eligibleInput();
    input.hostProjection = null;
    input.hostScan = null;
    mutate(input);

    const result = applyBraveSharedWorkerPolicy(input);

    expect(result.effectiveIframeScan?.individualScore).toBe(100);
    expect(result.annotations.brave_shared_worker_adjusted).toBe(false);
  });
});
