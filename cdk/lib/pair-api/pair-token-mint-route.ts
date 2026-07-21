import { jsonResp } from './shared/http';
import { validatePairTokenMintBody } from './pair-token-request';
import type { PairBlob } from './pair-token';
import type { WorkerIntegrityResult } from './worker-integrity';

interface PairTokenEvent {
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
}

interface PairTokenSession {
  proofRequired?: boolean;
  freshProofRequired?: boolean;
}

interface SealQrInput {
  pairOrigin: string;
  token: string;
  suffix: string;
  clientPublicKey: string;
  compression: 'none';
}

interface PairTokenMintDependencies {
  authenticateParticipant(event: PairTokenEvent, sessionId: string): Promise<boolean>;
  loadSession(sessionId: string): Promise<PairTokenSession | null>;
  verifyWorkerIntegrity(input: {
    workerUrl: string;
    workerSha256: string;
  }): Promise<WorkerIntegrityResult>;
  mintToken(blob: PairBlob): Promise<string>;
  sealQr(input: SealQrInput): Promise<unknown>;
  pairOrigin: string;
  proofRequiredByDefault: boolean;
  logWarn?: (message: string) => void;
}

/** Authenticated application boundary for minting the desktop's sparse QR token. */
export function createPairTokenMintHandler(deps: PairTokenMintDependencies) {
  return async (event: PairTokenEvent, sessionId: string, body: Record<string, unknown>) => {
    if (!(await deps.authenticateParticipant(event, sessionId))) {
      return jsonResp(401, { error: 'pair_token_unauthorized' });
    }
    const parsed = validatePairTokenMintBody(body);
    if (!parsed.ok) return jsonResp(parsed.status, parsed.body);

    const session = await deps.loadSession(sessionId);
    if (!session) return jsonResp(404, { error: 'session_not_found' });
    const workerIntegrity = await deps.verifyWorkerIntegrity({
      workerUrl: parsed.body.workerUrl,
      workerSha256: parsed.body.workerSha256,
    });
    if (!workerIntegrity.ok) {
      return jsonResp(workerIntegrity.status, {
        error: workerIntegrity.error,
        reason: workerIntegrity.reason,
      });
    }

    const token = await deps.mintToken({
      sessionId,
      wsUrl: parsed.body.wsUrl,
      e: parsed.body.e,
      pt: parsed.body.pt,
      n: parsed.body.n,
      proofRequired: session.proofRequired ?? deps.proofRequiredByDefault,
      freshProofRequired: session.freshProofRequired ?? false,
    });
    try {
      return jsonResp(
        200,
        await deps.sealQr({
          pairOrigin: deps.pairOrigin,
          token,
          suffix: parsed.body.debug ? '?debug=true' : '',
          clientPublicKey: parsed.body.cPub,
          compression: 'none',
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (deps.logWarn ?? console.warn)(
        `[pair] pair-token seal failed, refusing plaintext: ${message}`
      );
      return jsonResp(400, { error: 'bad_client_pubkey' });
    }
  };
}
