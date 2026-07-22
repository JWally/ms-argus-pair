import { describe, expect, it, vi } from 'vitest';
import {
  mintDesktopQr,
  resolveDesktopQrContext,
  type PairTokenMintResponse,
} from '../src/lib/desktop-qr.ts';
import type { QrKeyholder, SecureQrImage } from '../src/lib/qr-keyholder.ts';

function fakeImage(): SecureQrImage {
  return {
    kind: 'png',
    data: new Uint8Array([137, 80, 78, 71]),
    width: 512,
    mime: 'image/png',
  };
}

describe('desktop QR runtime context', () => {
  it('uses the baked canonical origin and forwards explicit debug mode', () => {
    expect(
      resolveDesktopQrContext({
        bakedOrigin: 'https://captcha-dev-jw.argus.pw',
        currentOrigin: 'https://merchant-alias.example',
        search: '?debug=true',
        isProduction: true,
      })
    ).toEqual({
      pairOriginBuildCanary: 'https://captcha-dev-jw.argus.pw',
      debugMode: true,
    });
  });

  it('allows the current-origin fallback only outside production', () => {
    expect(
      resolveDesktopQrContext({
        currentOrigin: 'http://localhost:5173',
        search: '?debug=false',
        isProduction: false,
      })
    ).toEqual({ pairOriginBuildCanary: 'http://localhost:5173', debugMode: false });
  });

  it('fails loudly before minting when a production build has no canonical origin', () => {
    expect(() =>
      resolveDesktopQrContext({
        currentOrigin: 'https://merchant-alias.example',
        search: '',
        isProduction: true,
      })
    ).toThrow('VITE_PAIR_URL_BASE is not baked into this build');
  });
});

describe('desktop QR minting', () => {
  it('mints the sealed pair-token payload and renders the returned ciphertext', async () => {
    const image = fakeImage();
    const keyholder: QrKeyholder = {
      keygen: vi.fn(async () => ({
        cPub: 'client-pub',
        workerUrl: 'https://captcha-dev-jw.argus.pw/assets/pair-qr-worker.js',
        workerSha256: 'sha256-worker',
      })),
      render: vi.fn(async () => image),
      dispose: vi.fn(),
    };
    const postJson = vi.fn(
      async (_input: string, _init: RequestInit): Promise<PairTokenMintResponse> => ({
        enc: 'sealed-png',
        sPub: 'server-pub',
        kind: 'png-frames',
        compression: 'none',
      })
    );

    await expect(
      mintDesktopQr({
        session: {
          sessionId: 'sess-1',
          nonce: 'nonce-1',
          ws: {
            url: 'wss://pair.example/ws',
            desktopToken: 'desk+/token',
            phoneToken: 'phone-token',
          },
        },
        desktopEnvelope: 'desktop-envelope',
        debugMode: true,
        pairOriginBuildCanary: 'https://captcha-dev-jw.argus.pw',
        postJson,
        createKeyholder: () => keyholder,
        preferredCompression: () => 'none',
      })
    ).resolves.toBe(image);

    const expectedDesktopToken = encodeURIComponent('desk+/token');
    expect(postJson).toHaveBeenCalledWith(
      `/api/session/sess-1/pair-token?t=${expectedDesktopToken}`,
      expect.objectContaining({ method: 'POST' })
    );
    const init = postJson.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      wsUrl: 'wss://pair.example/ws',
      e: 'desktop-envelope',
      pt: 'phone-token',
      n: 'nonce-1',
      cPub: 'client-pub',
      workerUrl: 'https://captcha-dev-jw.argus.pw/assets/pair-qr-worker.js',
      workerSha256: 'sha256-worker',
      qrCompression: 'none',
      debug: true,
      pairOriginBuildCanary: 'https://captcha-dev-jw.argus.pw',
    });
    expect(keyholder.render).toHaveBeenCalledWith('sealed-png', 'server-pub', {
      kind: 'png-frames',
      compression: 'none',
    });
    expect(keyholder.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the keyholder when the mint request fails', async () => {
    const keyholder: QrKeyholder = {
      keygen: vi.fn(async () => ({
        cPub: 'client-pub',
        workerUrl: 'https://captcha-dev-jw.argus.pw/assets/pair-qr-worker.js',
        workerSha256: 'sha256-worker',
      })),
      render: vi.fn(async () => fakeImage()),
      dispose: vi.fn(),
    };

    await expect(
      mintDesktopQr({
        session: {
          sessionId: 'sess-1',
          nonce: 'nonce-1',
          ws: {
            url: 'wss://pair.example/ws',
            desktopToken: 'desktop-token',
            phoneToken: 'phone-token',
          },
        },
        desktopEnvelope: 'desktop-envelope',
        debugMode: false,
        pairOriginBuildCanary: 'https://captcha-dev-jw.argus.pw',
        postJson: vi.fn(async () => {
          throw new Error('mint failed');
        }),
        createKeyholder: () => keyholder,
      })
    ).rejects.toThrow('mint failed');

    expect(keyholder.render).not.toHaveBeenCalled();
    expect(keyholder.dispose).toHaveBeenCalledOnce();
  });
});
