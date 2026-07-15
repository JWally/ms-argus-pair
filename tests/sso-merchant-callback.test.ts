import { describe, expect, it } from 'vitest';
import {
  parseSsoMerchantCallback,
  ssoFailureReturn,
} from '../cdk/lib/pair-api/sso-merchant-callback';

const ALLOWED = ['https://arcades.click', 'https://www-dev-jw.argus.pw'];

describe('SSO merchant callback', () => {
  it('accepts an HTTPS callback from a configured merchant origin', () => {
    expect(
      parseSsoMerchantCallback('https://arcades.click/api/captcha/sso-return', ALLOWED)
    ).toEqual('https://arcades.click/api/captcha/sso-return');
  });

  it.each([
    'http://arcades.click/api/captcha/sso-return',
    'https://attacker.example/api/captcha/sso-return',
    'https://arcades.click.attacker.example/api/captcha/sso-return',
    'https://user@arcades.click/api/captcha/sso-return',
    'https://arcades.click/api/captcha/sso-return#leak',
  ])('rejects unsafe callback %s', (callback) => {
    expect(parseSsoMerchantCallback(callback, ALLOWED)).toBeNull();
  });

  it('builds a neutral failure return from the validated merchant binding', () => {
    const failureReturnUrl = ssoFailureReturn(
      'f495de2a-7747-4ad8-8c04-a06ce9044e4f',
      'argus_cpi_test_Example12345.fastpass',
      {
        merchantCallbackUrl: 'https://arcades.click/api/captcha/sso-return',
        merchantChallengeId: 'challenge_1234567890',
      }
    );

    const callback = new URL(failureReturnUrl);
    expect(callback.origin).toBe('https://arcades.click');
    expect(callback.searchParams.get('status')).toBe('failed');
    expect(callback.searchParams.get('challengeId')).toBe('challenge_1234567890');
    expect(callback.searchParams.has('code')).toBe(false);
  });

  it('returns the presentation merchant route when no external callback is bound', () => {
    expect(
      ssoFailureReturn(
        'f495de2a-7747-4ad8-8c04-a06ce9044e4f',
        'argus_cpi_test_Example12345.fastpass'
      )
    ).toBe(
      '/merchant?complete=1&session=f495de2a-7747-4ad8-8c04-a06ce9044e4f&cpi=argus_cpi_test_Example12345.fastpass&status=failed'
    );
  });
});
