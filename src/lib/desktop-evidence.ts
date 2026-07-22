import {
  ARGUS_CPI,
  baseIntegrityCpi,
  runArgusScan,
  type ArgusAttestation,
  type ArgusRunResult,
  type ArgusScanInput,
} from './argus-client';
import { jsonFetch } from './json-http';

export interface HostPreflightScan {
  argusSessionId: string;
  attestation: ArgusAttestation;
}

export interface DesktopAttestedSummary {
  clean: boolean;
  summary: {
    score?: number;
    pat_attested?: boolean;
    is_proxy?: boolean;
    is_datacenter?: boolean;
    is_vpn?: boolean;
    is_mobile_network?: boolean;
    browser_name?: string | null;
    browser_version?: string | null;
    os?: string | null;
    ip?: string | null;
    asn_name?: string | null;
    city?: string | null;
    country?: string | null;
  } | null;
}

export interface DesktopEvidenceInput {
  sessionId: string;
  nonce: string;
  expiresAt: number;
  cpi?: string;
  hostPreflightRequired?: boolean;
  requestHostPreflight?: (binding: { pairSessionId: string }) => Promise<HostPreflightScan>;
}

export interface DesktopEvidenceCallbacks {
  isCancelled(): boolean;
  onDesktopAttested(info: DesktopAttestedSummary): void;
  queueDesktopReady(message: Record<string, unknown>): void;
  onError(error: unknown): void;
  fail(error: unknown): void;
}

interface DesktopAttestationResponse {
  ok: boolean;
  clean?: boolean;
  summary?: DesktopAttestedSummary['summary'];
}

interface DesktopAttestationBody {
  argusSessionId: string;
  attestation: ArgusAttestation;
  hostPreflight?: HostPreflightScan;
}

export interface DesktopEvidenceDependencies {
  runScan(input: ArgusScanInput): Promise<ArgusRunResult>;
  postAttestation(
    sessionId: string,
    body: DesktopAttestationBody
  ): Promise<DesktopAttestationResponse>;
}

export interface DesktopEvidenceTask {
  complete(callbacks: DesktopEvidenceCallbacks): Promise<void>;
}

type EvidenceCollection =
  | { ok: true; run: ArgusRunResult; hostScan: HostPreflightScan | null }
  | { ok: false; error: unknown };

function requestHostEvidence(input: DesktopEvidenceInput): Promise<HostPreflightScan | null> {
  if (!input.hostPreflightRequired) return Promise.resolve(null);
  return (
    input.requestHostPreflight?.({ pairSessionId: input.sessionId }) ??
    Promise.reject(new Error('host preflight callback missing'))
  );
}

function collectDesktopEvidence(
  input: DesktopEvidenceInput,
  dependencies: DesktopEvidenceDependencies
): Promise<EvidenceCollection> {
  return Promise.all([
    dependencies.runScan({
      cpi: baseIntegrityCpi(input.cpi || ARGUS_CPI),
      payload: { sessionId: input.sessionId, nonce: input.nonce, role: 'desktop' },
    }),
    requestHostEvidence(input),
  ]).then(
    ([run, hostScan]) => ({ ok: true as const, run, hostScan }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

function requireAttestation(collection: EvidenceCollection): {
  run: ArgusRunResult & { attestation: ArgusAttestation };
  hostScan: HostPreflightScan | null;
} {
  if (!collection.ok) throw collection.error;
  if (!collection.run.attestation) {
    throw new Error(`argus attestation failed: ${collection.run.attestError ?? 'no attestation'}`);
  }
  return {
    run: { ...collection.run, attestation: collection.run.attestation },
    hostScan: collection.hostScan,
  };
}

async function completeDesktopEvidence(
  input: DesktopEvidenceInput,
  collection: Promise<EvidenceCollection>,
  callbacks: DesktopEvidenceCallbacks,
  dependencies: DesktopEvidenceDependencies
): Promise<void> {
  try {
    const { run, hostScan } = requireAttestation(await collection);
    if (callbacks.isCancelled()) return;
    const response = await dependencies.postAttestation(input.sessionId, {
      argusSessionId: run.argusSessionId,
      attestation: run.attestation,
      ...(hostScan ? { hostPreflight: hostScan } : {}),
    });
    callbacks.onDesktopAttested({
      clean: !!response.clean,
      summary: response.summary ?? null,
    });
    callbacks.queueDesktopReady({
      kind: 'desktop-ready',
      nonce: input.nonce,
      expiresAt: input.expiresAt,
      desktopArgusSessionId: run.argusSessionId,
      desktopKeyId: run.attestation.keyId,
    });
  } catch (error) {
    callbacks.onError(error);
    callbacks.fail(error);
  }
}

const browserDependencies: DesktopEvidenceDependencies = {
  runScan: runArgusScan,
  postAttestation: (sessionId, body) =>
    jsonFetch(`/api/session/${sessionId}/desktop-attest`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export function startDesktopEvidence(
  input: DesktopEvidenceInput,
  dependencies: DesktopEvidenceDependencies = browserDependencies
): DesktopEvidenceTask {
  // Collection starts now, before QR minting. Rejections are converted into a
  // value immediately so a slow QR path cannot create an unhandled rejection.
  const collection = collectDesktopEvidence(input, dependencies);
  return {
    complete: (callbacks) => completeDesktopEvidence(input, collection, callbacks, dependencies),
  };
}
