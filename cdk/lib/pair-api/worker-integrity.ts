import { createHash } from 'crypto';

const workerHashCache = new Map<string, string>();

export type WorkerIntegrityResult =
  | { ok: true }
  | { ok: false; status: 400; error: 'worker_integrity_invalid'; reason: string };

function sha256Base64url(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

function allowedWorkerOrigin(origin: string): boolean {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  return allowed.length === 0 || allowed.includes(origin);
}

export async function verifyWorkerIntegrity(input: {
  workerUrl: unknown;
  workerSha256: unknown;
}): Promise<WorkerIntegrityResult> {
  if (typeof input.workerUrl !== 'string' || typeof input.workerSha256 !== 'string') {
    return { ok: false, status: 400, error: 'worker_integrity_invalid', reason: 'missing' };
  }
  let url: URL;
  try {
    url = new URL(input.workerUrl);
  } catch {
    return { ok: false, status: 400, error: 'worker_integrity_invalid', reason: 'bad_url' };
  }
  if (url.protocol !== 'https:' || !allowedWorkerOrigin(url.origin)) {
    return { ok: false, status: 400, error: 'worker_integrity_invalid', reason: 'bad_origin' };
  }
  if (!/^sha256-[A-Za-z0-9_-]{43}$/.test(input.workerSha256)) {
    return { ok: false, status: 400, error: 'worker_integrity_invalid', reason: 'bad_hash' };
  }

  const expected =
    workerHashCache.get(url.href) ??
    (await (async () => {
      const res = await fetch(url.href, { method: 'GET' });
      if (!res.ok) throw new Error(`fetch_${res.status}`);
      const hash = `sha256-${sha256Base64url(Buffer.from(await res.arrayBuffer()))}`;
      workerHashCache.set(url.href, hash);
      return hash;
    })());

  if (input.workerSha256 !== expected) {
    return { ok: false, status: 400, error: 'worker_integrity_invalid', reason: 'hash_mismatch' };
  }
  return { ok: true };
}

export function clearWorkerIntegrityCacheForTests(): void {
  workerHashCache.clear();
}
