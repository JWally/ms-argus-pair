import { jsonResp, noContentResp } from './shared/http';

type SessionVerdict = 'pending' | 'paired' | 'failed';

interface SessionResultEvent {
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
}

interface ResultSession {
  verdict: SessionVerdict;
  verdictReason?: string;
  annotations?: Record<string, unknown>;
  phoneAttestation?: { receivedAt: number };
}

interface SealedResultInput {
  sessionId: string;
  verdict: Exclude<SessionVerdict, 'pending'>;
  reason: string | null;
  annotations: Record<string, unknown>;
  nextDeviceTrust: null;
  decidedAt: number;
  now: number;
}

interface SessionResultDependencies {
  authenticateParticipant(event: SessionResultEvent, sessionId: string): Promise<boolean>;
  loadSession(sessionId: string): Promise<ResultSession | null>;
  sealResult(input: SealedResultInput): Promise<Record<string, unknown>>;
  nowEpochSeconds?: () => number;
}

/** Authenticated application boundary for the desktop verdict fallback. */
export function createSessionResultHandler(deps: SessionResultDependencies) {
  return async (event: SessionResultEvent, sessionId: string) => {
    if (!(await deps.authenticateParticipant(event, sessionId))) {
      return jsonResp(401, { error: 'result_unauthorized' });
    }

    const session = await deps.loadSession(sessionId);
    if (!session) return jsonResp(410, { error: 'session_expired' });
    if (session.verdict === 'pending') return noContentResp();

    const now = deps.nowEpochSeconds?.() ?? Math.floor(Date.now() / 1000);
    const sealedResult = await deps.sealResult({
      sessionId,
      verdict: session.verdict,
      reason: session.verdictReason ?? null,
      annotations: session.annotations ?? {},
      nextDeviceTrust: null,
      decidedAt: session.phoneAttestation?.receivedAt ?? now,
      now,
    });
    return jsonResp(200, sealedResult);
  };
}
