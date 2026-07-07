export interface PairTokenMintBody {
  wsUrl: string;
  e: string;
  pt: string;
  n: string;
  cPub: string;
  workerUrl: string;
  workerSha256: string;
  debug: boolean;
}

export type PairTokenMintBodyResult =
  | { ok: true; body: PairTokenMintBody }
  | { ok: false; status: 400; body: { error: 'invalid_pair_blob' } };

export function validatePairTokenMintBody(body: Record<string, unknown>): PairTokenMintBodyResult {
  const candidate = body as {
    wsUrl?: unknown;
    e?: unknown;
    pt?: unknown;
    n?: unknown;
    cPub?: unknown;
    workerUrl?: unknown;
    workerSha256?: unknown;
    debug?: unknown;
  };
  if (
    typeof candidate.wsUrl !== 'string' ||
    typeof candidate.e !== 'string' ||
    typeof candidate.pt !== 'string' ||
    typeof candidate.n !== 'string' ||
    typeof candidate.cPub !== 'string' ||
    typeof candidate.workerUrl !== 'string' ||
    typeof candidate.workerSha256 !== 'string'
  ) {
    return { ok: false, status: 400, body: { error: 'invalid_pair_blob' } };
  }

  return {
    ok: true,
    body: {
      wsUrl: candidate.wsUrl,
      e: candidate.e,
      pt: candidate.pt,
      n: candidate.n,
      cPub: candidate.cPub,
      workerUrl: candidate.workerUrl,
      workerSha256: candidate.workerSha256,
      debug: candidate.debug === true,
    },
  };
}
