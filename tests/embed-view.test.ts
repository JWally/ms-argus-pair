import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmbedView, type EmbedViewProps } from '../src/pages/EmbedView';

function render(overrides: Partial<EmbedViewProps> = {}): string {
  const props: EmbedViewProps = {
    compact: false,
    qrReady: false,
    qrImageUrl: null,
    connected: false,
    presentation: {
      phase: 'scanning',
      title: 'Scan with your phone',
      instruction: "Open your phone's camera and point it at the code.",
      trackStatus: 'WAITING FOR PHONE',
    },
    ...overrides,
  };
  return renderToStaticMarkup(createElement(EmbedView, props));
}

describe('captcha embed view', () => {
  it('renders the initial scan state without a broken image', () => {
    const markup = render();

    expect(markup).toContain('class="aegis scanning"');
    expect(markup).toContain('ax-tile-load');
    expect(markup).toContain('Scan with your phone');
    expect(markup).toContain('WAITING FOR PHONE');
    expect(markup).not.toContain('<img');
  });

  it('renders a ready compact QR and connected phone track', () => {
    const markup = render({
      compact: true,
      qrReady: true,
      qrImageUrl: 'blob:qr-image',
      connected: true,
      presentation: {
        phase: 'pairing',
        title: 'Phone connected',
        instruction: 'Finishing check...',
        trackStatus: 'PHONE CONNECTED',
      },
    });

    expect(markup).toContain('class="aegis pairing compact"');
    expect(markup).toContain('src="blob:qr-image"');
    expect(markup).toContain('image-rendering:pixelated');
    expect(markup).toContain('Phone connected');
    expect(markup).toContain('ax-node here');
  });

  it.each([
    ['verified', 'Verified', 'CHECK COMPLETE'],
    ['timeout', "Didn't connect in time", 'CONNECTION TIMED OUT'],
    ['failed', "Couldn't verify", 'CHECK ENDED'],
  ] as const)('renders the %s terminal state', (phase, title, trackStatus) => {
    const markup = render({
      presentation: { phase, title, instruction: 'terminal detail', trackStatus },
    });

    expect(markup).toContain(`class="aegis ${phase}"`);
    expect(markup).toContain(title.replaceAll("'", '&#x27;'));
    expect(markup).toContain(trackStatus);
    expect(markup).toContain('ax-ring');
  });
});
