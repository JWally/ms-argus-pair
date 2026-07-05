import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { Construct } from 'constructs';
import { RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import {
  Distribution,
  ViewerProtocolPolicy,
  SecurityPolicyProtocol,
  HttpVersion,
  PriceClass,
  AllowedMethods,
  CachePolicy,
  CacheHeaderBehavior,
  CacheCookieBehavior,
  CacheQueryStringBehavior,
  ResponseHeadersPolicy,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  OriginAccessIdentity,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement, CanonicalUserPrincipal } from 'aws-cdk-lib/aws-iam';
import { BucketDeployment, Source, CacheControl } from 'aws-cdk-lib/aws-s3-deployment';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';

// ESM has no __dirname; derive it from import.meta.url.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// cdk/lib/captcha-cdn -> repo root -> loader/dist (built by scripts/build-loader.mjs).
const loaderDist = path.join(moduleDir, '../../../loader/dist');

export interface StaticSiteProps {
  stage: string;
  /** e.g. static-captcha-dev-jw.argus.pw */
  customDomain?: string;
  /** e.g. argus.pw — needed with customDomain for the managed cert + A-record */
  rootDomain?: string;
  removalPolicy?: RemovalPolicy;
}

/**
 * S3 + CloudFront CDN for the embeddable captcha loader
 * (static-captcha[-stage].argus.pw). Folded in from the retired
 * ms-argus-captcha repo so the widget is self-contained (FE/BE) in one service.
 * Private bucket behind an OAI, CORS response headers so the loader/manifest
 * load cross-origin, tuned cache policies (immutable JS long, JSON/HTML short),
 * optional custom domain + DNS-validated cert. Deploys the artifact built by
 * scripts/build-loader.mjs into loader/dist.
 */
export class StaticSiteConstruct extends Construct {
  public readonly bucket: Bucket;
  public readonly distribution: Distribution;
  public readonly domainUrl: string;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    this.bucket = new Bucket(this, 'SiteBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
      removalPolicy,
    });

    const oai = new OriginAccessIdentity(this, 'SiteOAI');
    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('*')],
        principals: [
          new CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId),
        ],
      })
    );

    let certificate: ICertificate | undefined;
    if (props.customDomain && props.rootDomain) {
      const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: props.rootDomain });
      certificate = new Certificate(this, 'SiteCertificate', {
        domainName: props.customDomain,
        validation: CertificateValidation.fromDns(zone),
      });
    }

    const assetCache = new CachePolicy(this, 'AssetCache', {
      cachePolicyName: `${props.stage}-pair-captcha-assets`,
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      headerBehavior: CacheHeaderBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
    });
    const noCache = new CachePolicy(this, 'NoCache', {
      cachePolicyName: `${props.stage}-pair-captcha-no-cache`,
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(86400),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      headerBehavior: CacheHeaderBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
    });

    const cors = new ResponseHeadersPolicy(this, 'CorsPolicy', {
      responseHeadersPolicyName: `${props.stage}-pair-captcha-cors`,
      comment: 'CORS for cross-origin loader/manifest fetch',
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowOrigins: ['*'],
        accessControlMaxAge: Duration.seconds(86400),
        originOverride: true,
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(31536000),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    const origin = new S3Origin(this.bucket, { originAccessIdentity: oai });
    this.distribution = new Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: noCache,
        responseHeadersPolicy: cors,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      additionalBehaviors: {
        '*.js': {
          origin,
          cachePolicy: assetCache,
          responseHeadersPolicy: cors,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        '*.json': {
          origin,
          cachePolicy: noCache,
          responseHeadersPolicy: cors,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      domainNames: certificate && props.customDomain ? [props.customDomain] : undefined,
      certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
    });

    if (certificate && props.customDomain && props.rootDomain) {
      const zone = HostedZone.fromLookup(this, 'AliasHostedZone', { domainName: props.rootDomain });
      new ARecord(this, 'AliasRecord', {
        zone,
        recordName: props.customDomain,
        target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
      });
      this.domainUrl = `https://${props.customDomain}`;
    } else {
      this.domainUrl = `https://${this.distribution.distributionDomainName}`;
    }

    new BucketDeployment(this, 'DeploySite', {
      sources: [Source.asset(loaderDist)],
      destinationBucket: this.bucket,
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/captcha.js', '/captcha-sri.json', '/index.html'],
      memoryLimit: 1024,
      cacheControl: [CacheControl.fromString('public, max-age=0, must-revalidate')],
    });

    new CfnOutput(this, 'SiteURL', { value: this.domainUrl });
    new CfnOutput(this, 'LoaderURL', { value: `${this.domainUrl}/captcha.js` });
  }
}
