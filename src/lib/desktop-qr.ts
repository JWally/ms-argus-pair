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
