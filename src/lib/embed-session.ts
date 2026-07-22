import {
  startDesktopSession,
  type DesktopSession,
  type PairEvents,
  type StartDesktopOptions,
} from './pair';
import type { SecureQrImage } from './qr-keyholder';
import { isPairSessionTimeout } from './pair-timeout';
import type { EmbedCompletion } from './embed-presentation';

export type EmbedHostMessage =
  | { event: 'ready'; sessionId: string }
  | { event: 'connected' }
  | { event: 'size'; height: number }
  | {
      event: 'result';
      sessionId: string;
      verdict: string;
      reason: string | null;
      token: string | null;
    }
  | { event: 'error'; message: string };

export interface EmbedSessionInput {
  cpi?: string;
  challengeId?: string;
}

export interface EmbedSessionCallbacks {
  onConnected(): void;
  onQrReady(imageUrl: string | null): void;
  onQrFrame(imageUrl: string): void;
  onCompletion(completion: Exclude<EmbedCompletion, null>): void;
  notifyHost(message: EmbedHostMessage): void;
}

export interface EmbedSessionDependencies {
  startSession(events: PairEvents, options: StartDesktopOptions): Promise<DesktopSession>;
  createImageUrl(frame: Uint8Array, mime: 'image/png'): string;
  revokeImageUrl(imageUrl: string): void;
  setFrameTimer(callback: () => void, delayMs: number): number;
  clearFrameTimer(timer: number): void;
  isSessionTimeout(cause: unknown): boolean;
}

export interface EmbedSessionRun {
  finished: Promise<void>;
  stop(): void;
}

interface EmbedSessionResources {
  cancelled: boolean;
  session: DesktopSession | null;
  imageUrls: string[];
  frameTimer: number | null;
}

function notifyActive(
  resources: EmbedSessionResources,
  callbacks: EmbedSessionCallbacks,
  message: EmbedHostMessage
): void {
  if (!resources.cancelled) callbacks.notifyHost(message);
}

function installQrImages(
  qr: SecureQrImage,
  resources: EmbedSessionResources,
  callbacks: EmbedSessionCallbacks,
  dependencies: EmbedSessionDependencies
): void {
  const frames = qr.kind === 'png-frames' ? qr.frames : [qr.data];
  resources.imageUrls = frames.map((frame) => dependencies.createImageUrl(frame, qr.mime));
  callbacks.onQrReady(resources.imageUrls[0] ?? null);
  if (qr.kind !== 'png-frames' || resources.imageUrls.length < 2) return;

  let index = 0;
  resources.frameTimer = dependencies.setFrameTimer(() => {
    if (resources.cancelled) return;
    index = (index + 1) % resources.imageUrls.length;
    // eslint-disable-next-line security/detect-object-injection -- index is modulo frame count.
    callbacks.onQrFrame(resources.imageUrls[index]);
  }, qr.frameMs);
}

function sessionEvents(
  resources: EmbedSessionResources,
  callbacks: EmbedSessionCallbacks
): PairEvents {
  return {
    onPhoneConnected: () => {
      if (resources.cancelled) return;
      callbacks.onConnected();
      callbacks.notifyHost({ event: 'connected' });
    },
    onError: (cause) =>
      notifyActive(resources, callbacks, { event: 'error', message: String(cause) }),
  };
}

async function runSession(
  input: EmbedSessionInput,
  resources: EmbedSessionResources,
  callbacks: EmbedSessionCallbacks,
  dependencies: EmbedSessionDependencies
): Promise<void> {
  try {
    if (!input.challengeId) throw new Error('Missing or invalid merchant challenge');
    const session = await dependencies.startSession(sessionEvents(resources, callbacks), input);
    if (resources.cancelled) {
      session.stop();
      return;
    }
    resources.session = session;
    installQrImages(session.qr, resources, callbacks, dependencies);
    callbacks.notifyHost({ event: 'ready', sessionId: session.sessionId });

    const verdict = await session.result;
    if (resources.cancelled) return;
    const token = await session.getVerdictToken();
    if (resources.cancelled) return;
    callbacks.notifyHost({
      event: 'result',
      sessionId: session.sessionId,
      verdict: verdict.verdict,
      reason: verdict.reason,
      token,
    });
    callbacks.onCompletion(verdict.verdict === 'paired' ? 'paired' : 'failed');
  } catch (cause) {
    if (resources.cancelled) return;
    callbacks.onCompletion(dependencies.isSessionTimeout(cause) ? 'timeout' : 'failed');
    callbacks.notifyHost({ event: 'error', message: String(cause) });
  }
}

function stopSession(
  resources: EmbedSessionResources,
  dependencies: EmbedSessionDependencies
): void {
  if (resources.cancelled) return;
  resources.cancelled = true;
  if (resources.frameTimer !== null) dependencies.clearFrameTimer(resources.frameTimer);
  for (const imageUrl of resources.imageUrls) dependencies.revokeImageUrl(imageUrl);
  resources.imageUrls = [];
  resources.session?.stop();
}

const browserDependencies: EmbedSessionDependencies = {
  startSession: startDesktopSession,
  createImageUrl: (frame, mime) =>
    URL.createObjectURL(
      new Blob([Uint8Array.from(frame).buffer as ArrayBuffer], {
        type: mime,
      })
    ),
  revokeImageUrl: (imageUrl) => URL.revokeObjectURL(imageUrl),
  setFrameTimer: (callback, delayMs) => window.setInterval(callback, delayMs),
  clearFrameTimer: (timer) => window.clearInterval(timer),
  isSessionTimeout: isPairSessionTimeout,
};

export function startEmbedSession(
  input: EmbedSessionInput,
  callbacks: EmbedSessionCallbacks,
  dependencies: EmbedSessionDependencies = browserDependencies
): EmbedSessionRun {
  const resources: EmbedSessionResources = {
    cancelled: false,
    session: null,
    imageUrls: [],
    frameTimer: null,
  };
  return {
    finished: runSession(input, resources, callbacks, dependencies),
    stop: () => stopSession(resources, dependencies),
  };
}
