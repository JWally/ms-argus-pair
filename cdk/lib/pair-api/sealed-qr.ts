import { gzipSync } from 'node:zlib';
import {
  deriveAesKey,
  exportPubRaw,
  genKeyPair,
  importPubRaw,
  sealBytes,
} from '../../../src/lib/ecdh-seal';
import { packQrFrameBundle } from '../../../src/lib/qr-frame-bundle';
import { renderPairTokenPngFrames } from './server-qr-png';

export type QrCompression = 'gzip' | 'none';

export interface SealedPairTokenQr {
  enc: string;
  sPub: string;
  kind: 'png-frames';
  compression: QrCompression;
  width: number;
  frameMs: number;
  frameCount: number;
}

export async function sealPairTokenQr(input: {
  pairOrigin: string;
  token: string;
  suffix?: string;
  clientPublicKey: string;
  compression: QrCompression;
}): Promise<SealedPairTokenQr> {
  const serverPair = await genKeyPair();
  const aesKey = await deriveAesKey(
    serverPair.privateKey,
    await importPubRaw(input.clientPublicKey)
  );
  const renderedQr = renderPairTokenPngFrames(input.pairOrigin, input.token, input.suffix ?? '');
  const bundle = packQrFrameBundle({
    frameMs: renderedQr.frameMs,
    frames: renderedQr.frames,
  });
  const sealedBytes = input.compression === 'gzip' ? gzipSync(bundle) : bundle;

  return {
    enc: await sealBytes(aesKey, sealedBytes),
    sPub: await exportPubRaw(serverPair.publicKey),
    kind: 'png-frames',
    compression: input.compression,
    width: renderedQr.width,
    frameMs: renderedQr.frameMs,
    frameCount: renderedQr.frames.length,
  };
}
