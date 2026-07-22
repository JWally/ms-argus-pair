import { describe, expect, it, vi } from 'vitest';
import { mountPhoneDrawingBoard, selectDrawingChallenge } from '../src/lib/phone-drawing-board';

class FakeElement {
  readonly attributes = new Set<string>();
  readonly listeners = new Map<string, (event: PointerEvent) => void>();
  readonly classList = { toggle: vi.fn() };
  textContent = '';

  addEventListener(name: string, listener: (event: PointerEvent) => void): void {
    this.listeners.set(name, listener);
  }

  fire(name: string, event = {} as PointerEvent): void {
    this.listeners.get(name)?.(event);
  }

  setAttribute(name: string): void {
    this.attributes.add(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

describe('phone drawing challenge selection', () => {
  it('is deterministic for a nonce and challenge index', () => {
    const first = selectDrawingChallenge('nonce-123', 4);
    const second = selectDrawingChallenge('nonce-123', 4);

    expect(second).toEqual(first);
  });

  it('uses only unambiguous drawing letters', () => {
    const challenges = Array.from({ length: 64 }, (_, index) =>
      selectDrawingChallenge('nonce-123', index)
    );

    expect(new Set(challenges.map(({ letter }) => letter)).size).toBeGreaterThan(1);
    expect(challenges.every(({ letter }) => /^[A-HJ-NP-Z]$/.test(letter))).toBe(true);
  });

  it('returns a stable unsigned seed for the animated plate', () => {
    expect(selectDrawingChallenge('nonce-123', 4)).toEqual({
      letter: 'H',
      seed: 2_203_600_927,
    });
  });

  it('owns drawing interaction state and releases browser resources', () => {
    const context = {
      beginPath: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
      fillStyle: '',
      lineCap: '',
      lineJoin: '',
      lineWidth: 0,
      strokeStyle: '',
    };
    const canvas = Object.assign(new FakeElement(), {
      width: 0,
      height: 0,
      getContext: () => context,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 80 }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    });
    const plate = new FakeElement();
    const overlay = new FakeElement();
    const canvasArea = new FakeElement();
    const erase = new FakeElement();
    const send = new FakeElement();
    const elements = new Map<string, FakeElement>([
      ['.bio-draw-dot-canvas', plate],
      ['.bio-draw-canvas', canvas],
      ['.bio-draw-overlay', overlay],
      ['.canvas-area', canvasArea],
      ['.bio-draw-erase', erase],
      ['.bio-draw-send', send],
    ]);
    const root = {
      innerHTML: '',
      querySelector: (selector: string) => elements.get(selector) ?? null,
    };
    const stopPlate = vi.fn();
    const stopResize = vi.fn();
    const onStarted = vi.fn();
    const onAdvance = vi.fn();
    const vibrate = vi.fn();

    const board = mountPhoneDrawingBoard({
      root: root as unknown as HTMLElement,
      nonce: 'nonce-123',
      challengeIndex: 4,
      started: false,
      done: false,
      onStarted,
      onAdvance,
      platform: {
        startPlate: () => stopPlate,
        observeResize: () => stopResize,
        vibrate,
      },
    });

    expect(root.innerHTML).toContain('aria-label="Draw H"');
    expect(send.attributes.has('disabled')).toBe(true);

    canvas.fire('pointerdown', {
      pointerId: 7,
      clientX: 20,
      clientY: 30,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);
    canvas.fire('pointermove', {
      clientX: 40,
      clientY: 50,
      preventDefault: vi.fn(),
    } as unknown as PointerEvent);

    expect(onStarted).toHaveBeenCalledOnce();
    expect(vibrate).toHaveBeenCalledWith(5);
    expect(send.attributes.has('disabled')).toBe(false);
    expect(context.stroke).toHaveBeenCalledOnce();

    board.setDone(true);
    expect(send.textContent).toBe('DONE');
    send.fire('click');
    expect(onAdvance).toHaveBeenCalledOnce();

    board.stop();
    expect(stopPlate).toHaveBeenCalledOnce();
    expect(stopResize).toHaveBeenCalledOnce();
  });
});
