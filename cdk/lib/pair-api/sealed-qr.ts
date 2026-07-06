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
  const startMs = nowMs();
  const keyStartMs = nowMs();
  const serverPair = await genKeyPair();
  const aesKey = await deriveAesKey(
    serverPair.privateKey,
    await importPubRaw(input.clientPublicKey)
  );
  const keyMs = nowMs() - keyStartMs;
  const renderStartMs = nowMs();
  const renderedQr = await renderPairTokenPngFrames(
    input.pairOrigin,
    input.token,
    input.suffix ?? ''
  );
  const renderMs = nowMs() - renderStartMs;
  const packStartMs = nowMs();
  const bundle = packQrFrameBundle({
    frameMs: renderedQr.frameMs,
    frames: renderedQr.frames,
  });
  const packMs = nowMs() - packStartMs;
  const compressionStartMs = nowMs();
  const sealedBytes = input.compression === 'gzip' ? gzipSync(bundle) : bundle;
  const compressionMs = nowMs() - compressionStartMs;
  const sealStartMs = nowMs();
  const enc = await sealBytes(aesKey, sealedBytes);
  const sealMs = nowMs() - sealStartMs;
  const exportStartMs = nowMs();
  const sPub = await exportPubRaw(serverPair.publicKey);
  const exportMs = nowMs() - exportStartMs;

  console.info(
    JSON.stringify({
      event: 'pair_token_qr_profile',
      compression: input.compression,
      frameCount: renderedQr.frames.length,
      frameBytes: renderedQr.frames.map((frame) => frame.byteLength),
      bundleBytes: bundle.byteLength,
      sealedBytes: sealedBytes.byteLength,
      width: renderedQr.width,
      totalMs: roundMs(nowMs() - startMs),
      keyMs: roundMs(keyMs),
      renderMs: roundMs(renderMs),
      packMs: roundMs(packMs),
      compressionMs: roundMs(compressionMs),
      sealMs: roundMs(sealMs),
      exportMs: roundMs(exportMs),
      renderProfile: {
        createMs: roundMs(renderedQr.profile.createMs),
        totalMs: roundMs(renderedQr.profile.totalMs),
        frames: renderedQr.profile.frameProfiles.map((profile) => ({
          maskMs: roundMs(profile.maskMs),
          paintMs: roundMs(profile.paintMs),
          encodeMs: roundMs(profile.encodeMs),
          totalMs: roundMs(profile.totalMs),
          bytes: profile.bytes,
        })),
      },
    })
  );

  return {
    enc,
    sPub,
    kind: 'png-frames',
    compression: input.compression,
    width: renderedQr.width,
    frameMs: renderedQr.frameMs,
    frameCount: renderedQr.frames.length,
  };
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
