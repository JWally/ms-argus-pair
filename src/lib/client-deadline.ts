export class ClientDeadlineError extends Error {
  readonly name = 'ClientDeadlineError';

  constructor(
    public readonly stage: string,
    public readonly timeoutMs: number
  ) {
    super(`${stage} timed out. Please try again.`);
  }
}

export async function awaitWithDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  stage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ClientDeadlineError(stage, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  stage: string
): Promise<Response> {
  const controller = new AbortController();
  let didTimeout = false;
  const forwardAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) forwardAbort();
  else init.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (cause) {
    if (didTimeout) throw new ClientDeadlineError(stage, timeoutMs);
    throw cause;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', forwardAbort);
  }
}
