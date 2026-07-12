export type CpiScope = 'integrity' | 'fastpass' | 'stepup' | 'forceauth';

export interface ScopedCpi {
  /** Exact public identifier. Verdicts bind this whole value, including scope. */
  cpi: string;
  scope: CpiScope;
  proofRequired: boolean;
  /** True when cached device trust cannot satisfy this session. */
  freshProofRequired: boolean;
}

const SCOPED_CPI_RE =
  /^(argus_cpi_(?:test|live)_[A-Za-z0-9]{10,40})(?:\.(fastpass|stepup|forceauth))?$/;

/** Parse a public integration id and resolve its server-owned assurance policy. */
export function parseScopedCpi(value: unknown): ScopedCpi | null {
  if (typeof value !== 'string') return null;
  const match = SCOPED_CPI_RE.exec(value);
  if (!match) return null;
  const suffix = match[2];
  const scope: CpiScope =
    suffix === 'stepup'
      ? 'stepup'
      : suffix === 'forceauth'
        ? 'forceauth'
        : suffix === 'fastpass'
          ? 'fastpass'
          : 'integrity';
  return {
    cpi: value,
    scope,
    proofRequired: scope === 'stepup' || scope === 'forceauth',
    freshProofRequired: scope === 'forceauth',
  };
}

/** Operator strict mode remains an emergency/global override. */
export function requiresProofOfLife(
  scopedCpi: ScopedCpi | null,
  globalRequirement: boolean
): boolean {
  return globalRequirement || scopedCpi?.proofRequired === true;
}
