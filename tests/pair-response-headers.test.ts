import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { createPairResponseHeaderPolicies } from '../cdk/lib/pair-response-headers';

interface SynthResource {
  Properties?: {
    ResponseHeadersPolicyConfig?: {
      SecurityHeadersConfig?: Record<string, unknown>;
    };
  };
}

function synthesizePolicies(): Record<string, SynthResource> {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'PairResponseHeadersTest');
  createPairResponseHeaderPolicies(stack);
  return Template.fromStack(stack).findResources('AWS::CloudFront::ResponseHeadersPolicy');
}

function securityPolicy(
  resources: Record<string, SynthResource>,
  logicalIdPrefix: string
): Record<string, unknown> {
  const entry = Object.entries(resources).find(([logicalId]) =>
    logicalId.startsWith(logicalIdPrefix)
  );
  expect(entry, `${logicalIdPrefix} policy should exist`).toBeDefined();
  return entry?.[1].Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig ?? {};
}

describe('Pair response-header infrastructure', () => {
  it('denies framing on the site while keeping the embed route iframable', () => {
    const resources = synthesizePolicies();
    expect(Object.keys(resources)).toHaveLength(2);

    const site = securityPolicy(resources, 'SiteResponseHeaders');
    const embed = securityPolicy(resources, 'EmbedResponseHeaders');
    expect(site.FrameOptions).toEqual({ FrameOption: 'DENY', Override: true });
    expect(embed.FrameOptions).toBeUndefined();
  });

  it('applies the shared transport-security policy to both routes', () => {
    const resources = synthesizePolicies();

    for (const prefix of ['SiteResponseHeaders', 'EmbedResponseHeaders']) {
      const policy = securityPolicy(resources, prefix);
      expect(policy.StrictTransportSecurity).toEqual({
        AccessControlMaxAgeSec: 31_536_000,
        IncludeSubdomains: true,
        Override: true,
        Preload: true,
      });
      expect(policy.ContentTypeOptions).toEqual({ Override: true });
      expect(policy.ReferrerPolicy).toEqual({
        Override: true,
        ReferrerPolicy: 'strict-origin-when-cross-origin',
      });
      expect(policy.ContentSecurityPolicy).toBeUndefined();
    }
  });
});
