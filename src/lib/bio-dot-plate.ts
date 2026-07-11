const LOGICAL_W = 520;
const LOGICAL_H = 312;
const FRAME_COUNT = 5;
const FRAME_MS = 120;
const GRID_SPACING = 15;
const GRID_MARGIN = 14;

interface PlateDot {
  x: number;
  y: number;
  radius: number;
  color: string;
  highlight: string;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function createMask(letter: string, seed: number): Uint8ClampedArray {
  const mask = createCanvas(LOGICAL_W, LOGICAL_H);
  const ctx = mask.getContext('2d', { willReadFrequently: true });
  if (!ctx) return new Uint8ClampedArray(LOGICAL_W * LOGICAL_H * 4);
  const next = seededRandom(seed + 17);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  ctx.save();
  ctx.translate(LOGICAL_W / 2, LOGICAL_H / 2 + 4);
  ctx.rotate((next() - 0.5) * 0.1);
  ctx.transform(1, (next() - 0.5) * 0.1, (next() - 0.5) * 0.14, 1, 0, 0);
  ctx.font = '900 246px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(letter, 0, 2);
  ctx.restore();

  return ctx.getImageData(0, 0, LOGICAL_W, LOGICAL_H).data;
}

function isLetterPixel(mask: Uint8ClampedArray, x: number, y: number): boolean {
  const px = Math.max(0, Math.min(LOGICAL_W - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(LOGICAL_H - 1, Math.floor(y)));
  return mask[(py * LOGICAL_W + px) * 4] > 20;
}

function drawCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string
): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function buildPlateDot(
  col: number,
  row: number,
  mask: Uint8ClampedArray,
  next: () => number
): PlateDot {
  const x = col + (next() - 0.5) * GRID_SPACING * 0.55;
  const y = row + (next() - 0.5) * GRID_SPACING * 0.55;
  const hit = isLetterPixel(mask, x, y);
  const radius = (hit ? 5.2 : 4.3) + next() * (hit ? 2.3 : 2);
  const red = hit ? 150 + Math.floor(next() * 45) : 70 + Math.floor(next() * 40);
  const green = hit ? 100 + Math.floor(next() * 50) : 40 + Math.floor(next() * 35);
  const blue = hit ? 235 + Math.floor(next() * 20) : 120 + Math.floor(next() * 60);
  const alpha = hit ? 0.98 : 0.7 + next() * 0.18;
  return {
    x,
    y,
    radius,
    color: `rgba(${red}, ${green}, ${blue}, ${alpha})`,
    highlight: `rgba(236, 229, 255, ${hit ? 0.18 : 0.1})`,
  };
}

function drawPlateGrid(
  ctx: CanvasRenderingContext2D,
  mask: Uint8ClampedArray,
  next: () => number
): void {
  for (let row = GRID_MARGIN; row < LOGICAL_H - GRID_MARGIN; row += GRID_SPACING) {
    for (let col = GRID_MARGIN; col < LOGICAL_W - GRID_MARGIN; col += GRID_SPACING) {
      const dot = buildPlateDot(col, row, mask, next);

      drawCircle(ctx, dot.x, dot.y, dot.radius, dot.color);
      drawCircle(
        ctx,
        dot.x - dot.radius * 0.28,
        dot.y - dot.radius * 0.28,
        Math.max(1, dot.radius * 0.22),
        dot.highlight
      );
    }
  }
}

function drawPlateSpeckles(
  ctx: CanvasRenderingContext2D,
  mask: Uint8ClampedArray,
  next: () => number
): void {
  for (let i = 0; i < 22; i++) {
    const x = 10 + next() * (LOGICAL_W - 20);
    const y = 10 + next() * (LOGICAL_H - 20);
    const hit = isLetterPixel(mask, x, y);
    drawCircle(
      ctx,
      x,
      y,
      2.4 + next() * 2.4,
      hit ? 'rgba(240, 234, 255, 0.28)' : 'rgba(240, 234, 255, 0.18)'
    );
  }
}

function renderPlateFrame(letter: string, seed: number): HTMLCanvasElement {
  const frame = createCanvas(LOGICAL_W, LOGICAL_H);
  const ctx = frame.getContext('2d');
  if (!ctx) return frame;
  const next = seededRandom(seed);
  const mask = createMask(letter, seed);

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  drawPlateGrid(ctx, mask, next);
  drawPlateSpeckles(ctx, mask, next);

  return frame;
}

function buildFrames(letter: string, seed: number): HTMLCanvasElement[] {
  return Array.from({ length: FRAME_COUNT }, (_, index) =>
    renderPlateFrame(letter, seed + index * 317)
  );
}

export function startBioDotPlate(
  canvas: HTMLCanvasElement,
  letter: string,
  seed: number
): () => void {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return () => {};

  const frames = buildFrames(letter, seed);
  let disposed = false;
  let frameIndex = 0;
  let timer = 0;

  const paint = () => {
    const frame = frames.find((_, index) => index === frameIndex) ?? frames[0];
    if (frame) ctx.drawImage(frame, 0, 0, LOGICAL_W, LOGICAL_H);
  };

  const resize = () => {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.floor(LOGICAL_W * dpr);
    const height = Math.floor(LOGICAL_H * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.imageSmoothingEnabled = false;
    paint();
  };

  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  timer = window.setInterval(() => {
    if (disposed) return;
    frameIndex = (frameIndex + 1) % frames.length;
    paint();
  }, FRAME_MS);

  return () => {
    disposed = true;
    window.clearInterval(timer);
    ro.disconnect();
  };
}
