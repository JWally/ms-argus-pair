import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repository fixtures.
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('captcha embed guidance', () => {
  it('starts with a concrete camera instruction and delays troubleshooting help', async () => {
    const embed = await read('src/pages/Embed.tsx');

    expect(embed).toContain("Open your phone's camera and point it at the code.");
    expect(embed).toContain('Having trouble? Move your phone slightly farther away.');
    expect(embed).toContain('const SCAN_HINT_DELAY_MS = 7_000;');
    expect(embed).toMatch(/if \(!qrReady \|\| connected \|\| done\) return;/);
  });

  it('names each connection state inside the existing device track', async () => {
    const [embed, css] = await Promise.all([
      read('src/pages/Embed.tsx'),
      read('src/pages/embed.css'),
    ]);

    expect(embed).toContain("scanning: 'WAITING FOR PHONE'");
    expect(embed).toContain("pairing: 'PHONE CONNECTED'");
    expect(embed).toContain("pairing: { title: 'Phone connected', sub: 'Finishing check...' }");
    expect(embed).toContain('className="ax-track-label"');
    expect(css).toContain('.aegis .ax-track-label');
  });
});
