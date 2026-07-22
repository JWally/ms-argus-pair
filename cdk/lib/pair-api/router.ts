import { getViewerIp, jsonResp, parseBody } from './shared/http';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_LESS_ROUTES = new Set([
  'POST /api/session/start',
  'POST /api/sso/start',
  'POST /api/sso/approval/redeem',
  'POST /api/sso/approval/exchange',
  'POST /api/verify',
  'POST /api/pair-token/redeem',
  'POST /api/phone-perf',
  'POST /api/sso/telemetry',
]);

export interface PairApiEvent {
  routeKey: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  requestContext?: { http?: { sourceIp?: string }; identity?: { sourceIp?: string } };
}

export interface PairApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface PublicPairSession {
  expiresAt: number;
  desktopAttestation?: unknown;
  verdict: string;
}

type MaybePromise<T> = T | Promise<T>;
type Body = Record<string, unknown>;

export interface PairApiRouterDependencies {
  allowOrigin(event: PairApiEvent): boolean;
  handleTelemetry(routeKey: string, body: Body, event: PairApiEvent): PairApiResponse | null;
  startPairSession(body: Body, viewerIp: string): MaybePromise<PairApiResponse>;
  startSsoSession(body: Body): MaybePromise<PairApiResponse>;
  challengeSsoSession(sessionId: string, body: Body): MaybePromise<PairApiResponse>;
  validateSsoSession(
    sessionId: string,
    body: Body,
    viewerIp: string
  ): MaybePromise<PairApiResponse>;
  redeemSsoApproval(body: Body, cookies?: string[]): MaybePromise<PairApiResponse>;
  exchangeSsoApproval(body: Body): MaybePromise<PairApiResponse>;
  loadSession(sessionId: string): Promise<PublicPairSession | null>;
  attestDesktop(body: Body, sessionId: string): MaybePromise<PairApiResponse>;
  attestPhone(body: Body, sessionId: string, viewerIp: string): MaybePromise<PairApiResponse>;
  getSessionResult(event: PairApiEvent, sessionId: string): MaybePromise<PairApiResponse>;
  mintPairToken(event: PairApiEvent, sessionId: string, body: Body): MaybePromise<PairApiResponse>;
  redeemPairToken(token: string): Promise<unknown | null>;
  mintVerdictToken(event: PairApiEvent, sessionId: string): MaybePromise<PairApiResponse>;
  verifyVerdict(body: Body): MaybePromise<PairApiResponse>;
}

interface RouteContext {
  event: PairApiEvent;
  body: Body;
  sessionId: string;
  viewerIp: string;
}

type RouteHandler = () => MaybePromise<PairApiResponse>;

function publicSessionResponse(session: PublicPairSession | null): PairApiResponse {
  if (!session) return jsonResp(200, { expired: true });
  return jsonResp(200, {
    expiresAt: session.expiresAt,
    desktopReady: Boolean(session.desktopAttestation),
    verdict: session.verdict,
  });
}

async function redeemShortPairToken(
  body: Body,
  redeem: PairApiRouterDependencies['redeemPairToken']
): Promise<PairApiResponse> {
  if (typeof body.token !== 'string') return jsonResp(400, { error: 'missing_token' });
  const blob = await redeem(body.token);
  if (!blob) return jsonResp(410, { error: 'token_expired_or_used' });
  return jsonResp(200, blob);
}

function buildRouteTable(
  dependencies: PairApiRouterDependencies,
  context: RouteContext
): Map<string, RouteHandler> {
  const { body, event, sessionId, viewerIp } = context;
  return new Map([
    ['POST /api/session/start', () => dependencies.startPairSession(body, viewerIp)],
    ['POST /api/sso/start', () => dependencies.startSsoSession(body)],
    ['POST /api/sso/{id}/challenge', () => dependencies.challengeSsoSession(sessionId, body)],
    [
      'POST /api/sso/{id}/validate',
      () => dependencies.validateSsoSession(sessionId, body, viewerIp),
    ],
    ['POST /api/sso/approval/redeem', () => dependencies.redeemSsoApproval(body, event.cookies)],
    ['POST /api/sso/approval/exchange', () => dependencies.exchangeSsoApproval(body)],
    [
      'GET /api/session/{id}/info',
      async () => publicSessionResponse(await dependencies.loadSession(sessionId)),
    ],
    ['POST /api/session/{id}/desktop-attest', () => dependencies.attestDesktop(body, sessionId)],
    [
      'POST /api/session/{id}/phone-attest',
      () => dependencies.attestPhone(body, sessionId, viewerIp),
    ],
    ['GET /api/session/{id}/result', () => dependencies.getSessionResult(event, sessionId)],
    ['POST /api/session/{id}/pair-token', () => dependencies.mintPairToken(event, sessionId, body)],
    ['POST /api/pair-token/redeem', () => redeemShortPairToken(body, dependencies.redeemPairToken)],
    ['GET /api/session/{id}/verdict-token', () => dependencies.mintVerdictToken(event, sessionId)],
    ['POST /api/verify', () => dependencies.verifyVerdict(body)],
  ]);
}

export function createPairApiRouter(dependencies: PairApiRouterDependencies) {
  return async (event: PairApiEvent): Promise<PairApiResponse> => {
    if (!dependencies.allowOrigin(event)) {
      return jsonResp(403, { error: 'origin_not_allowed' });
    }

    const routeKey = event.routeKey;
    const sessionId = event.pathParameters?.id?.toLowerCase() ?? '';
    if (!ID_LESS_ROUTES.has(routeKey) && !SESSION_ID_RE.test(sessionId)) {
      return jsonResp(400, { error: 'invalid_session_id' });
    }

    const body = parseBody(event.body);
    if (body === null) return jsonResp(400, { error: 'invalid_body' });
    const telemetryResponse = dependencies.handleTelemetry(routeKey, body, event);
    if (telemetryResponse) return telemetryResponse;

    const handler = buildRouteTable(dependencies, {
      event,
      body,
      sessionId,
      viewerIp: getViewerIp(event),
    }).get(routeKey);
    if (handler) return handler();
    return jsonResp(200, { error: 'no_matching_route', routeKey });
  };
}
