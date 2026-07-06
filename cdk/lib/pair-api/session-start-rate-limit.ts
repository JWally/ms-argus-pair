import { createHash } from 'crypto';

export const SESSION_START_RL_MAX = 20;
export const SESSION_START_RL_WINDOW_SEC = 60;

export interface SessionStartRateLimit {
  bucket: string;
  window: number;
  max: number;
  windowSec: number;
  ttlSeconds: number;
  valkeyCap: number;
  ddbKey: { PK: string; SK: 'CT' };
}

export function buildSessionStartRateLimit(ip: string, nowMs = Date.now()): SessionStartRateLimit {
  const windowSec = SESSION_START_RL_WINDOW_SEC;
  const window = Math.floor(nowMs / (windowSec * 1000));
  const bucket = createHash('sha256')
    .update(`ss:${ip || 'unknown'}`)
    .digest('hex')
    .slice(0, 32);

  return {
    bucket,
    window,
    max: SESSION_START_RL_MAX,
    windowSec,
    ttlSeconds: windowSec + 60,
    valkeyCap: SESSION_START_RL_MAX + 1,
    ddbKey: { PK: `RL#${bucket}#${window}`, SK: 'CT' },
  };
}
