import type { OAuthAnnotations, WebAuthnAnnotations } from './proof-of-life';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stringField(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isWebAuthnAuthenticationInput(webauthn: unknown): boolean {
  const response =
    webauthn && typeof webauthn === 'object'
      ? (webauthn as { response?: Record<string, unknown> }).response
      : null;
  return typeof response?.signature === 'string' && typeof response?.authenticatorData === 'string';
}

export function proofModeForLog({
  trustRedeemed,
  oauthInput,
  webauthnInput,
  annotations,
}: {
  trustRedeemed: boolean;
  oauthInput: unknown;
  webauthnInput: unknown;
  annotations: WebAuthnAnnotations | OAuthAnnotations;
}): string {
  if (trustRedeemed) return 'device_trust_redeem';
  if ('phone_oauth_provider' in annotations && annotations.phone_oauth_provider) {
    return `oauth_${annotations.phone_oauth_provider}`;
  }
  if (oauthInput) return 'oauth_attempt';
  if (annotations.phone_webauthn_format === 'passkey_authentication') {
    return 'passkey_authentication';
  }
  if (webauthnInput) {
    return isWebAuthnAuthenticationInput(webauthnInput)
      ? 'passkey_authentication'
      : 'passkey_registration';
  }
  return 'missing';
}

export function logPhonePerfEvent({
  body,
  ip,
  userAgent,
}: {
  body: unknown;
  ip: string;
  userAgent?: string;
}): void {
  if (!body || typeof body !== 'object') return;
  const b = body as Record<string, unknown>;
  const eventName = stringField(b.event);
  const elapsedMs = Number.isFinite(Number(b.elapsedMs)) ? Math.round(Number(b.elapsedMs)) : -1;
  const durationMs = Number.isFinite(Number(b.durationMs)) ? Math.round(Number(b.durationMs)) : -1;
  const session =
    typeof b.sessionId === 'string' && SESSION_ID_RE.test(b.sessionId.toLowerCase())
      ? b.sessionId.toLowerCase()
      : 'none';
  console.info(
    `[pair] phone_perf event=${eventName} elapsed_ms=${elapsedMs} ` +
      `duration_ms=${durationMs} session=${session} phase=${stringField(b.phase)} ` +
      `path_kind=${stringField(b.pathKind)} has_trust=${b.hasTrust === true} ` +
      `trust_checked=${b.trustChecked === true} desktop_ready=${b.desktopReady === true} ` +
      `attested=${b.attested === true} verdict=${stringField(b.verdict, 'none')} ` +
      `trust_only=${b.trustOnly === true} ip=${ip || 'unknown'} ` +
      `ua=${(userAgent ?? 'unknown').slice(0, 120).replace(/\s+/g, '_')}`
  );
}
