import { vi } from 'vitest';
import {
  createWsRouter,
  type BootstrapClaims,
  type Envelope,
  type WsEvent,
  type WsRouterDependencies,
} from '../../cdk/lib/ws-handler/router';

export const NOW = 1_900_000_000;
export const SESSION_ID = '01234567-89ab-cdef-0123-456789abcdef';
export const ALLOWED_ORIGIN = 'https://captcha-dev-jw.argus.pw';

export const claims: Record<'desktop' | 'phone', BootstrapClaims> = {
  desktop: { v: 1, sessionId: SESSION_ID, role: 'desktop', iat: NOW - 1, exp: NOW + 299 },
  phone: { v: 1, sessionId: SESSION_ID, role: 'phone', iat: NOW - 1, exp: NOW + 299 },
};

const claimsByToken = new Map<string, BootstrapClaims>([
  ['desktop-token', claims.desktop],
  ['phone-token', claims.phone],
]);

export function envelope(role: 'desktop' | 'phone', overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    connectionId: `${role}-connection`,
    sessionId: SESSION_ID,
    role,
    ip: '203.0.113.7',
    origin: ALLOWED_ORIGIN,
    iat: NOW - 10,
    ...overrides,
  };
}

function requestContext(connectionId = 'desktop-connection') {
  return {
    routeKey: '$default',
    connectionId,
    domainName: 'ws.example.test',
    stage: 'prod',
    identity: { sourceIp: '198.51.100.9' },
  };
}

export function event(
  action: Record<string, unknown> | string | null,
  overrides: Partial<WsEvent> = {}
): WsEvent {
  return {
    requestContext: requestContext(),
    body:
      typeof action === 'string' ? action : action === null ? undefined : JSON.stringify(action),
    ...overrides,
  };
}

export function createWsHarness(overrides: Partial<WsRouterDependencies> = {}) {
  const openedEnvelopes = new Map<string, Envelope>();
  const sent: Array<{ connectionId: string; data: unknown }> = [];
  const deps: WsRouterDependencies = {
    allowedOrigins: new Set([ALLOWED_ORIGIN]),
    verifyBootstrapToken: vi.fn(async (token: string) => claimsByToken.get(token) ?? null),
    claimRoleConnection: vi.fn(async () => true),
    releaseRoleConnection: vi.fn(async () => undefined),
    sealEnvelope: vi.fn(async (value: Envelope) => {
      const sealed = value.role === 'desktop' ? 'desktop-sealed' : 'phone-sealed';
      openedEnvelopes.set(sealed, value);
      return sealed;
    }),
    openEnvelope: vi.fn(async (sealed: string) => openedEnvelopes.get(sealed) ?? null),
    ensureMessageStateAvailable: vi.fn(),
    markPhoneChallenge: vi.fn(async () => undefined),
    markPhoneDone: vi.fn(async () => undefined),
    getVerdictRevealKey: vi.fn(async () => 'reveal-key'),
    sendToConnection: vi.fn(async (_event: WsEvent, connectionId: string, data: unknown) => {
      sent.push({ connectionId, data });
    }),
    nowEpochSeconds: () => NOW,
    logInfo: vi.fn(),
    ...overrides,
  };
  return { route: createWsRouter(deps), deps, openedEnvelopes, sent };
}

export function messageEvent(
  connectionId: string,
  me: string,
  peer: string,
  data: unknown = { kind: 'desktop-ready' }
): WsEvent {
  return event(
    { action: 'message', me, peer, data },
    { requestContext: requestContext(connectionId) }
  );
}
