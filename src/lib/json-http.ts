import { fetchWithDeadline } from './client-deadline';

const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

/** Carries structured details for control flow without exposing them to UI text. */
export class HttpError extends Error {
  readonly name = 'HttpError';

  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly bodyJson: Record<string, unknown> | null
  ) {
    super(`Request failed (${status}). Please try again.`);
  }
}

export async function jsonFetch<T>(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<T> {
  const url = `${input}${input.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const response = await fetchWithDeadline(
    url,
    {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    },
    timeoutMs,
    'pair_http'
  );
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const bodyText = (await response.text()).slice(0, 80).replace(/\s+/g, ' ');
    throw new HttpError(response.status, bodyText, null);
  }
  if (!response.ok) {
    const bodyText = await response.text();
    let bodyJson: Record<string, unknown> | null = null;
    try {
      bodyJson = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      // Keep the raw body available to diagnostics; UI receives only Error.message.
    }
    throw new HttpError(response.status, bodyText, bodyJson);
  }
  return response.json() as Promise<T>;
}
