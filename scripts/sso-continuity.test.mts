#!/usr/bin/env tsx
import {
  evaluateSsoContinuity,
  mintReturnCode,
  consumeReturnCode,
  type SsoLegProfile,
} from '../cdk/lib/sso-continuity';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`sso-continuity: ${message}`);
    process.exitCode = 1;
  }
}

const baseLeg: SsoLegProfile = {
  argusSessionId: 'argus_start',
  keyId: 'device_key_1',
  ip: '203.0.113.24',
  asnName: 'Verizon Wireless',
  country: 'US',
  city: 'Austin',
  score: 12,
  isPhone: true,
  isProxy: false,
  isDatacenter: false,
  isVpn: false,
};

const goodChallenge: SsoLegProfile = {
  ...baseLeg,
  argusSessionId: 'argus_challenge',
  ip: '203.0.113.88',
  score: 16,
};

const goodReturn: SsoLegProfile = {
  ...baseLeg,
  argusSessionId: 'argus_return',
  ip: '203.0.113.122',
  score: 15,
};

const good = evaluateSsoContinuity({
  start: baseLeg,
  challenge: goodChallenge,
  validate: goodReturn,
});
assert(good.ok, `expected same device on nearby network to pass, got ${good.reason}`);
assert(good.reasons.includes('phone_classified'), 'passing verdict should record phone classification');
assert(good.reasons.includes('device_key_match'), 'passing verdict should record device key match');

const desktopLeg = evaluateSsoContinuity({
  start: baseLeg,
  challenge: { ...goodChallenge, isPhone: false },
  validate: goodReturn,
});
assert(!desktopLeg.ok, 'desktop-classified SSO leg must fail');
assert(desktopLeg.reason === 'not_phone', `expected not_phone, got ${desktopLeg.reason}`);

const deviceSwap = evaluateSsoContinuity({
  start: baseLeg,
  challenge: { ...goodChallenge, keyId: 'device_key_2' },
  validate: goodReturn,
});
assert(!deviceSwap.ok, 'device key swap between merchant and challenge must fail');
assert(deviceSwap.reason === 'device_changed', `expected device_changed, got ${deviceSwap.reason}`);

const networkJump = evaluateSsoContinuity({
  start: baseLeg,
  challenge: goodChallenge,
  validate: { ...goodReturn, ip: '198.51.100.10', asnName: 'OVH SAS', isDatacenter: true },
});
assert(!networkJump.ok, 'datacenter/network jump on return leg must fail');
assert(
  networkJump.reason === 'network_changed',
  `expected network_changed, got ${networkJump.reason}`
);

const invalidIpv4 = evaluateSsoContinuity({
  start: { ...baseLeg, asnName: 'Carrier A', ip: '999.0.113.24' },
  challenge: { ...goodChallenge, asnName: 'Carrier B', ip: '999.0.113.88' },
  validate: { ...goodReturn, asnName: 'Carrier C', ip: '999.0.113.122' },
});
assert(!invalidIpv4.ok, 'invalid IPv4 octets must not pass as a shared /24');
assert(invalidIpv4.reason === 'network_changed', `expected network_changed, got ${invalidIpv4.reason}`);

const code = mintReturnCode({ sessionId: 'sso_123', ttlSeconds: 60 });
assert(code.value.startsWith('sso_'), 'return code should be namespaced for SSO');
assert(consumeReturnCode(code, Date.now()).ok, 'fresh return code should be consumable');
assert(!consumeReturnCode(code, Date.now()).ok, 'return code must be single-use');

if (process.exitCode) process.exit(process.exitCode);
console.log('sso-continuity: ok');
