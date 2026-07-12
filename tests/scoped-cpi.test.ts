import { describe, expect, it } from 'vitest';
import { parseScopedCpi, requiresProofOfLife } from '../cdk/lib/pair-api/scoped-cpi.ts';

const BASE_CPI = 'argus_cpi_live_AbC123xYz789';

describe('scoped CPI policy', () => {
  it('keeps an unscoped CPI integrity-only by default', () => {
    expect(parseScopedCpi(BASE_CPI)).toEqual({
      cpi: BASE_CPI,
      scope: 'integrity',
      proofRequired: false,
      freshProofRequired: false,
    });
  });

  it('binds the stepup suffix to mandatory proof-of-life', () => {
    expect(parseScopedCpi(`${BASE_CPI}.stepup`)).toEqual({
      cpi: `${BASE_CPI}.stepup`,
      scope: 'stepup',
      proofRequired: true,
      freshProofRequired: false,
    });
  });

  it('accepts an explicit fastpass scope without requiring proof-of-life', () => {
    expect(parseScopedCpi(`${BASE_CPI}.fastpass`)).toEqual({
      cpi: `${BASE_CPI}.fastpass`,
      scope: 'fastpass',
      proofRequired: false,
      freshProofRequired: false,
    });
  });

  it('binds forceauth to fresh proof and disallows cached device trust', () => {
    expect(parseScopedCpi(`${BASE_CPI}.forceauth`)).toEqual({
      cpi: `${BASE_CPI}.forceauth`,
      scope: 'forceauth',
      proofRequired: true,
      freshProofRequired: true,
    });
  });

  it('rejects unknown or malformed scopes instead of silently downgrading', () => {
    expect(parseScopedCpi(`${BASE_CPI}.stepup_70`)).toBeNull();
    expect(parseScopedCpi(`${BASE_CPI}.anything`)).toBeNull();
    expect(parseScopedCpi('not-a-cpi.stepup')).toBeNull();
  });

  it('retains the operator global strict-mode override', () => {
    expect(requiresProofOfLife(parseScopedCpi(BASE_CPI), true)).toBe(true);
    expect(requiresProofOfLife(parseScopedCpi(BASE_CPI), false)).toBe(false);
    expect(requiresProofOfLife(parseScopedCpi(`${BASE_CPI}.stepup`), false)).toBe(true);
  });
});
