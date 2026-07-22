export type PairRole = 'desktop' | 'phone';

export interface BootstrapClaims {
  v: 1;
  sessionId: string;
  role: PairRole;
  iat: number;
  exp: number;
}

export interface Envelope {
  v: 1;
  connectionId: string;
  sessionId: string;
  role: PairRole;
  ip: string;
  origin: string;
  iat: number;
  publicKey?: string;
}

export interface WsEvent {
  requestContext: {
    routeKey: string;
    connectionId: string;
    domainName: string;
    stage: string;
    identity?: { sourceIp?: string };
  };
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string;
}

export interface WsResponse {
  statusCode: number;
  body?: string;
}

export interface WsRouterDependencies {
  allowedOrigins: ReadonlySet<string>;
  verifyBootstrapToken(token: string): Promise<BootstrapClaims | null>;
  claimRoleConnection(claims: BootstrapClaims, connectionId: string): Promise<boolean>;
  releaseRoleConnection(connectionId: string): Promise<void>;
  sealEnvelope(envelope: Envelope): Promise<string>;
  openEnvelope(blob: string): Promise<Envelope | null>;
  ensureMessageStateAvailable(): void;
  markPhoneChallenge(sessionId: string, challenge: boolean, expiresAt: number): Promise<void>;
  markPhoneDone(sessionId: string, expiresAt: number): Promise<void>;
  getVerdictRevealKey(sessionId: string): Promise<string>;
  sendToConnection(event: WsEvent, connectionId: string, data: unknown): Promise<void>;
  nowEpochSeconds(): number;
  logInfo(message: string): void;
}

type WsActionBody = { action?: string } & Record<string, unknown>;

const ENVELOPE_MAX_AGE_SECONDS = 60 * 60;
const VERDICT_MARKER_TTL_SECONDS = 6 * 60;

function ok(): WsResponse {
  return { statusCode: 200 };
}

function bad(deps: WsRouterDependencies, body: string): WsResponse {
  deps.logInfo(`[ws] bad: ${body}`);
  return { statusCode: 400, body };
}

function parseActionBody(event: WsEvent): WsActionBody | null {
  if (!event.body) return {};
  try {
    const parsed: unknown = JSON.parse(event.body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as WsActionBody)
      : {};
  } catch {
    return null;
  }
}

async function handleWhoami(
  event: WsEvent,
  body: WsActionBody,
  deps: WsRouterDependencies
): Promise<WsResponse> {
  if (typeof body.token !== 'string') return bad(deps, 'missing_token');
  const claims = await deps.verifyBootstrapToken(body.token);
  if (!claims) return bad(deps, 'invalid_token');
  const origin = typeof body.origin === 'string' ? body.origin : '';
  if (!deps.allowedOrigins.has(origin)) return bad(deps, 'origin_not_allowed');
  if (!(await deps.claimRoleConnection(claims, event.requestContext.connectionId))) {
    return bad(deps, 'role_already_connected');
  }

  const envelope: Envelope = {
    v: 1,
    connectionId: event.requestContext.connectionId,
    sessionId: claims.sessionId,
    role: claims.role,
    ip: event.requestContext.identity?.sourceIp ?? '',
    origin,
    iat: deps.nowEpochSeconds(),
    publicKey: typeof body.publicKey === 'string' ? body.publicKey : undefined,
  };
  const sealedEnvelope = await deps.sealEnvelope(envelope);
  await deps.sendToConnection(event, event.requestContext.connectionId, {
    action: 'whoami',
    envelope: sealedEnvelope,
    sessionId: claims.sessionId,
    role: claims.role,
  });
  return ok();
}

async function recordVerdictSignal(
  sender: Envelope,
  dataKind: unknown,
  data: unknown,
  now: number,
  deps: WsRouterDependencies
): Promise<boolean> {
  if (sender.role !== 'phone') return false;
  const expiresAt = now + VERDICT_MARKER_TTL_SECONDS;
  if (dataKind === 'phone-here') {
    const challenge = (data as { challenge?: unknown }).challenge === true;
    await deps.markPhoneChallenge(sender.sessionId, challenge, expiresAt);
    return false;
  }
  if (dataKind !== 'phone-done') return false;
  await deps.markPhoneDone(sender.sessionId, expiresAt);
  return true;
}

