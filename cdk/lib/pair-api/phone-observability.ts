import type { OAuthAnnotations, WebAuthnAnnotations } from './proof-of-life';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PHONE_PERF_EVENTS = 32;

function stringField(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberField(value: unknown): number {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : -1;
}

function sessionField(value: unknown): string {
  return typeof value === 'string' && SESSION_ID_RE.test(value.toLowerCase())
    ? value.toLowerCase()
    : 'none';
}

function compactPhonePerfEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {
    event: stringField(event.event).slice(0, 40),
    elapsed_ms: numberField(event.elapsedMs),
  };
  if (Number.isFinite(Number(event.durationMs)))
    compact.duration_ms = numberField(event.durationMs);
  if (typeof event.verdict === 'string') compact.verdict = event.verdict.slice(0, 40);
  if (typeof event.error === 'string') compact.error = event.error.slice(0, 80);
  if (typeof event.proofMode === 'string') compact.proof_mode = event.proofMode.slice(0, 40);
  if (typeof event.trustOnly === 'boolean') compact.trust_only = event.trustOnly;
  return compact;
}

function logPhonePerfBatch({
  body,
  ip,
  userAgent,
}: {
  body: Record<string, unknown>;
  ip: string;
  userAgent?: string;
}): void {
  const events = (body.events as unknown[])
    .slice(0, MAX_PHONE_PERF_EVENTS)
    .map(compactPhonePerfEvent)
    .filter((event): event is Record<string, unknown> => event !== null);
  console.info(
    `[pair] phone_perf_batch reason=${stringField(body.reason).slice(0, 40)} ` +
      `elapsed_ms=${numberField(body.elapsedMs)} event_count=${events.length} ` +
      `session=${sessionField(body.sessionId)} phase=${stringField(body.phase)} ` +
      `path_kind=${stringField(body.pathKind)} ip=${ip || 'unknown'} ` +
      `ua=${(userAgent ?? 'unknown').slice(0, 120).replace(/\s+/g, '_')} ` +
      `events=${JSON.stringify(events)}`
  );
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
  if (Array.isArray(b.events)) {
    logPhonePerfBatch({ body: b, ip, userAgent });
    return;
  }
  const eventName = stringField(b.event);
  const elapsedMs = numberField(b.elapsedMs);
  const durationMs = numberField(b.durationMs);
  const session = sessionField(b.sessionId);
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
