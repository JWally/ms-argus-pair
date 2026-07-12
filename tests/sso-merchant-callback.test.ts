import { describe, expect, it } from 'vitest';
import { parseSsoMerchantCallback } from '../cdk/lib/pair-api/sso-merchant-callback';

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
});
