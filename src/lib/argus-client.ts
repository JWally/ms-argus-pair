import { awaitWithDeadline } from './client-deadline';

const ATTEST_PURPOSE = 'argus-pair-v1';
const ATTEST_TTL_SECONDS = 120;
const ARGUS_BOOTSTRAP_TIMEOUT_MS = 15_000;
const ARGUS_SCAN_TIMEOUT_MS = 30_000;

export const ARGUS_CPI =
  (import.meta.env.VITE_MERCHANT_CPI as string | undefined) ??
  'argus_cpi_test_UEeqk7Bk7uetxKKDxNmIdB';

export interface ArgusAttestation {
  envelope: string;
  signature: string;
  publicKey: string;
  keyId: string;
}

export interface ArgusRunResult {
  sessionId: string | null;
  argusSessionId: string;
  durationMs: number;
  attestation?: ArgusAttestation | null;
  attestError?: string | null;
}

export interface ArgusScanInput {
  cpi: string;
  payload: Record<string, unknown>;
}

export interface ArgusAttestedScan {
  argusSessionId: string;
  attestation: ArgusAttestation;
}

interface ArgusGlobal {
  run(opts: {
    sessionId?: string;
    cpi?: string;
    timeoutMs?: number;
    attest?: { purpose: string; payload?: unknown; ttlSeconds?: number };
  }): Promise<ArgusRunResult>;
}

declare global {
  interface Window {
    argus?: ArgusGlobal;
    argusBootstrapReady?: Promise<void>;
  }
}

/** Argus ingestion uses the base CPI while signed SSO payloads retain policy scope. */
export function baseIntegrityCpi(cpi: string): string {
  return cpi.replace(/\.(?:fastpass|stepup|forceauth)$/, '');
}

function getArgus(): ArgusGlobal {
  if (!window.argus) {
    throw new Error('argus SDK not loaded (argus-loader.iife.js missing or blocked)');
  }
  return window.argus;
}

async function waitForArgus(): Promise<ArgusGlobal> {
  // The signed bootstrap installs the SDK asynchronously; eager phone scans
  // must wait for its canonical readiness promise before reading window.argus.
  await awaitWithDeadline(
    window.argusBootstrapReady ?? Promise.resolve(),
    ARGUS_BOOTSTRAP_TIMEOUT_MS,
    'argus_bootstrap'
  );
  return getArgus();
}

export async function runArgusScan(input: ArgusScanInput): Promise<ArgusRunResult> {
  const argus = await waitForArgus();
  return argus.run({
    cpi: input.cpi,
    timeoutMs: ARGUS_SCAN_TIMEOUT_MS,
    attest: {
      purpose: ATTEST_PURPOSE,
      ttlSeconds: ATTEST_TTL_SECONDS,
      payload: input.payload,
    },
  });
}

export async function runArgusAttestation(input: ArgusScanInput): Promise<ArgusAttestedScan> {
  const run = await runArgusScan(input);
  if (!run.attestation) {
    throw new Error(`argus attestation failed: ${run.attestError ?? 'no attestation'}`);
  }
  return { argusSessionId: run.argusSessionId, attestation: run.attestation };
}
