import { logPhonePerfEvent } from './phone-observability';
import { getViewerIp, noContentResp } from './shared/http';
import { logSsoClientEvent } from './sso-client-observability';

interface TelemetryEvent {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { sourceIp?: string }; identity?: { sourceIp?: string } };
}

/** Dispatch bounded, best-effort client diagnostics outside the main router. */
export function handleTelemetryRoute(
  routeKey: string,
  body: Record<string, unknown>,
  event: TelemetryEvent
) {
  const input = {
    body,
    ip: getViewerIp(event),
    userAgent: event.headers?.['user-agent'] ?? event.headers?.['User-Agent'],
  };
  if (routeKey === 'POST /api/sso/telemetry') logSsoClientEvent(input);
  else if (routeKey === 'POST /api/phone-perf') logPhonePerfEvent(input);
  else return null;
  return noContentResp();
}
