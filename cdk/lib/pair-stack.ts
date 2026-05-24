import * as path from 'path';
import { fileURLToPath } from 'url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, BucketEncryption, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import {
  Distribution,
  ViewerProtocolPolicy,
  SecurityPolicyProtocol,
  HttpVersion,
  PriceClass,
  AllowedMethods,
  CachePolicy,
  OriginAccessIdentity,
  OriginRequestPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin, HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement, CanonicalUserPrincipal } from 'aws-cdk-lib/aws-iam';
import { BucketDeployment, Source, CacheControl } from 'aws-cdk-lib/aws-s3-deployment';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PairStackProps extends cdk.StackProps {
  rootDomain: string;
  subdomain: string;
}

export class PairStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PairStackProps) {
    super(scope, id, props);

    const { rootDomain, subdomain } = props;
    const domainName = `${subdomain}.${rootDomain}`;

    const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: rootDomain });

    // ── DDB: pair session state (TTL-managed) ──────────────────────────
    const table = new dynamodb.Table(this, 'PairSessions', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    });

    // ── Pair API Lambda ────────────────────────────────────────────────
    const pairFn = new lambda.NodejsFunction(this, 'PairApiFn', {
      entry: path.join(__dirname, 'pair-api.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        ALLOWED_ORIGINS: `https://${domainName}`,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });
    table.grantReadWriteData(pairFn);

    // ── HTTP API ───────────────────────────────────────────────────────
    const api = new apigatewayv2.HttpApi(this, 'PairApi', {
      corsPreflight: {
        allowOrigins: [`https://${domainName}`],
        allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
      },
    });
    const integration = new integrations.HttpLambdaIntegration('PairInt', pairFn);

    api.addRoutes({
      path: '/api/session/start',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/session/{id}/info',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/api/session/{id}/desktop-attest',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/session/{id}/phone-attest',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/session/{id}/result',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    // Catch-all so any drift in client URL construction returns JSON, not
    // CloudFront-rewritten SPA HTML. Kept the lesson from the WebRTC era.
    api.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration,
    });

    const defaultStage = api.defaultStage?.node.defaultChild as apigatewayv2.CfnStage | undefined;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 20,
      };
    }

    // ── S3 + CloudFront ────────────────────────────────────────────────
    const bucket = new Bucket(this, 'SiteBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const oai = new OriginAccessIdentity(this, 'SiteOAI');
    bucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
        principals: [
          new CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId),
        ],
      })
    );

    const siteCert = new Certificate(this, 'SiteCertificate', {
      domainName,
      validation: CertificateValidation.fromDns(zone),
    });

    const s3Origin = new S3Origin(bucket, { originAccessIdentity: oai });
    const apiOrigin = new HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`);

    const distribution = new Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        ...Object.fromEntries(
          ['*.js', '*.css', '*.woff*', '*.png', '*.jpg', '*.svg'].map((pattern) => [
            pattern,
            {
              origin: s3Origin,
              cachePolicy: CachePolicy.CACHING_OPTIMIZED,
              viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
          ])
        ),
      },
      domainNames: [domainName],
      certificate: siteCert,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      // SPA fallback only for non-/api paths: S3 returns 403/404 on unknown
      // keys, CF rewrites to /index.html for client-side routing. API paths
      // never reach this rewrite because they hit the /api/* behavior first.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    new ARecord(this, 'AliasRecord', {
      zone,
      recordName: domainName,
      target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
    });

    const distPath = path.join(__dirname, '../../dist');
    new BucketDeployment(this, 'DeploySite', {
      sources: [Source.asset(distPath)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 2096,
      cacheControl: [CacheControl.fromString('public, max-age=0, must-revalidate')],
    });

    new cdk.CfnOutput(this, 'SiteURL', { value: `https://${domainName}` });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
