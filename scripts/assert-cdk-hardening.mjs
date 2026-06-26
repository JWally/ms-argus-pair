import { readFileSync } from 'node:fs';

const templatePath = new URL('../cdk.out/ms-argus-pair-dev-jw.template.json', import.meta.url);
const template = JSON.parse(readFileSync(templatePath, 'utf8'));
const resources = Object.values(template.Resources ?? {});

function fail(message) {
  console.error(`[cdk-hardening] ${message}`);
  process.exitCode = 1;
}

const distributions = resources.filter((r) => r.Type === 'AWS::CloudFront::Distribution');
if (distributions.length !== 1)
  fail(`expected 1 CloudFront distribution, found ${distributions.length}`);

const distributionConfig = distributions[0]?.Properties?.DistributionConfig;
if (distributionConfig?.CustomErrorResponses) {
  fail('distribution still has CustomErrorResponses fallback');
}
if (!distributionConfig?.DefaultCacheBehavior?.FunctionAssociations?.length) {
  fail('default behavior is missing SPA router function association');
}
if (!distributionConfig?.DefaultCacheBehavior?.ResponseHeadersPolicyId) {
  fail('default behavior is missing response headers policy');
}

const policies = resources.filter((r) => r.Type === 'AWS::CloudFront::ResponseHeadersPolicy');
if (policies.length !== 1) fail(`expected 1 response headers policy, found ${policies.length}`);
const policyConfig = policies[0]?.Properties?.ResponseHeadersPolicyConfig;
const security = policyConfig?.SecurityHeadersConfig ?? {};
if (security.FrameOptions?.FrameOption !== 'DENY') fail('frame options policy is not DENY');
if (!security.StrictTransportSecurity?.IncludeSubdomains) fail('HSTS includeSubDomains is missing');
if (security.StrictTransportSecurity?.AccessControlMaxAgeSec < 31536000) {
  fail('HSTS max-age is below one year');
}
const csp = security.ContentSecurityPolicy?.ContentSecurityPolicy ?? '';
if (!csp.includes("frame-ancestors 'none'")) {
  fail('CSP is missing frame-ancestors none');
}
if (!csp.includes('https://static-integrity-dev-jw.argus.pw')) {
  fail('CSP is missing static-integrity origin');
}
if (!security.ContentTypeOptions?.Override) fail('nosniff policy is missing');

const functions = resources.filter((r) => r.Type === 'AWS::CloudFront::Function');
if (functions.length !== 1) fail(`expected 1 CloudFront function, found ${functions.length}`);

if (process.exitCode) process.exit(process.exitCode);
console.log('[cdk-hardening] ok');
