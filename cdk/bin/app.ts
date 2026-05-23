#!/usr/bin/env npx tsx
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { PairStack } from '../lib/pair-stack';

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID || '';

new PairStack(app, 'ms-argus-pair-dev-jw', {
  env: { account, region: 'us-east-1' },
  stackName: 'ms-argus-pair-dev-jw',
  stage: 'dev-jw',
  rootDomain: 'argus.pw',
  subdomain: 'captcha-dev-jw',
  synthesizer: new CliCredentialsStackSynthesizer(),
});

app.synth();
