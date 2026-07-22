const CPI_FORMAT = /^argus_cpi_(test|live)_[A-Za-z0-9]{10,40}(?:\.(?:fastpass|stepup|forceauth))?$/;
const CHALLENGE_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

export interface EmbedConfig {
  hostOrigin: string;
  cpi: string | undefined;
  challengeId: string | undefined;
}

export interface EmbedViewportEnvelope {
  source: unknown;
  origin: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readEmbedConfig(search: string): EmbedConfig {
  const params = new URLSearchParams(search);
  const rawCpi = params.get('cpi') ?? '';
  const rawChallenge = params.get('challengeId') ?? '';
  return {
    hostOrigin: params.get('origin') || '*',
    cpi: CPI_FORMAT.test(rawCpi) ? rawCpi : undefined,
    challengeId: CHALLENGE_FORMAT.test(rawChallenge) ? rawChallenge : undefined,
  };
}

export function readEmbedViewportWidth(
  envelope: EmbedViewportEnvelope,
  expectedParent: unknown,
  hostOrigin: string
): number | null {
  if (envelope.source !== expectedParent) return null;
  if (hostOrigin !== '*' && envelope.origin !== hostOrigin) return null;
  if (!isRecord(envelope.data)) return null;
  if (envelope.data.source !== 'argus-captcha-host' || envelope.data.event !== 'viewport') {
    return null;
  }
  return typeof envelope.data.width === 'number' ? envelope.data.width : null;
}
