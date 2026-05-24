// Single source of truth for the canonical phone-pair domain.
// Consumed by:
//   - cdk/bin/app.ts (CDK stack inputs: rootDomain, subdomain, additionalAliases)
//   - cdk/bin/print-pair-host.mjs (deploy script — exports VITE_PAIR_URL_BASE)
//
// To add another environment (qa, prod) flip on AWS_ENV or similar
// and return a different ENV record here.
const ENV = {
  'dev-jw': {
    rootDomain: 'argus.pw',
    subdomain: 'captcha-dev-jw',
    additionalAliases: [{ rootDomain: 'arcades.click', subdomain: 'qr' }],
  },
};

const stage = process.env.PAIR_STAGE || 'dev-jw';
const cfg = ENV[stage];
if (!cfg) {
  throw new Error(`unknown PAIR_STAGE: ${stage}`);
}

export const config = {
  ...cfg,
  /** Canonical FQDN — the QR points here regardless of which alias served the desktop. */
  canonicalHost: `${cfg.subdomain}.${cfg.rootDomain}`,
};
