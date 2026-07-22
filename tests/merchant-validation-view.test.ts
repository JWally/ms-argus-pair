import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  MerchantValidationView,
  type MerchantValidationViewProps,
} from '../src/pages/MerchantValidationView';

function render(overrides: Partial<MerchantValidationViewProps> = {}): string {
  const props: MerchantValidationViewProps = {
    isMerchantCallback: false,
    approved: false,
    failed: false,
    returningToSite: false,
    needsProof: false,
    validating: false,
    passkeySeen: false,
    resultReason: null,
    error: null,
    isGoogleConfigured: false,
    onProof: vi.fn(),
    onReturn: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/merchant/validate'] },
      createElement(MerchantValidationView, props)
    )
  );
}

describe('merchant callback validation view', () => {
  it('shows explicit proof choices without disclosing a verdict', () => {
    const markup = render({
      isMerchantCallback: true,
      needsProof: true,
      isGoogleConfigured: true,
    });

    expect(markup).toContain('Confirm your identity');
    expect(markup).toContain('Create passkey');
    expect(markup).toContain('Continue with Google');
    expect(markup).not.toContain('Session is Not Valid');
  });

  it('shows passkey authentication and creation when a credential hint exists', () => {
    const markup = render({
      isMerchantCallback: true,
      needsProof: true,
      passkeySeen: true,
    });

    expect(markup).toContain('Use passkey');
    expect(markup).toContain('Create passkey');
  });

  it('shows the manual return action only for a terminal automatic-return error', () => {
    const markup = render({
      isMerchantCallback: true,
      failed: true,
      error: 'return failed',
    });

    expect(markup).toContain('Automatic return unavailable');
    expect(markup).toContain('>RETURN<');
  });

  it('shows a neutral busy handoff while returning to the site', () => {
    const markup = render({
      isMerchantCallback: true,
      approved: true,
      returningToSite: true,
      validating: true,
    });

    expect(markup).toContain('Returning securely');
    expect(markup).toContain('Finishing the secure handoff.');
    expect(markup).not.toContain('approved');
  });
});

describe('merchant demo validation view', () => {
  it('renders a neutral state before validation resolves', () => {
    const markup = render();

    expect(markup).toContain('Validating session');
    expect(markup).toContain('checking return');
  });

  it('renders the approved redemption state', () => {
    const markup = render({ approved: true });

    expect(markup).toContain('Returned from Argus');
    expect(markup).toContain('Returning securely');
    expect(markup).toContain('redeeming approval');
    expect(markup).toContain('is-approved');
  });

  it('renders a failed reason and a route back to the merchant demo', () => {
    const markup = render({
      failed: true,
      resultReason: 'continuity_failed',
    });

    expect(markup).toContain('Session could not be confirmed');
    expect(markup).toContain('continuity failed');
    expect(markup).toContain('href="/merchant"');
    expect(markup).toContain('>BACK<');
  });

  it('renders the proof section while validation is pending', () => {
    const markup = render({ needsProof: true, validating: true });

    expect(markup).toContain('Confirm your identity');
    expect(markup).toContain('Proof required');
    expect(markup).toContain('disabled=""');
  });
});
