#!/usr/bin/env npx tsx
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { PairStack } from '../lib/pair-stack';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID || '';

const merchantApiUrl = app.node.tryGetContext('merchantApiUrl') as string | undefined;
const merchantApiCredential = app.node.tryGetContext('merchantApiCredential') as
  | string
  | undefined;
const merchantCpi = app.node.tryGetContext('merchantCpi') as string | undefined;

new PairStack(app, 'ms-argus-pair-dev-jw', {
  env: { account, region: 'us-east-1' },
  stackName: 'ms-argus-pair-dev-jw',
  rootDomain: 'argus.pw',
  subdomain: 'captcha-dev-jw',
  additionalAliases: [{ rootDomain: 'arcades.click', subdomain: 'qr' }],
  merchantApiUrl,
  merchantApiCredential,
  merchantCpi,
  synthesizer: new CliCredentialsStackSynthesizer(),
});

app.synth();
