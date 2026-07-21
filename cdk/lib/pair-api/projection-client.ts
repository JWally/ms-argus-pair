import type { MerchantProjection } from './merchant-projection';
import { parseMerchantProjection } from './projection-contract';

const MERCHANT_API_URL = process.env.MERCHANT_API_URL || '';
const MERCHANT_API_CREDENTIAL = process.env.MERCHANT_API_CREDENTIAL || '';
const MERCHANT_CPI = process.env.MERCHANT_CPI || '';

type ProjectionFailureReason =
  | 'config_missing'
  | 'credential_malformed'
  | 'unauthorized'
  | 'insufficient_credits'
  | 'not_found'
  | 'conflict'
  | 'upstream_error'
  | 'http_error'
  | 'invalid_json'
  | 'invalid_projection'
  | 'network_error';

export type ProjectionFetchResult =
  | { ok: true; projection: MerchantProjection }
  | { ok: false; reason: ProjectionFailureReason; status?: number };

interface ProjectionClientConfig {
  apiUrl: string;
  credential: string;
  cpi: string;
  fetch: typeof fetch;
  warn: (message: string) => void;
}

export function splitCredential(credential: string): { keyId: string; token: string } {
  const idx = credential.indexOf('.');
  if (idx <= 0 || idx === credential.length - 1) {
    throw new Error('credential malformed: expected non-empty keyId.token');
  }
  return { keyId: credential.slice(0, idx), token: credential.slice(idx + 1) };
}

function failureReasonForStatus(status: number): ProjectionFailureReason {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'insufficient_credits';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'upstream_error';
  return 'http_error';
}

async function httpFailure(
  response: Response,
  argusSessionId: string,
  warn: ProjectionClientConfig['warn']
): Promise<ProjectionFetchResult> {
  const body = await response.text().catch(() => '');
  warn(
    `[pair] fetchProjection: ${response.status} for argusSessionId=${argusSessionId} ` +
      `body=${body.slice(0, 200)}`
  );
  return { ok: false, reason: failureReasonForStatus(response.status), status: response.status };
}

export function createProjectionClient(config: ProjectionClientConfig) {
  return {
    async fetchProjection(argusSessionId: string): Promise<ProjectionFetchResult> {
      if (!config.apiUrl || !config.credential || !config.cpi) {
        config.warn('[pair] fetchProjection: merchant config missing');
        return { ok: false, reason: 'config_missing' };
      }
      let credential: ReturnType<typeof splitCredential>;
      try {
        credential = splitCredential(config.credential);
      } catch {
        config.warn('[pair] fetchProjection: merchant credential malformed');
        return { ok: false, reason: 'credential_malformed' };
      }
      const url = `${config.apiUrl}/v1/session/${encodeURIComponent(config.cpi)}/${encodeURIComponent(argusSessionId)}`;
      try {
        const response = await config.fetch(url, {
          method: 'GET',
          headers: { 'x-api-key': credential.keyId, 'x-argus-token': credential.token },
        });
        if (!response.ok) return httpFailure(response, argusSessionId, config.warn);
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          config.warn(`[pair] fetchProjection: invalid JSON for argusSessionId=${argusSessionId}`);
          return { ok: false, reason: 'invalid_json' };
        }
        const parsed = parseMerchantProjection(body);
        if (!parsed.ok) {
          config.warn(
            `[pair] fetchProjection: incompatible projection for ` +
              `argusSessionId=${argusSessionId} error=${parsed.error}`
          );
          return { ok: false, reason: 'invalid_projection' };
        }
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        config.warn(`[pair] fetchProjection: network error ${message}`);
        return { ok: false, reason: 'network_error' };
      }
    },
  };
}

const defaultClient = createProjectionClient({
  apiUrl: MERCHANT_API_URL,
  credential: MERCHANT_API_CREDENTIAL,
  cpi: MERCHANT_CPI,
  fetch,
  warn: (message) => console.warn(message),
});

export function fetchProjection(argusSessionId: string): Promise<ProjectionFetchResult> {
  return defaultClient.fetchProjection(argusSessionId);
}

export function projectionValue(result: ProjectionFetchResult): MerchantProjection | null {
  return result.ok ? result.projection : null;
}
