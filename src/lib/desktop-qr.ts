import {
  createQrKeyholder,
  preferredQrCompression,
  type QrKeyholder,
  type SecureQrImage,
} from './qr-keyholder';

export interface DesktopQrSession {
  sessionId: string;
  nonce: string;
  ws: {
    url: string;
    desktopToken: string;
    phoneToken: string;
  };
}

export interface MintDesktopQrOptions {
  session: DesktopQrSession;
  desktopEnvelope: string;
  debugMode: boolean;
  pairOriginBuildCanary: string;
  postJson: <T>(input: string, init: RequestInit) => Promise<T>;
  createKeyholder?: () => QrKeyholder;
  preferredCompression?: () => 'gzip' | 'none';
}

export interface PairTokenMintResponse {
  enc: string;
  sPub: string;
  kind?: 'png' | 'png-frames';
  compression?: 'gzip' | 'none';
}

export interface DesktopQrRuntimeInput {
  bakedOrigin?: string;
  currentOrigin: string;
  search: string;
  isProduction: boolean;
}

export interface DesktopQrRuntimeContext {
  pairOriginBuildCanary: string;
  debugMode: boolean;
}

/**
 * Preserve the canonical-host build canary at the QR trust boundary. Production
 * must never mint a scannable QR for an alias origin when Vite env injection is
 * broken; local development may use its current origin deliberately.
 */
export function resolveDesktopQrContext(input: DesktopQrRuntimeInput): DesktopQrRuntimeContext {
  if (input.isProduction && !input.bakedOrigin) {
    throw new Error(
      'pair: VITE_PAIR_URL_BASE is not baked into this build. QR would ' +
        'point at window.location.origin (alias-leak risk). Rebuild via ' +
        '`npm run deploy` so the env var is set from cdk/bin/print-pair-host.mjs.'
    );
  }
  return {
    pairOriginBuildCanary: input.bakedOrigin ?? input.currentOrigin,
    // Debug only disables the phone's silent-reauth fast path; server checks remain unchanged.
    debugMode: new URLSearchParams(input.search).get('debug') === 'true',
  };
}

/**
 * Mint a short single-use connection token and keep the QR plaintext inside
 * the ECDH keyholder worker. Only sealed display bytes cross into the page.
 */
export async function mintDesktopQr({
  session,
  desktopEnvelope,
  debugMode,
  pairOriginBuildCanary,
  postJson,
  createKeyholder = createQrKeyholder,
  preferredCompression = preferredQrCompression,
}: MintDesktopQrOptions): Promise<SecureQrImage> {
  const keyholder = createKeyholder();
  try {
    const qrCompression = preferredCompression();
    const { cPub, workerUrl, workerSha256 } = await keyholder.keygen();
    const { enc, sPub, kind, compression } = await postJson<PairTokenMintResponse>(
      `/api/session/${session.sessionId}/pair-token?t=${encodeURIComponent(
        session.ws.desktopToken
      )}`,
      {
        method: 'POST',
        body: JSON.stringify({
          wsUrl: session.ws.url,
          e: desktopEnvelope,
          pt: session.ws.phoneToken,
          n: session.nonce,
          cPub,
          workerUrl,
          workerSha256,
          qrCompression,
          debug: debugMode,
          pairOriginBuildCanary,
        }),
      }
    );
    return await keyholder.render(enc, sPub, { kind, compression });
  } finally {
    keyholder.dispose();
  }
}
