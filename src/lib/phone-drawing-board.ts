import { startBioDotPlate } from './bio-dot-plate';

const DRAW_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

export interface DrawingChallenge {
  letter: string;
  seed: number;
}

export interface PhoneDrawingBoard {
  setDone(done: boolean): void;
  stop(): void;
}

export interface PhoneDrawingBoardPlatform {
  startPlate(canvas: HTMLCanvasElement, letter: string, seed: number): () => void;
  observeResize(callback: () => void, canvas: HTMLCanvasElement): () => void;
  vibrate(pattern: number | number[]): void;
}

interface MountPhoneDrawingBoardOptions {
  root: HTMLElement;
  nonce: string;
  challengeIndex: number;
  started: boolean;
  done: boolean;
  onStarted(): void;
  onAdvance(): void;
  platform?: PhoneDrawingBoardPlatform;
}

const browserPlatform: PhoneDrawingBoardPlatform = {
  startPlate: startBioDotPlate,
  observeResize(callback, canvas) {
    const observer = new ResizeObserver(callback);
    observer.observe(canvas);
    return () => observer.disconnect();
  },
  vibrate(pattern) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* best-effort tactile feedback */
    }
  },
};

export function selectDrawingChallenge(nonce: string, challengeIndex: number): DrawingChallenge {
  let seed = 2_166_136_261;
  for (const character of `${nonce}:${challengeIndex}`) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16_777_619);
  }
  seed >>>= 0;
  return {
    letter: DRAW_LETTERS[seed % DRAW_LETTERS.length],
    seed,
  };
}

export function mountPhoneDrawingBoard({
  root,
  nonce,
  challengeIndex,
  started: initiallyStarted,
  done,
  onStarted,
  onAdvance,
  platform = browserPlatform,
}: MountPhoneDrawingBoardOptions): PhoneDrawingBoard {
  const challenge = selectDrawingChallenge(nonce, challengeIndex);
  let started = initiallyStarted;
  let hasDrawn = false;
  let drawing = false;

  root.innerHTML = drawingBoardMarkup(challenge.letter, started);

  const plate = root.querySelector<HTMLCanvasElement>('.bio-draw-dot-canvas');
  const canvas = root.querySelector<HTMLCanvasElement>('.bio-draw-canvas');
  const overlay = root.querySelector<HTMLElement>('.bio-draw-overlay');
  const canvasArea = root.querySelector<HTMLElement>('.canvas-area');
  const erase = root.querySelector<HTMLElement>('.bio-draw-erase');
  const send = root.querySelector<HTMLButtonElement>('.bio-draw-send');
  const context = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
  const stopPlate = plate
    ? platform.startPlate(plate, challenge.letter, challenge.seed)
    : () => undefined;

  const syncCanvas = () => {
    if (!canvas || !context) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
  };

  const pointFromEvent = (event: PointerEvent) => {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const update = () => {
    overlay?.classList.toggle('bio-draw-overlay-hidden', started);
    canvasArea?.classList.toggle('canvas-idle', !hasDrawn);
    canvasArea?.classList.toggle('canvas-active', hasDrawn);
    setDisabled(erase, !hasDrawn);
    setDisabled(send, !hasDrawn);
  };

  const clear = () => {
    hasDrawn = false;
    syncCanvas();
    update();
  };

  syncCanvas();
  const stopResize = canvas ? platform.observeResize(syncCanvas, canvas) : () => undefined;

  canvas?.addEventListener('pointerdown', (event) => {
    if (!context || !canvas) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (!point) return;
    if (!started) {
      started = true;
      onStarted();
    }
    drawing = true;
    context.beginPath();
    context.moveTo(point.x, point.y);
    if (!hasDrawn) platform.vibrate(5);
    hasDrawn = true;
    update();
  });
  canvas?.addEventListener('pointermove', (event) => {
    if (!drawing || !context) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (!point) return;
    context.strokeStyle = '#fff';
    context.lineWidth = 18;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineTo(point.x, point.y);
    context.stroke();
  });
  const stopTracing = (event: PointerEvent) => {
    drawing = false;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas?.addEventListener('pointerup', stopTracing);
  canvas?.addEventListener('pointercancel', stopTracing);
  erase?.addEventListener('click', clear);
  send?.addEventListener('click', onAdvance);
  update();

  const board: PhoneDrawingBoard = {
    setDone(isDone) {
      if (send) send.textContent = isDone ? 'DONE' : 'Next';
    },
    stop() {
      stopPlate();
      stopResize();
    },
  };
  board.setDone(done);
  return board;
}

function drawingBoardMarkup(targetLetter: string, started: boolean): string {
  return `
    <div class="bio-draw app">
      <header>
        <h1>ARGUS <span class="accent">PAIR</span></h1>
        <p class="subtitle">Handwriting Biometric Captcha</p>
      </header>
      <main>
        <div class="challenge-digits">
          <div class="bio-draw-challenge" aria-label="Draw ${targetLetter}">
            <span>DRAW</span>
            <canvas class="bio-draw-dot-canvas" aria-label="${targetLetter}"></canvas>
          </div>
        </div>
        <div class="canvas-area canvas-idle">
          <canvas class="drawing-canvas bio-draw-canvas" aria-label="Draw the requested letter"></canvas>
          <div class="canvas-overlay bio-draw-overlay${started ? ' bio-draw-overlay-hidden' : ''}">
            <p class="canvas-overlay-text">Draw the Character You See Above</p>
            <p class="canvas-overlay-start">-- CLICK HERE TO START --</p>
          </div>
        </div>
        <div class="action-stack">
          <button type="button" disabled class="btn btn-next btn-stack bio-draw-send">Next</button>
          <button type="button" disabled class="btn btn-erase btn-stack bio-draw-erase">Erase</button>
        </div>
      </main>
    </div>`;
}

function setDisabled(
  element: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  } | null,
  disabled: boolean
): void {
  if (!element) return;
  if (disabled) {
    element.setAttribute('disabled', '');
  } else {
    element.removeAttribute('disabled');
  }
}
