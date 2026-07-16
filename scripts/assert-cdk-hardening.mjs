import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = mkdtempSync(path.join(tmpdir(), 'argus-pair-cdk-'));
const loaderDirectory = path.join(root, 'loader', 'dist');
const createdLoaderFixture = !existsSync(loaderDirectory);

if (createdLoaderFixture) {
  mkdirSync(loaderDirectory, { recursive: true });
  writeFileSync(path.join(loaderDirectory, 'captcha.js'), '// CDK hardening synth fixture\n');
}

function fail(message) {
  console.error(`[cdk-hardening] ${message}`);
  process.exitCode = 1;
}

function synthesizeTemplate() {
  const result = spawnSync(
    'npx',
    [
      'cdk',
      'synth',
      'ms-argus-pair-dev-jw',
      '--quiet',
      '--output',
      outputDirectory,
      '-c',
      'merchantApiUrl=https://merchant.example.invalid',
      '-c',
      'merchantApiCredential=hardening-test-credential',
      '-c',
      'merchantCpi=argus_cpi_test_Hardening12345.fastpass',
    ],
    { cwd: root, env: process.env, stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error(`CDK synth failed with status ${result.status}`);
  const templatePath = path.join(outputDirectory, 'ms-argus-pair-dev-jw.template.json');
  return JSON.parse(readFileSync(templatePath, 'utf8'));
}

function assertPolicy(resource, label, expectedFrameOption) {
  if (!resource) return fail(`${label} response headers policy is missing`);
  const security = resource.Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig ?? {};
  const actualFrameOption = security.FrameOptions?.FrameOption;
  if (actualFrameOption !== expectedFrameOption) {
    fail(
      `${label} frame option is ${actualFrameOption ?? 'unset'}, expected ${expectedFrameOption}`
    );
  }
  if (!security.StrictTransportSecurity?.IncludeSubdomains) {
    fail(`${label} HSTS includeSubDomains is missing`);
  }
  if (security.StrictTransportSecurity?.AccessControlMaxAgeSec < 31_536_000) {
    fail(`${label} HSTS max-age is below one year`);
  }
  if (security.ContentSecurityPolicy) {
    fail(`${label} should not emit CSP from the response headers policy`);
  }
  if (!security.ContentTypeOptions?.Override) fail(`${label} nosniff policy is missing`);
}

try {
  const template = synthesizeTemplate();
  const entries = Object.entries(template.Resources ?? {});

  const distributions = entries.filter(
    ([, resource]) => resource.Type === 'AWS::CloudFront::Distribution'
  );
  if (distributions.length !== 1) {
    fail(`expected 1 CloudFront distribution, found ${distributions.length}`);
  }

  const distributionConfig = distributions[0]?.[1].Properties?.DistributionConfig;
  if (distributionConfig?.CustomErrorResponses) {
    fail('distribution still has CustomErrorResponses fallback');
  }
  if (!distributionConfig?.DefaultCacheBehavior?.FunctionAssociations?.length) {
    fail('default behavior is missing SPA router function association');
  }

  const policies = entries.filter(
    ([, resource]) => resource.Type === 'AWS::CloudFront::ResponseHeadersPolicy'
  );
  if (policies.length !== 2) fail(`expected 2 response headers policies, found ${policies.length}`);
  const [sitePolicyId, sitePolicy] =
    policies.find(([logicalId]) => logicalId.startsWith('SiteResponseHeaders')) ?? [];
  const [embedPolicyId, embedPolicy] =
    policies.find(([logicalId]) => logicalId.startsWith('EmbedResponseHeaders')) ?? [];
  assertPolicy(sitePolicy, 'site', 'DENY');
  assertPolicy(embedPolicy, 'embed', undefined);

  const defaultPolicyId = distributionConfig?.DefaultCacheBehavior?.ResponseHeadersPolicyId?.Ref;
  if (defaultPolicyId !== sitePolicyId) fail('default behavior does not use the site policy');
  const embedBehavior = distributionConfig?.CacheBehaviors?.find(
    (behavior) => behavior.PathPattern === '/embed'
  );
  if (embedBehavior?.ResponseHeadersPolicyId?.Ref !== embedPolicyId) {
    fail('/embed behavior does not use the iframe-compatible policy');
  }

  const functions = entries.filter(([, resource]) => resource.Type === 'AWS::CloudFront::Function');
  if (functions.length !== 1) fail(`expected 1 CloudFront function, found ${functions.length}`);

  const diagnosticRoutes = entries.filter(
    ([, resource]) =>
      resource.Type === 'AWS::ApiGatewayV2::Route' &&
      String(resource.Properties?.RouteKey ?? '').includes('_valkey-debug')
  );
  if (diagnosticRoutes.length > 0) fail('temporary Valkey diagnostic route is present');

  if (process.exitCode) process.exit(process.exitCode);
  console.log('[cdk-hardening] ok');
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
  if (createdLoaderFixture) rmSync(loaderDirectory, { recursive: true, force: true });
}
