#!/usr/bin/env npx tsx
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
/* eslint-disable import-x/order -- @ts-expect-error must remain attached to its import */
// @ts-expect-error JS module sourced for parity with print-pair-host.mjs
import { config as pairConfig } from './pair-config.mjs';
import { PairStack } from '../lib/pair-stack';
/* eslint-enable import-x/order */

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID || '';

const merchantApiUrl = app.node.tryGetContext('merchantApiUrl') as string | undefined;
const merchantApiCredential = app.node.tryGetContext('merchantApiCredential') as string | undefined;
const merchantCpi = app.node.tryGetContext('merchantCpi') as string | undefined;
const oauthGoogleClientId = app.node.tryGetContext('oauthGoogleClientId') as string | undefined;
const oauthGithubClientId = app.node.tryGetContext('oauthGithubClientId') as string | undefined;
const oauthGithubClientSecretArn = app.node.tryGetContext('oauthGithubClientSecretArn') as
  | string
  | undefined;
const oauthFacebookAppId = app.node.tryGetContext('oauthFacebookAppId') as string | undefined;
const oauthFacebookAppSecretArn = app.node.tryGetContext('oauthFacebookAppSecretArn') as
  | string
  | undefined;

new PairStack(app, 'ms-argus-pair-dev-jw', {
  env: { account, region: 'us-east-1' },
  stackName: 'ms-argus-pair-dev-jw',
  rootDomain: pairConfig.rootDomain,
  subdomain: pairConfig.subdomain,
  additionalAliases: pairConfig.additionalAliases,
  merchantApiUrl,
  merchantApiCredential,
  merchantCpi,
  oauthGoogleClientId,
  oauthGithubClientId,
  oauthGithubClientSecretArn,
  oauthFacebookAppId,
  oauthFacebookAppSecretArn,
  synthesizer: new CliCredentialsStackSynthesizer(),
});

app.synth();
