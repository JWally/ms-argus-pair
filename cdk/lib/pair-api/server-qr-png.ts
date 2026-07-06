import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import sharp from 'sharp';

export const SERVER_QR_SCALE = 16;
export const SERVER_QR_QUIET_MODULES = 2;
export const SERVER_QR_POISON_RATIO = 0.18;
export const SERVER_QR_FRAME_MS = 180;
export const SERVER_QR_FRAME_WRONG_RATES = [0.005, 0.2, 0.01, 0.25] as const;

interface QrModules {
  size: number;
  get(x: number, y: number): number;
}

export interface ServerQrPng {
  png: Uint8Array;
  width: number;
  profile: ServerQrFrameProfile;
}

export interface ServerQrPngFrames {
  frames: Uint8Array[];
  frameMs: number;
  width: number;
  profile: ServerQrFramesProfile;
}

export interface ServerQrFrameProfile {
  maskMs: number;
  paintMs: number;
  encodeMs: number;
  totalMs: number;
  bytes: number;
}

export interface ServerQrFramesProfile {
  createMs: number;
  totalMs: number;
  frameProfiles: ServerQrFrameProfile[];
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function setPixel(data: Buffer, imageWidth: number, x: number, y: number, dark: boolean): void {
  const index = (y * imageWidth + x) * 4;
  const value = dark ? 0 : 255;
  // eslint-disable-next-line security/detect-object-injection -- bounded PNG pixel buffer write.
  data[index] = value;
  data[index + 1] = value;
  data[index + 2] = value;
  data[index + 3] = 255;
}

function fillRect(
  data: Buffer,
  imageWidth: number,
  x0: number,
  y0: number,
  width: number,
  dark: boolean
): void {
  for (let y = y0; y < y0 + width; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      setPixel(data, imageWidth, x, y, dark);
    }
  }
}

function isFunctionModule(row: number, col: number, moduleCount: number): boolean {
  if (row < 9 && col < 9) return true;
  if (row < 9 && col >= moduleCount - 8) return true;
  if (row >= moduleCount - 8 && col < 9) return true;
  if (row === 6 || col === 6) return true;
  if (moduleCount >= 25) {
    const alignment = moduleCount - 7;
    return Math.abs(row - alignment) <= 3 && Math.abs(col - alignment) <= 3;
  }
  return false;
}

function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function moduleIndex(modules: QrModules, row: number, col: number): number {
  return row * modules.size + col;
}

function buildFlipMask(modules: QrModules, wrongRate: number, seed: string): Uint8Array {
  const mask = new Uint8Array(modules.size * modules.size);
  if (wrongRate <= 0) return mask;
  const random = seededRandom(seed);
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (isFunctionModule(row, col, modules.size)) continue;
      mask[moduleIndex(modules, row, col)] = random() < wrongRate ? 1 : 0;
    }
  }
  return mask;
}

function displayedModuleIsDark(
  modules: QrModules,
  row: number,
  col: number,
  flipMask: Uint8Array
): boolean {
  const originalDark = modules.get(col, row) === 1;
  if (isFunctionModule(row, col, modules.size)) return originalDark;
  return flipMask[moduleIndex(modules, row, col)] === 1 ? !originalDark : originalDark;
}

function paintDisplayedModules(
  data: Buffer,
  imageWidth: number,
  modules: QrModules,
  flipMask: Uint8Array
): void {
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (!displayedModuleIsDark(modules, row, col, flipMask)) continue;
      fillRect(
        data,
        imageWidth,
        (col + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE,
        (row + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE,
        SERVER_QR_SCALE,
        true
      );
    }
  }
}

function paintPoisonCenters(
  data: Buffer,
  imageWidth: number,
  modules: QrModules,
  flipMask: Uint8Array
): void {
  const poisonWidth = Math.round(SERVER_QR_SCALE * SERVER_QR_POISON_RATIO);
  const poisonOffset = Math.round((SERVER_QR_SCALE - poisonWidth) / 2);
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (isFunctionModule(row, col, modules.size)) continue;
      fillRect(
        data,
        imageWidth,
        (col + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE + poisonOffset,
        (row + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE + poisonOffset,
        poisonWidth,
        !displayedModuleIsDark(modules, row, col, flipMask)
      );
    }
  }
}

async function renderModulesToPng(
  modules: QrModules,
  wrongRate = 0,
  seed = 'static'
): Promise<ServerQrPng> {
  const startMs = nowMs();
  const imageWidth = qrImageWidth(modules);
  const raw = Buffer.alloc(imageWidth * imageWidth * 4, 255);

  const maskStartMs = nowMs();
  const flipMask = buildFlipMask(modules, wrongRate, seed);
  const maskMs = nowMs() - maskStartMs;
  const paintStartMs = nowMs();
  paintDisplayedModules(raw, imageWidth, modules, flipMask);
  paintPoisonCenters(raw, imageWidth, modules, flipMask);
  const paintMs = nowMs() - paintStartMs;
  const encodeStartMs = nowMs();
  const encoded = await sharp(raw, {
    raw: { width: imageWidth, height: imageWidth, channels: 4 },
  })
    .png({ compressionLevel: 6, adaptiveFiltering: false })
    .toBuffer();
  const encodeMs = nowMs() - encodeStartMs;

  return {
    png: encoded,
    width: imageWidth,
    profile: {
      maskMs,
      paintMs,
      encodeMs,
      totalMs: nowMs() - startMs,
      bytes: encoded.byteLength,
    },
  };
}

function qrImageWidth(modules: QrModules): number {
  return (modules.size + SERVER_QR_QUIET_MODULES * 2) * SERVER_QR_SCALE;
}

export async function renderPairTokenPng(
  pairOrigin: string,
  token: string,
  suffix = ''
): Promise<ServerQrPng> {
  const url = `${pairOrigin}/p/${token}${suffix}`;
  const code = QRCode.create(url, { errorCorrectionLevel: 'M' });
  return renderModulesToPng(code.modules);
}

export async function renderPairTokenPngFrames(
  pairOrigin: string,
  token: string,
  suffix = ''
): Promise<ServerQrPngFrames> {
  const startMs = nowMs();
  const url = `${pairOrigin}/p/${token}${suffix}`;
  const createStartMs = nowMs();
  const code = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const createMs = nowMs() - createStartMs;
  const renderedFrames = await Promise.all(
    SERVER_QR_FRAME_WRONG_RATES.map((wrongRate, index) =>
      renderModulesToPng(code.modules, wrongRate, `${token}:${index}`)
    )
  );
  return {
    frames: renderedFrames.map((frame) => frame.png),
    frameMs: SERVER_QR_FRAME_MS,
    width: qrImageWidth(code.modules),
    profile: {
      createMs,
      totalMs: nowMs() - startMs,
      frameProfiles: renderedFrames.map((frame) => frame.profile),
    },
  };
}
