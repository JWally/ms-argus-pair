import type { DesktopVerdict, DesktopVerdictGate } from './desktop-verdict-gate';
import type { SealedVerdictEnvelope } from './verdict-envelope';

const MAX_POLL_DELAY_MS = 10_000;
const MIN_BACKOFF_DELAY_MS = 2_000;
const SEALED_RELEASE_POLL_DELAY_MS = 500;

type ResultPollGate = Pick<
  DesktopVerdictGate,
  'isSettled' | 'hasHeldVerdict' | 'settle' | 'receiveSealedVerdict' | 'receiveRevealKey'
>;

type ResultResponse = Pick<Response, 'status' | 'json'>;
type FetchResult = (input: string, init: RequestInit) => Promise<ResultResponse>;
type Wait = (delayMs: number) => Promise<void>;

interface SealedResult {
  status: 'sealed';
  envelope: SealedVerdictEnvelope;
  revealKey?: string;
}

export interface DesktopResultPoll {
  start(initialDelayMs: number): Promise<void>;
}

export interface DesktopResultPollOptions {
  sessionId: string;
  desktopToken: string;
  gate: ResultPollGate;
  isCancelled: () => boolean;
  apiBase?: string;
  fetchResult?: FetchResult;
  wait?: Wait;
}

function isSealedResult(value: unknown): value is SealedResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'sealed'
  );
}

function nextPollDelay(currentDelayMs: number): number {
  return Math.min(
    MAX_POLL_DELAY_MS,
    Math.max(MIN_BACKOFF_DELAY_MS, Math.round(currentDelayMs * 1.5))
  );
}

async function handleCompletedResult(
  response: ResultResponse,
  gate: ResultPollGate
): Promise<'stop' | 'sealed-pending'> {
  const result: unknown = await response.json();
  if (!isSealedResult(result)) {
    gate.settle(result as DesktopVerdict);
    return 'stop';
  }

  await gate.receiveSealedVerdict(result.envelope);
  if (result.revealKey) await gate.receiveRevealKey(result.revealKey);
  return gate.isSettled() || gate.hasHeldVerdict() ? 'stop' : 'sealed-pending';
}

async function runResultPoll(
  options: DesktopResultPollOptions,
  fetchResult: FetchResult,
  wait: Wait,
  initialDelayMs: number
): Promise<void> {
  let delayMs = initialDelayMs;
  const shouldStop = () =>
    options.isCancelled() || options.gate.isSettled() || options.gate.hasHeldVerdict();

  while (!shouldStop()) {
    await wait(delayMs);
    delayMs = nextPollDelay(delayMs);
    if (shouldStop()) return;

    try {
      const response = await fetchResult(
        `${options.apiBase ?? '/api'}/session/${options.sessionId}/result?t=${encodeURIComponent(
          options.desktopToken
        )}`,
        { headers: { accept: 'application/json' } }
      );
      if (response.status === 200) {
        const outcome = await handleCompletedResult(response, options.gate);
        if (outcome === 'stop') return;
        delayMs = SEALED_RELEASE_POLL_DELAY_MS;
        continue;
      }
      if (response.status !== 204) return;
    } catch {
      // Transient transport or decoding failure: retry until the gate or TTL stops us.
    }
  }
}

export function createDesktopResultPoll(options: DesktopResultPollOptions): DesktopResultPoll {
  const fetchResult: FetchResult =
    options.fetchResult ?? ((input, init) => globalThis.fetch(input, init));
  const wait: Wait =
    options.wait ??
    ((delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)));
  let task: Promise<void> | null = null;

  return {
    start(initialDelayMs) {
      task ??= runResultPoll(options, fetchResult, wait, initialDelayMs);
      return task;
    },
  };
}
