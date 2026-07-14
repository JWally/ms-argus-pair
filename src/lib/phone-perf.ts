const HANDOFF_STORAGE_KEY = 'argus-pair:phone-perf-handoff';
// Keep the single best-effort beacon small even when a flow retries or fails.
const DEFAULT_MAX_EVENTS = 32;
const MAX_HANDOFF_AGE_MS = 5 * 60_000;

interface PhonePerfStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export type PhonePerfEvent = Record<string, unknown> & {
  event: string;
  elapsedMs: number;
};

export interface PhonePerfBatch extends Record<string, unknown> {
  version: 1;
  reason: string;
  elapsedMs: number;
  events: PhonePerfEvent[];
}

interface StoredPhonePerfHandoff {
  version: 1;
  sessionId: string;
  createdAtMs: number;
  startedAtMs: number;
  events: PhonePerfEvent[];
}

interface PhonePerfReporterOptions {
  currentSessionId: string | null;
  send: (batch: PhonePerfBatch) => void;
  now?: () => number;
  storage?: PhonePerfStorage;
  maxEvents?: number;
}

export interface PhonePerfReporter {
  record(event: string, fields?: Record<string, unknown>): void;
  flush(reason: string, fields?: Record<string, unknown>): boolean;
  handoff(sessionId: string): boolean;
}

function isPhonePerfEvent(value: unknown): value is PhonePerfEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.event === 'string' && Number.isFinite(event.elapsedMs);
}

function restoreHandoff({
  storage,
  currentSessionId,
  nowMs,
  maxEvents,
}: {
  storage?: PhonePerfStorage;
  currentSessionId: string | null;
  nowMs: number;
  maxEvents: number;
}): Pick<StoredPhonePerfHandoff, 'startedAtMs' | 'events'> | null {
  if (!storage || !currentSessionId) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(HANDOFF_STORAGE_KEY);
    storage.removeItem(HANDOFF_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as Partial<StoredPhonePerfHandoff>;
    const ageMs = nowMs - Number(stored.createdAtMs);
    if (
      stored.version !== 1 ||
      stored.sessionId !== currentSessionId ||
      !Number.isFinite(stored.startedAtMs) ||
      ageMs < 0 ||
      ageMs > MAX_HANDOFF_AGE_MS ||
      !Array.isArray(stored.events)
    ) {
      return null;
    }
    return {
      startedAtMs: Number(stored.startedAtMs),
      events: stored.events.filter(isPhonePerfEvent).slice(0, maxEvents),
    };
  } catch {
    return null;
  }
}

export function createPhonePerfReporter({
  currentSessionId,
  send,
  now = Date.now,
  storage,
  maxEvents = DEFAULT_MAX_EVENTS,
}: PhonePerfReporterOptions): PhonePerfReporter {
  const nowMs = now();
  const restored = restoreHandoff({ storage, currentSessionId, nowMs, maxEvents });
  const startedAtMs = restored?.startedAtMs ?? nowMs;
  const events = restored?.events ?? [];
  let isFlushed = false;
  let isHandedOff = false;

  return {
    record(event, fields = {}) {
      if (isFlushed || isHandedOff || events.length >= maxEvents) return;
      events.push({
        ...fields,
        event,
        elapsedMs: Math.max(0, Math.round(now() - startedAtMs)),
      });
    },

    flush(reason, fields = {}) {
      if (isFlushed || isHandedOff || events.length === 0) return false;
      isFlushed = true;
      send({
        ...fields,
        version: 1,
        reason,
        elapsedMs: Math.max(0, Math.round(now() - startedAtMs)),
        events: [...events],
      });
      return true;
    },

    handoff(sessionId) {
      if (!storage || isFlushed || isHandedOff || events.length === 0) return false;
      try {
        const handoff: StoredPhonePerfHandoff = {
          version: 1,
          sessionId,
          createdAtMs: now(),
          startedAtMs,
          events: [...events],
        };
        storage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
        isHandedOff = true;
        return true;
      } catch {
        return false;
      }
    },
  };
}
