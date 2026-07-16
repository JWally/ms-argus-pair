#!/usr/bin/env npx tsx
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
/* eslint-disable import-x/order -- @ts-expect-error must remain attached to its import */
// @ts-expect-error JS module sourced for parity with print-pair-host.mjs
import { config as pairConfig } from './pair-config.mjs';
import { PairStack } from '../lib/pair-stack';
import { CaptchaCdnStack } from '../lib/captcha-cdn/captcha-stack';
/* eslint-enable import-x/order */

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID || '';
const stage = process.env.PAIR_STAGE || 'dev-jw';

const merchantApiUrl = app.node.tryGetContext('merchantApiUrl') as string | undefined;
const merchantApiCredential = app.node.tryGetContext('merchantApiCredential') as string | undefined;
const merchantCpi = app.node.tryGetContext('merchantCpi') as string | undefined;
const oauthGoogleClientId = app.node.tryGetContext('oauthGoogleClientId') as string | undefined;
const ssoCallbackOrigins = String(app.node.tryGetContext('ssoCallbackOrigins') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

new PairStack(app, 'ms-argus-pair-dev-jw', {
  env: { account, region: 'us-east-1' },
  stackName: 'ms-argus-pair-dev-jw',
  rootDomain: pairConfig.rootDomain,
  subdomain: pairConfig.subdomain,
  additionalAliases: pairConfig.additionalAliases,
  merchantApiUrl,
  merchantApiCredential,
  merchantCpi,
  ssoCallbackOrigins,
  oauthGoogleClientId,
  synthesizer: new CliCredentialsStackSynthesizer(),
});

// CDN for the embeddable loader (static-captcha[-stage].argus.pw). Separate
// stack so the loader's SRI/caching/deploy stay decoupled from the app+backend.
// Folded in from the retired ms-argus-captcha repo.
new CaptchaCdnStack(app, `ms-argus-pair-captcha-${stage}`, {
  env: { account, region: 'us-east-1' },
  stackName: `ms-argus-pair-captcha-${stage}`,
  stage,
  customDomain: `static-captcha-${stage}.argus.pw`,
  rootDomain: pairConfig.rootDomain,
  synthesizer: new CliCredentialsStackSynthesizer(),
});

app.synth();
