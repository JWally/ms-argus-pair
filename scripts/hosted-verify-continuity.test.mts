#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  evaluateHostedRedirectContinuity,
  type HostedRedirectObservation,
} from '../cdk/lib/hosted-verify/continuity';

function mobile(overrides: Partial<HostedRedirectObservation> = {}): HostedRedirectObservation {
  return {
    argusSessionId: 'argus_mobile_leg',
    osFamily: 'iOS',
    osVersionMajor: 18,
    browserFamily: 'Mobile Safari',
    browserVersionMajor: 18,
    mobileClass: 'phone',
    userAgentPlatform: 'iPhone',
    touchPoints: 5,
    screenBucket: '390x844@3',
    timezone: 'America/Chicago',
    localePrimary: 'en-US',
    ip: '203.0.113.10',
    asn: 'AS7018',
    webRtc: {
      present: true,
      candidateTypes: ['host', 'srflx'],
      udpSupported: true,
      mdnsHostCandidate: true,
    },
    ...overrides,
  };
}

function verdict(
  merchant: Partial<HostedRedirectObservation>,
  hosted: Partial<HostedRedirectObservation>
) {
  return evaluateHostedRedirectContinuity({
    merchant: mobile(merchant),
    hosted: mobile({ argusSessionId: 'argus_hosted_leg', ...hosted }),
  });
}

{
  const result = verdict({}, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
}

{
  const result = verdict({ mobileClass: 'desktop', userAgentPlatform: 'MacIntel' }, {});
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /merchant_not_supported_phone/);
}

{
  const result = verdict({}, { osFamily: 'Android', userAgentPlatform: 'Linux armv8l' });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /os_family_drift/);
}

{
  const result = verdict({}, { browserFamily: 'Chrome' });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /browser_family_drift/);
}

{
  const result = verdict({}, { webRtc: { present: false } });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /hosted_webrtc_missing/);
}

{
  const result = verdict(
    { webRtc: { present: true, candidateTypes: ['host'], udpSupported: true } },
    { webRtc: { present: true, candidateTypes: [], udpSupported: false } }
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /webrtc_candidate_type_drift/);
  assert.match(result.reasons.join(','), /webrtc_udp_drift/);
}

{
  const result = verdict({}, { timezone: 'Europe/London' });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /timezone_drift/);
}

{
  const result = verdict({}, { ip: '198.51.100.55' });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(','), /ip_drift/);
}

console.log('hosted-verify-continuity: ok');
