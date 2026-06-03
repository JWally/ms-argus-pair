/**
 * Cross-cutting HTTP plumbing for the pair Lambda. Used by every
 * endpoint handler; depends on nothing from the app domain. Kept
 * deliberately small — if the urge arises to put something here
 * because "two endpoints use it," that's how shared/util/ becomes
 * the next pair-api.ts. Reach for a feature-slice sibling first.
 */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const MAX_BODY_BYTES = 16 * 1024;

/** Build a JSON response with cache-defeating headers. */
export function jsonResp(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Origin check. Allow when no allowlist is configured (dev) OR when
 * the request Origin matches. Same-origin GET requests in some
 * browsers (Chrome) omit the Origin header entirely; rejecting on
 * missing Origin would block legitimate polling from the SPA, and
 * CloudFront would then rewrite the 403 to the SPA HTML (its
 * errorResponses[403] mapping for client-side routing) — which the
 * JSON parser blows up on. So: allow if Origin is absent, reject only
 * when it's explicitly wrong. CORS preflight handles the rest.
 */
export function originAllowed(event: { headers?: Record<string, string | undefined> }): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const o = event.headers?.origin || event.headers?.Origin;
  if (!o) return true;
  return ALLOWED_ORIGINS.includes(o);
}

/**
 * Parse a JSON request body with a size cap. Returns null on parse
 * failure or oversize; returns {} on missing body. Returns an empty
 * object — not null — so callers can treat missing-body as "no
 * fields" without an extra null-check.
 */
export function parseBody(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return {};
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract the viewer's source IP from the API Gateway event. Prefers
 * the CloudFront `cloudfront-viewer-address` header (which we
 * configured CloudFront to inject; survives the API Gateway hop
 * unlike `x-forwarded-for`), then falls back to API Gateway's
 * native `requestContext.http.sourceIp` (HTTP API) or
 * `requestContext.identity.sourceIp` (REST API).
 *
 * The CloudFront header carries `<ip>:<port>` or `[<ipv6>]:<port>` —
 * strip the port before returning.
 */
export function getViewerIp(event: {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { sourceIp?: string }; identity?: { sourceIp?: string } };
}): string {
  const headers = event.headers || {};
  const raw = headers['cloudfront-viewer-address'] || headers['CloudFront-Viewer-Address'] || '';
  if (raw) {
    // IPv6: "[2001:db8::1]:12345"
    if (raw.startsWith('[')) {
      const close = raw.indexOf(']');
      if (close > 0) return raw.slice(1, close);
    }
    // IPv4: "1.2.3.4:54321"
    const lastColon = raw.lastIndexOf(':');
    if (lastColon > 0) return raw.slice(0, lastColon);
    return raw;
  }
  return event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp ?? '';
}
