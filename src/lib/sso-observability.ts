const SSO_TELEMETRY_URL = '/api/sso/telemetry';

interface SsoClientEvent {
  stage: string;
  event: string;
  outcome: 'started' | 'completed' | 'failed';
  elapsedMs: number;
  sessionId?: string;
  error?: string;
}

function sendSsoClientEvent(event: SsoClientEvent): void {
  const body = JSON.stringify(event);
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(SSO_TELEMETRY_URL, body)) {
      return;
    }
  } catch {
    // Telemetry is best-effort and must never become a flow dependency.
  }
  void fetch(SSO_TELEMETRY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

export async function withSsoClientStage<T>(
  stage: string,
  event: string,
  sessionId: string | null,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const common = { stage, event, ...(sessionId ? { sessionId } : {}) };
  sendSsoClientEvent({ ...common, outcome: 'started', elapsedMs: 0 });
  try {
    const value = await operation();
    sendSsoClientEvent({
      ...common,
      outcome: 'completed',
      elapsedMs: Date.now() - startedAt,
    });
    return value;
  } catch (cause) {
    sendSsoClientEvent({
      ...common,
      outcome: 'failed',
      elapsedMs: Date.now() - startedAt,
      error: cause instanceof Error ? cause.name : 'UnknownError',
    });
    throw cause;
  }
}
