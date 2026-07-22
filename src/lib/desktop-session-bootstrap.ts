import type { WsConnection } from './ws';

export interface DesktopSessionStartResponse {
  sessionId: string;
  nonce: string;
  expiresAt: number;
  ws: {
    url: string;
    desktopToken: string;
    phoneToken: string;
  };
}

export interface DesktopSessionBootstrapOptions {
  challengeId: string;
  cpi?: string;
  hostPreflightRequired?: boolean;
  hostOrigin?: string;
  staticWsUrl?: string;
  origin: string;
}

export interface DesktopSessionStartBody {
  challengeId: string;
  cpi?: string;
  hostPreflightRequired?: true;
  hostOrigin?: string;
}

interface DesktopConnectionOptions {
  url: string;
  token: string;
  origin: string;
  existingWs?: WebSocket;
}

export interface DesktopSessionBootstrapDependencies {
  startSession(body: DesktopSessionStartBody): Promise<DesktopSessionStartResponse>;
  openSocket(url: string): Promise<WebSocket>;
  connect(options: DesktopConnectionOptions): Promise<WsConnection>;
  warn(message: string, error: unknown): void;
}

function buildStartBody(options: DesktopSessionBootstrapOptions): DesktopSessionStartBody {
  return {
    challengeId: options.challengeId,
    ...(options.cpi ? { cpi: options.cpi } : {}),
    ...(options.hostPreflightRequired
      ? { hostPreflightRequired: true as const, hostOrigin: options.hostOrigin }
      : {}),
  };
}

function hasBootstrapMaterial(session: DesktopSessionStartResponse): boolean {
  return Boolean(session.ws?.url && session.ws.desktopToken && session.ws.phoneToken);
}

export async function bootstrapDesktopSession(
  options: DesktopSessionBootstrapOptions,
  dependencies: DesktopSessionBootstrapDependencies
): Promise<{ session: DesktopSessionStartResponse; desktopConn: WsConnection }> {
  const eagerSocketPromise = options.staticWsUrl
    ? dependencies.openSocket(options.staticWsUrl).catch((error: unknown) => {
        dependencies.warn('[argus-pair] eager ws open failed, falling back', error);
        return null;
      })
    : Promise.resolve(null);

  const [session, eagerSocket] = await Promise.all([
    dependencies.startSession(buildStartBody(options)),
    eagerSocketPromise,
  ]);
  if (!hasBootstrapMaterial(session)) {
    eagerSocket?.close();
    throw new Error('session/start did not return WebSocket bootstrap material');
  }

  const reuseEagerSocket = Boolean(eagerSocket?.url.startsWith(session.ws.url));
  if (eagerSocket && !reuseEagerSocket) eagerSocket.close();

  const desktopConn = await dependencies.connect({
    url: session.ws.url,
    token: session.ws.desktopToken,
    origin: options.origin,
    existingWs: reuseEagerSocket ? (eagerSocket ?? undefined) : undefined,
  });
  return { session, desktopConn };
}
