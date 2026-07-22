import { describe, expect, it } from 'vitest';
import { renderPhonePanelView, renderPhoneReadyView } from '../src/lib/phone-view';

describe('phone views', () => {
  it('renders the returning-device action without alternate proof buttons', () => {
    const html = renderPhoneReadyView({
      canUseTrust: true,
      googleConfigured: true,
      debug: false,
      errorMessage: null,
    });

    expect(html).toContain('data-action="confirm"');
    expect(html).not.toContain('data-action="passkey"');
    expect(html).toContain('Trusted device · same network');
  });

  it('renders configured proof choices and escapes errors', () => {
    const html = renderPhoneReadyView({
      canUseTrust: false,
      googleConfigured: true,
      debug: true,
      errorMessage: '<expired & retry>',
    });

    expect(html).toContain('data-action="passkey"');
    expect(html).toContain('data-action="passkey-create"');
    expect(html).toContain('data-action="google"');
    expect(html).toContain('&lt;expired &amp; retry&gt;');
    expect(html).toContain('<span class="pill">debug</span>');
  });

  it('keeps terminal phone copy neutral and escapes server text', () => {
    expect(
      renderPhonePanelView({
        phase: 'paired',
        status: '',
        verdict: 'failed',
        errorMessage: null,
        debug: false,
      })
    ).toContain('You can close this tab. The desktop has the result.');

    expect(
      renderPhonePanelView({
        phase: 'error',
        status: '',
        verdict: null,
        errorMessage: '<bad response>',
        debug: false,
      })
    ).toContain('&lt;bad response&gt;');
  });
});
