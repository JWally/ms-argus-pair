import { parseMerchantChallenge } from './merchant-challenge';
import { parseScopedCpi, requiresProofOfLife } from './scoped-cpi';
import type { NewPairSession } from './session-start-store';

type ParticipantRole = 'desktop' | 'phone';
type StartFailureStatus = 400 | 409 | 429;
type StartFailure = {
  status: StartFailureStatus;
  body: { error: string; reason?: string; scope?: string };
};

export interface StartPairSessionDeps {
  allowStart(viewerIp: string): Promise<boolean>;
  storeSession(
    session: NewPairSession
  ): Promise<
    { ok: true } | { ok: false; status: 400 | 409; body: { error: string; reason?: string } }
  >;
  mintBootstrapToken(sessionId: string, role: ParticipantRole): Promise<string>;
  newSessionId(): string;
  newNonce(): string;
  nowEpochSeconds(): number;
  sessionTtlSeconds: number;
  requireProofOfLife: boolean;
  wsApiUrl: string | null;
  warn(message: string): void;
}

export type StartPairSessionResponse =
  | StartFailure
  | {
      status: 200;
      body: {
        sessionId: string;
        nonce: string;
        expiresAt: number;
        ws: { url: string | null; desktopToken: string; phoneToken: string };
      };
    };

type ParsedStart = { ok: true; session: NewPairSession } | { ok: false; response: StartFailure };

async function isStartAllowed(viewerIp: string, deps: StartPairSessionDeps): Promise<boolean> {
  try {
    return await deps.allowStart(viewerIp);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.warn(`[pair] session-start rate-limit check failed open: ${message}`);
    return true;
  }
}

function parseStart(body: Record<string, unknown>, deps: StartPairSessionDeps): ParsedStart {
  if (body.challengeId === undefined) {
    return {
      ok: false,
      response: { status: 400, body: { error: 'missing_challenge_id' } },
    };
  }
  const challengeId = parseMerchantChallenge(body.challengeId);
  if (!challengeId) {
    return {
      ok: false,
      response: { status: 400, body: { error: 'invalid_challenge_id' } },
    };
  }
  const scopedCpi = parseScopedCpi(body.cpi);
  if (body.cpi !== undefined && !scopedCpi) {
    return { ok: false, response: { status: 400, body: { error: 'invalid_cpi' } } };
  }
  return {
    ok: true,
    session: {
      id: deps.newSessionId(),
      nonce: deps.newNonce(),
      expiresAt: deps.nowEpochSeconds() + deps.sessionTtlSeconds,
      challengeId,
      cpi: scopedCpi?.cpi ?? null,
      proofRequired: requiresProofOfLife(scopedCpi, deps.requireProofOfLife),
      freshProofRequired: scopedCpi?.freshProofRequired ?? false,
      hostPreflightRequired: body.hostPreflightRequired === true,
      hostOrigin: typeof body.hostOrigin === 'string' ? body.hostOrigin : undefined,
    },
  };
}

/** Application boundary for POST /api/session/start. */
export async function startPairSession(
  body: Record<string, unknown>,
  viewerIp: string,
  deps: StartPairSessionDeps
): Promise<StartPairSessionResponse> {
  if (!(await isStartAllowed(viewerIp, deps))) {
    return {
      status: 429,
      body: { error: 'rate_limited', scope: 'session_start' },
    };
  }
  const parsed = parseStart(body, deps);
  if (!parsed.ok) return parsed.response;
  const stored = await deps.storeSession(parsed.session);
  if (!stored.ok) return { status: stored.status, body: stored.body };
  const [desktopToken, phoneToken] = await Promise.all([
    deps.mintBootstrapToken(parsed.session.id, 'desktop'),
    deps.mintBootstrapToken(parsed.session.id, 'phone'),
  ]);
  return {
    status: 200,
    body: {
      sessionId: parsed.session.id,
      nonce: parsed.session.nonce,
      expiresAt: parsed.session.expiresAt,
      ws: { url: deps.wsApiUrl, desktopToken, phoneToken },
    },
  };
}