async function sendVerdictRelease(
  event: WsEvent,
  phone: Envelope,
  desktop: Envelope,
  deps: WsRouterDependencies
): Promise<void> {
  const revealKey = await deps.getVerdictRevealKey(phone.sessionId);
  const release = {
    action: 'message',
    from: 'server',
    sessionId: phone.sessionId,
    data: { kind: 'verdict-release', revealKey },
  };
  await Promise.all([
    deps.sendToConnection(event, desktop.connectionId, release),
    deps.sendToConnection(event, phone.connectionId, release),
  ]);
}

function dataKind(data: unknown): unknown {
  return data && typeof data === 'object' && 'kind' in data
    ? (data as { kind?: unknown }).kind
    : null;
}

function validateRelay(
  event: WsEvent,
  sender: Envelope,
  peer: Envelope,
  now: number
): string | null {
  // The transport connection must own the presented sender envelope. This is
  // the server-side identity check when both sealed envelopes have leaked.
  if (sender.connectionId !== event.requestContext.connectionId) {
    return 'envelope_connection_mismatch';
  }
  if (sender.sessionId !== peer.sessionId) return 'cross_session';
  // Origins can differ because the desktop may use an alias while the phone
  // uses the canonical WebAuthn host. Each origin was allowlisted at whoami;
  // the signed session ID is the relay boundary.
  if (sender.role === peer.role) return 'same_role';
  if (now - sender.iat > ENVELOPE_MAX_AGE_SECONDS || now - peer.iat > ENVELOPE_MAX_AGE_SECONDS) {
    return 'envelope_expired';
  }
  return null;
}

async function handleMessage(
  event: WsEvent,
  body: WsActionBody,
  deps: WsRouterDependencies
): Promise<WsResponse> {
  deps.ensureMessageStateAvailable();
  if (typeof body.me !== 'string' || typeof body.peer !== 'string') {
    return bad(deps, 'missing_envelopes');
  }
  const [sender, peer] = await Promise.all([
    deps.openEnvelope(body.me),
    deps.openEnvelope(body.peer),
  ]);
  if (!sender || !peer) return bad(deps, 'invalid_envelope');

  const now = deps.nowEpochSeconds();
  const relayError = validateRelay(event, sender, peer, now);
  if (relayError) return bad(deps, relayError);

  const kind = dataKind(body.data);
  const shouldRelease = await recordVerdictSignal(sender, kind, body.data, now, deps);
  deps.logInfo(
    `[ws] relay from=${sender.role} to=${peer.role} session=${sender.sessionId} ` +
      `kind=${String(kind)} peerCid=${peer.connectionId}`
  );
  await deps.sendToConnection(event, peer.connectionId, {
    action: 'message',
    from: sender.role,
    fromEnvelope: body.me,
    sessionId: sender.sessionId,
    data: body.data ?? null,
  });
  if (shouldRelease) await sendVerdictRelease(event, sender, peer, deps);
  return ok();
}

/** Application boundary for authenticated WebSocket identity, relay, and release policy. */
export function createWsRouter(deps: WsRouterDependencies) {
  return async (event: WsEvent): Promise<WsResponse> => {
    const route = event.requestContext.routeKey;
    const connectionId = event.requestContext.connectionId;
    if (route === '$connect') {
      deps.logInfo(`[ws] connect cid=${connectionId}`);
      return ok();
    }
    if (route === '$disconnect') {
      deps.logInfo(`[ws] disconnect cid=${connectionId}`);
      await deps.releaseRoleConnection(connectionId);
      return ok();
    }

    const body = parseActionBody(event);
    if (!body) return bad(deps, 'invalid_json');
    deps.logInfo(`[ws] action=${body.action} cid=${connectionId}`);
    if (body.action === 'whoami') return handleWhoami(event, body, deps);
    if (body.action === 'message') return handleMessage(event, body, deps);
    return bad(deps, 'unknown_action');
  };
}
