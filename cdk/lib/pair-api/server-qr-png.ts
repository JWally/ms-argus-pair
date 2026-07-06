import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

export const SERVER_QR_SCALE = 24;
export const SERVER_QR_QUIET_MODULES = 2;
export const SERVER_QR_POISON_RATIO = 0.18;
export const SERVER_QR_FRAME_MS = 180;
export const SERVER_QR_FRAME_WRONG_RATES = [
  0.02, 0.2, 0.05, 0.005, 0.3, 0.25, 0.025, 0.15, 0.01, 0.1, 0.03,
] as const;

interface QrModules {
  size: number;
  get(x: number, y: number): number;
}

export interface ServerQrPng {
  png: Uint8Array;
  width: number;
}

export interface ServerQrPngFrames {
  frames: Uint8Array[];
  frameMs: number;
  width: number;
}

function setPixel(png: PNG, x: number, y: number, dark: boolean): void {
  const index = (y * png.width + x) * 4;
  const value = dark ? 0 : 255;
  // eslint-disable-next-line security/detect-object-injection -- bounded PNG pixel buffer write.
  png.data[index] = value;
  png.data[index + 1] = value;
  png.data[index + 2] = value;
  png.data[index + 3] = 255;
}

function fillRect(png: PNG, x0: number, y0: number, width: number, dark: boolean): void {
  for (let y = y0; y < y0 + width; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      setPixel(png, x, y, dark);
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

function shouldFlipModule(seed: string, row: number, col: number, wrongRate: number): boolean {
  if (wrongRate <= 0) return false;
  const digest = createHash('sha256').update(`${seed}:${row}:${col}`).digest();
  const sample = digest.readUInt32BE(0) / 0x1_0000_0000;
  return sample < wrongRate;
}

function displayedModuleIsDark(
  modules: QrModules,
  row: number,
  col: number,
  wrongRate: number,
  seed: string
): boolean {
  const originalDark = modules.get(col, row) === 1;
  if (isFunctionModule(row, col, modules.size)) return originalDark;
  return shouldFlipModule(seed, row, col, wrongRate) ? !originalDark : originalDark;
}

function paintDisplayedModules(
  png: PNG,
  modules: QrModules,
  wrongRate: number,
  seed: string
): void {
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (!displayedModuleIsDark(modules, row, col, wrongRate, seed)) continue;
      fillRect(
        png,
        (col + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE,
        (row + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE,
        SERVER_QR_SCALE,
        true
      );
    }
  }
}

function paintPoisonCenters(png: PNG, modules: QrModules, wrongRate: number, seed: string): void {
  const poisonWidth = Math.round(SERVER_QR_SCALE * SERVER_QR_POISON_RATIO);
  const poisonOffset = Math.round((SERVER_QR_SCALE - poisonWidth) / 2);
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (isFunctionModule(row, col, modules.size)) continue;
      fillRect(
        png,
        (col + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE + poisonOffset,
        (row + SERVER_QR_QUIET_MODULES) * SERVER_QR_SCALE + poisonOffset,
        poisonWidth,
        !displayedModuleIsDark(modules, row, col, wrongRate, seed)
      );
    }
  }
}

function renderModulesToPng(modules: QrModules, wrongRate = 0, seed = 'static'): ServerQrPng {
  const imageWidth = (modules.size + SERVER_QR_QUIET_MODULES * 2) * SERVER_QR_SCALE;
  const png = new PNG({ width: imageWidth, height: imageWidth });
  png.data.fill(255);
  for (let index = 3; index < png.data.length; index += 4) {
    // eslint-disable-next-line security/detect-object-injection -- bounded PNG alpha-channel fill.
    png.data[index] = 255;
  }

  paintDisplayedModules(png, modules, wrongRate, seed);
  paintPoisonCenters(png, modules, wrongRate, seed);

  return { png: PNG.sync.write(png), width: imageWidth };
}

export function renderPairTokenPng(pairOrigin: string, token: string, suffix = ''): ServerQrPng {
  const url = `${pairOrigin}/p/${token}${suffix}`;
  const code = QRCode.create(url, { errorCorrectionLevel: 'M' });
  return renderModulesToPng(code.modules);
}

export function renderPairTokenPngFrames(
  pairOrigin: string,
  token: string,
  suffix = ''
): ServerQrPngFrames {
  const url = `${pairOrigin}/p/${token}${suffix}`;
  const code = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const frames = SERVER_QR_FRAME_WRONG_RATES.map(
    (wrongRate, index) => renderModulesToPng(code.modules, wrongRate, `${token}:${index}`).png
  );
  return { frames, frameMs: SERVER_QR_FRAME_MS, width: renderModulesToPng(code.modules).width };
}
