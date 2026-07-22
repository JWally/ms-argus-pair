import type { PeerMessage, WsConnection } from './ws';

const DESKTOP_READY_TIMEOUT_MS = 60_000;

export interface PhoneScanResult {
  sessionId: string | null;
  argusSessionId: string;
  durationMs: number;
  attestation?: {
    envelope: string;
    signature: string;
    publicKey: string;
    keyId: string;
  } | null;
  attestError?: string | null;
}

export interface PhoneSessionHash {
  wsUrl: string;
  desktopEnvelope: string;
  phoneToken: string;
  nonce: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
}

interface DesktopReadyPayload {
  kind: 'desktop-ready';
  nonce: string;
  expiresAt: number;
  desktopArgusSessionId: string;
  desktopKeyId: string;
}

export interface PhoneSessionInfo {
  nonce: string;
  proofRequired: boolean;
  freshProofRequired: boolean;
  expiresAt: number;
  desktopArgusSessionId: string;
  desktopKeyId: string;
  desktopEnvelope: string;
  phoneToken: string;
  conn: WsConnection;
  getVerdictRevealKey: () => Promise<string>;
  getScanPromise: () => Promise<PhoneScanResult>;
}

export interface PhoneSessionOptions {
  challenge?: boolean;
  onScanStart?: () => void;
  onScanDone?: (result: PhoneScanResult) => void;
  onScanError?: (error: unknown) => void;
}

export interface PhoneSessionRuntimeDependencies {
  readHash(): string;
  getOrigin(): string;
  startScan(sessionId: string, nonce: string): Promise<PhoneScanResult>;
  connect(options: { url: string; token: string; origin: string }): Promise<WsConnection>;
}

export function parsePhoneSessionHash(rawHash: string): PhoneSessionHash {
  const params = new URLSearchParams(rawHash.replace(/^#/, ''));
  const wsUrl = params.get('wsUrl');
  const desktopEnvelope = params.get('e');
  const phoneToken = params.get('pt');
  const nonce = params.get('n');
  if (!wsUrl || !desktopEnvelope || !phoneToken || !nonce) {
    throw new Error('pair URL is missing WebSocket routing material in the fragment — open via QR');
  }
  return {
    wsUrl,
    desktopEnvelope,
    phoneToken,
    nonce,
    // Missing means strict for compatibility with tokens minted before these fields existed.
    proofRequired: params.get('pr') !== '0',
    freshProofRequired: params.get('fr') === '1',
  };
}

function desktopReadyPayload(value: unknown): DesktopReadyPayload | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (
    data.kind !== 'desktop-ready' ||
    typeof data.nonce !== 'string' ||
    typeof data.expiresAt !== 'number' ||
    !Number.isFinite(data.expiresAt) ||
    typeof data.desktopArgusSessionId !== 'string' ||
    typeof data.desktopKeyId !== 'string'
  ) {
    return null;
  }
  return data as unknown as DesktopReadyPayload;
}

function authenticatedDesktopReady(
  message: PeerMessage,
  sessionId: string,
  desktopEnvelope: string
): DesktopReadyPayload | null {
  if (
    message.from !== 'desktop' ||
    message.fromEnvelope !== desktopEnvelope ||
    message.sessionId !== sessionId
  ) {
    return null;
  }
  return desktopReadyPayload(message.data);
}

function verdictRevealKey(connection: WsConnection, sessionId: string): Promise<string> {
  return new Promise((resolve) => {
    const unsubscribe = connection.onMessage((message) => {
      const data = message.data as { kind?: unknown; revealKey?: unknown } | null;
      if (
        message.from === 'server' &&
        message.sessionId === sessionId &&
        data?.kind === 'verdict-release' &&
        typeof data.revealKey === 'string' &&
        data.revealKey.length > 0
      ) {
        unsubscribe();
        resolve(data.revealKey);
      }
    });
  });
}

function waitForDesktopReady(
  connection: WsConnection,
  sessionId: string,
  desktopEnvelope: string,
  signal?: AbortSignal
): Promise<DesktopReadyPayload> {
  const ready = connection
    .waitForMessage(
      (message) => authenticatedDesktopReady(message, sessionId, desktopEnvelope) !== null,
      DESKTOP_READY_TIMEOUT_MS
    )
    .then((message) => authenticatedDesktopReady(message, sessionId, desktopEnvelope)!);
  if (!signal) return ready;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      connection.close();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void ready.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function awaitPhoneSessionReady(
  sessionId: string,
  signal: AbortSignal | undefined,
  options: PhoneSessionOptions,
  deps: PhoneSessionRuntimeDependencies
): Promise<PhoneSessionInfo> {
  if (signal?.aborted) throw new Error('aborted');
  const binding = parsePhoneSessionHash(deps.readHash());
  // LATENCY CONTRACT: do not move this scan behind desktop-ready or a user tap.
  // The QR nonce is sufficient, so the 3-5 second integrity scan should remain
  // hidden behind the connection handshake and drawing challenge.
  options.onScanStart?.();
  const scanPromise = deps.startScan(sessionId, binding.nonce);
  void scanPromise.then(options.onScanDone, options.onScanError);
  const connection = await deps.connect({
    url: binding.wsUrl,
    token: binding.phoneToken,
    origin: deps.getOrigin(),
  });
  if (signal?.aborted || connection.sessionId !== sessionId || connection.role !== 'phone') {
    connection.close();
    throw new Error(signal?.aborted ? 'aborted' : 'phone session identity mismatch');
  }
  const revealKey = verdictRevealKey(connection, sessionId);
  connection.sendPeer(binding.desktopEnvelope, {
    kind: 'phone-here',
    challenge: options.challenge === true,
  });
  const ready = await waitForDesktopReady(connection, sessionId, binding.desktopEnvelope, signal);
  return {
    ...ready,
    proofRequired: binding.proofRequired,
    freshProofRequired: binding.freshProofRequired,
    desktopEnvelope: binding.desktopEnvelope,
    phoneToken: binding.phoneToken,
    conn: connection,
    getVerdictRevealKey: () => revealKey,
    getScanPromise: () => scanPromise,
  };
}

export function signalPhoneChallengeDone(info: PhoneSessionInfo): void {
  try {
    info.conn.sendPeer(info.desktopEnvelope, { kind: 'phone-done' });
  } catch {
    /* Best effort: the desktop hold cap covers a lost completion message. */
  }
}
