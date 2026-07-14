import { jsonResp } from './shared/http';
import { signVerdict } from './verdict-token';

interface MintSession {
  cpi?: string | null;
  challengeId?: string;
  verdict: 'pending' | 'paired' | 'failed';
  verdictReason?: string;
  phoneAttestation?: { receivedAt: number };
}

interface MintEvent {
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
}

function participantToken(event: MintEvent): string {
  const authorization = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  return event.queryStringParameters?.t ?? authorization.replace(/^Bearer\s+/i, '');
}

export function createVerdictTokenMintHandler(deps: {
  loadSession(sessionId: string): Promise<MintSession | null>;
  verifyParticipant(token: string): Promise<{ sessionId: string } | null>;
  isReleased(sessionId: string, decidedAt: number, now: number): Promise<boolean>;
  getSecret(): Promise<string | null>;
  now?: () => number;
}) {
  return async (event: MintEvent, sessionId: string) => {
    const token = participantToken(event);
    const claims = token ? await deps.verifyParticipant(token) : null;
    if (!claims || claims.sessionId !== sessionId) {
      return jsonResp(401, { error: 'verdict_token_unauthorized' });
    }
    const session = await deps.loadSession(sessionId);
    if (!session) return jsonResp(404, { error: 'session_not_found' });
    if (session.verdict === 'pending') return jsonResp(409, { error: 'verdict_pending' });
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const decidedAt = session.phoneAttestation?.receivedAt ?? now;
    if (!(await deps.isReleased(sessionId, decidedAt, now))) {
      // Match undecided sessions so completion timing is not exposed here.
      return jsonResp(409, { error: 'verdict_pending' });
    }
    if (!session.challengeId) {
      return jsonResp(409, { error: 'challenge_binding_missing' });
    }
    const secret = await deps.getSecret();
    if (!secret) return jsonResp(503, { error: 'verdict_signing_unconfigured' });
    return jsonResp(200, {
      token: signVerdict(secret, {
        cpi: session.cpi ?? null,
        challengeId: session.challengeId,
        sessionId,
        verdict: session.verdict,
        reason: session.verdictReason ?? null,
      }),
    });
  };
}
