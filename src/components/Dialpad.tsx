import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

export interface DialpadProps {
  nonce: string;
  challengeIndex?: number;
  actionLabel?: string;
  onSend(): void;
}

const DRAW_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

function hashChallenge(nonce: string, challengeIndex: number): number {
  let h = 2166136261;
  for (const ch of `${nonce}:${challengeIndex}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function drawLetterFromNonce(nonce: string, challengeIndex: number): string {
  return DRAW_LETTERS[hashChallenge(nonce, challengeIndex) % DRAW_LETTERS.length];
}

function BioDrawHeader() {
  return (
    <header>
      <h1>
        ARGUS <span className="accent">PAIR</span>
      </h1>
      <p className="subtitle">Handwriting Biometric Captcha</p>
    </header>
  );
}

function BioDrawChallenge({ targetLetter }: { targetLetter: string }) {
  return (
    <>
      <div className="timer">00:30.000</div>
      <div className="challenge-digits">
        <div className="bio-draw-challenge" aria-label="Draw target">
          <span>DRAW</span>
          <strong>{targetLetter}</strong>
        </div>
      </div>
    </>
  );
}

function BioDrawActions({
  hasDrawn,
  actionLabel,
  onSend,
  onClear,
}: {
  hasDrawn: boolean;
  actionLabel: string;
  onSend(): void;
  onClear(): void;
}) {
  return (
    <div className="action-stack">
      <button
        type="button"
        disabled={!hasDrawn}
        onClick={onSend}
        className="btn btn-next btn-stack bio-draw-send"
      >
        {actionLabel}
      </button>
      <button
        type="button"
        disabled={!hasDrawn}
        onClick={onClear}
        className="btn btn-erase btn-stack bio-draw-erase"
      >
        Erase
      </button>
    </div>
  );
}

export function Dialpad({ nonce, challengeIndex = 0, actionLabel = 'Next', onSend }: DialpadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const targetLetter = useMemo(
    () => drawLetterFromNonce(nonce, challengeIndex),
    [nonce, challengeIndex]
  );

  function syncCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  useEffect(() => {
    syncCanvas();
    const frame = window.requestAnimationFrame(() => setHasDrawn(false));
    const canvas = canvasRef.current;
    if (!canvas) return () => window.cancelAnimationFrame(frame);
    const ro = new ResizeObserver(syncCanvas);
    ro.observe(canvas);
    return () => {
      window.cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [targetLetter]);

  function pointFromEvent(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    const ctx = event.currentTarget.getContext('2d');
    if (!ctx) return;
    drawingRef.current = true;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    setHasDrawn(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    const ctx = event.currentTarget.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    setHasDrawn(true);
  }

  function stopDrawing(event: PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function clear() {
    setHasDrawn(false);
    syncCanvas();
  }

  return (
    <div className="bio-draw app">
      <BioDrawHeader />
      <main>
        <BioDrawChallenge targetLetter={targetLetter} />
        <div className={`canvas-area ${hasDrawn ? 'canvas-active' : 'canvas-idle'}`}>
          <canvas
            ref={canvasRef}
            className="drawing-canvas bio-draw-canvas"
            aria-label="Draw the requested letter"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDrawing}
            onPointerCancel={stopDrawing}
          />
          {!hasDrawn && (
            <div className="canvas-overlay bio-draw-overlay">
              <p className="canvas-overlay-text">Draw the Character You See Above</p>
              <p className="canvas-overlay-start">-- CLICK HERE TO START --</p>
            </div>
          )}
        </div>
        <BioDrawActions
          hasDrawn={hasDrawn}
          actionLabel={actionLabel}
          onSend={onSend}
          onClear={clear}
        />
      </main>
    </div>
  );
}
