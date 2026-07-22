import { Duration } from 'aws-cdk-lib';
import {
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import type { Construct } from 'constructs';

function sharedSecurityHeaders() {
  return {
    strictTransportSecurity: {
      accessControlMaxAge: Duration.days(365),
      includeSubdomains: true,
      preload: true,
      override: true,
    },
    contentTypeOptions: { override: true },
    referrerPolicy: {
      referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
      override: true,
    },
  };
}

/** CloudFront security policies for the framed and non-framed Pair surfaces. */
export function createPairResponseHeaderPolicies(scope: Construct) {
  const siteHeaders = new ResponseHeadersPolicy(scope, 'SiteResponseHeaders', {
    securityHeadersBehavior: {
      ...sharedSecurityHeaders(),
      frameOptions: {
        frameOption: HeadersFrameOption.DENY,
        override: true,
      },
    },
  });

  // /embed must remain iframable by merchant sites. Its single-use token and
  // merchant-origin policy are the trust boundary, not X-Frame-Options.
  const embedHeaders = new ResponseHeadersPolicy(scope, 'EmbedResponseHeaders', {
    securityHeadersBehavior: sharedSecurityHeaders(),
  });

  return { siteHeaders, embedHeaders };
}
