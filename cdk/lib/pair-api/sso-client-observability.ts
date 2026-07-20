const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_FIELD_RE = /[^A-Za-z0-9_-]/g;

function safeField(value: unknown, fallback = 'unknown', maxLength = 48): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.replace(SAFE_FIELD_RE, '_').slice(0, maxLength);
}

function sessionField(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value.toLowerCase())) return 'none';
  return value.toLowerCase();
}

function elapsedField(value: unknown): number {
  const elapsedMs = Number(value);
  if (!Number.isFinite(elapsedMs)) return -1;
  return Math.max(0, Math.min(120_000, Math.round(elapsedMs)));
}

export function logSsoClientEvent({
  body,
  ip,
  userAgent,
}: {
  body: unknown;
  ip: string;
  userAgent?: string;
}): void {
  if (!body || typeof body !== 'object') return;
  const event = body as Record<string, unknown>;
  console.info(
    `[pair] sso_client stage=${safeField(event.stage)} event=${safeField(event.event)} ` +
      `outcome=${safeField(event.outcome)} elapsed_ms=${elapsedField(event.elapsedMs)} ` +
      `session=${sessionField(event.sessionId)} error=${safeField(event.error, 'none', 64)} ` +
      `ip=${ip || 'unknown'} ` +
      `ua=${(userAgent ?? 'unknown').slice(0, 120).replace(/\s+/g, '_')}`
  );
}
