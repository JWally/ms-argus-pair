import type { DesktopAttestationSession, StoredDesktopAttestation } from './desktop-attest';
import type { DesktopScanSummary } from './projection-verdict';
import { jsonResp } from './shared/http';

interface DesktopAttestationRouteSession {
  nonce: string;
  challengeId?: string;
  cpi?: string | null;
  hostPreflightRequired?: boolean;
  hostOrigin?: string;
  desktopAttestation?: StoredDesktopAttestation;
}

type PreparedDesktopAttestation =
  | { ok: true; stored: StoredDesktopAttestation }
  | { ok: false; status: number; body: unknown };

interface DesktopAttestationDependencies {
  loadSession(sessionId: string): Promise<DesktopAttestationRouteSession | null>;
  prepareDesktopAttestation(
    body: Record<string, unknown>,
    session: DesktopAttestationSession
  ): Promise<PreparedDesktopAttestation>;
  storeDesktopAttestation(
    sessionId: string,
    attestation: StoredDesktopAttestation
  ): Promise<boolean>;
  classifyDesktop(argusSessionId: string): Promise<DesktopScanSummary | null>;
  logWarn?: (message: string) => void;
}

function bindingContext(
  sessionId: string,
  session: DesktopAttestationRouteSession
): DesktopAttestationSession {
  return {
    pairSessionId: sessionId,
    nonce: session.nonce,
    challengeId: session.challengeId,
    cpi: session.cpi,
    hostPreflightRequired: session.hostPreflightRequired,
    hostOrigin: session.hostOrigin,
  };
}

/** Application boundary for validating, committing, and summarizing a desktop scan. */
export function createDesktopAttestationHandler(deps: DesktopAttestationDependencies) {
  return async (body: Record<string, unknown>, sessionId: string) => {
    const session = await deps.loadSession(sessionId);
    if (!session) return jsonResp(404, { error: 'session_not_found' });
    if (session.desktopAttestation) return jsonResp(409, { error: 'already_attested' });

    const prepared = await deps.prepareDesktopAttestation(body, bindingContext(sessionId, session));
    if (!prepared.ok) return jsonResp(prepared.status, prepared.body);

    const stored = await deps.storeDesktopAttestation(sessionId, prepared.stored);
    if (!stored) return jsonResp(409, { error: 'already_attested' });

    let classification: DesktopScanSummary | null = null;
    try {
      classification = await deps.classifyDesktop(prepared.stored.argusSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (deps.logWarn ?? console.warn)(
        `[pair] desktop-attest optimistic classify failed: ${message}`
      );
    }

    return jsonResp(200, {
      ok: true,
      clean: classification?.clean ?? false,
      summary: classification?.summary ?? null,
    });
  };
}
