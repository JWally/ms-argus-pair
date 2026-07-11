/*
 * Spec for the verdict token (cdk/lib/pair-api/verdict-token.ts) and the
 * admit/deny contract of POST /api/verify.
 *
 * Red-team (2026-07-03) footgun: /api/verify returns valid:true for ANY
 * authentic token, including one whose verdict is "failed". Merchants must
 * gate on `passed` (verdict === "paired"), never on `valid` alone. This locks
 * in both the signature semantics and that derivation.
 */
import { describe, expect, it } from 'vitest';
import {
  signVerdict,
  verifyVerdictForCpi,
  verifyVerdictToken,
  VERDICT_TOKEN_TTL_SEC,
} from '../cdk/lib/pair-api/verdict-token.ts';

const SECRET = 'test-secret-abc';
const base = { cpi: 'argus_cpi_test_x', sessionId: 'sess-1', reason: null };

/** Mirror the /api/verify admit derivation. */
const passed = (verdict: string) => verdict === 'paired';

describe('verdict token', () => {
  it('round-trips authentic claims', () => {
    const token = signVerdict(SECRET, { ...base, verdict: 'paired' });
    const r = verifyVerdictToken(SECRET, token);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.verdict).toBe('paired');
  });

  it('binds the exact scoped CPI so a step-up result cannot be substituted', () => {
    const scopedCpi = 'argus_cpi_live_AbC123xYz789.stepup';
    const token = signVerdict(SECRET, { ...base, cpi: scopedCpi, verdict: 'paired' });
    const r = verifyVerdictToken(SECRET, token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.cpi).toBe(scopedCpi);
      expect(r.claims.cpi).not.toBe('argus_cpi_live_AbC123xYz789');
    }
    expect(verifyVerdictForCpi(SECRET, token, scopedCpi).ok).toBe(true);
    expect(verifyVerdictForCpi(SECRET, token, 'argus_cpi_live_AbC123xYz789')).toEqual({
      ok: false,
      reason: 'cpi_mismatch',
    });
  });

  it('rejects a wrong-secret signature', () => {
    const token = signVerdict(SECRET, { ...base, verdict: 'paired' });
    expect(verifyVerdictToken('other-secret', token).ok).toBe(false);
  });

  it('rejects a tampered verdict (paired forged onto a signed failed token)', () => {
    const token = signVerdict(SECRET, { ...base, verdict: 'failed' });
    const [payload, mac] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    claims.verdict = 'paired';
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${mac}`;
    expect(verifyVerdictToken(SECRET, forged).ok).toBe(false);
  });

  it('rejects an expired token', () => {
    const past = Date.now() - (VERDICT_TOKEN_TTL_SEC + 5) * 1000;
    const token = signVerdict(SECRET, { ...base, verdict: 'paired' }, past);
    expect(verifyVerdictToken(SECRET, token).ok).toBe(false);
  });

  it('admit bit (passed) tracks verdict, not signature validity', () => {
    // A genuine, authentic token can still carry a "failed" verdict — the
    // whole point of the red-team finding.
    const failedTok = signVerdict(SECRET, { ...base, verdict: 'failed' });
    const r = verifyVerdictToken(SECRET, failedTok);
    expect(r.ok).toBe(true); // signature is valid…
    if (r.ok) expect(passed(r.claims.verdict)).toBe(false); // …but the human did NOT pass
    expect(passed('paired')).toBe(true);
  });
});
