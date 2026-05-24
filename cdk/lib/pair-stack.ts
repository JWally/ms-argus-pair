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

    // ── DynamoDB for signaling state (TTL-managed) ─────────────────────
    const table = new dynamodb.Table(this, 'Signaling', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // ── Signaling Lambda ───────────────────────────────────────────────
    const signalingFn = new lambda.NodejsFunction(this, 'SignalingFn', {
      entry: path.join(__dirname, 'signaling.ts'),
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
    table.grantReadWriteData(signalingFn);

    // ── API Gateway ────────────────────────────────────────────────────
    const api = new apigatewayv2.HttpApi(this, 'PairApi', {
      // CORS is belt-and-suspenders; primary path is same-origin via CloudFront.
      corsPreflight: {
        allowOrigins: [`https://${domainName}`],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
        ],
        allowHeaders: ['content-type'],
      },
      // Hard throttle at the API level. Lambda still validates per-request.
      defaultDomainMapping: undefined,
    });
    const integration = new integrations.HttpLambdaIntegration('SigInt', signalingFn);

    // Routes carry the /api prefix so CloudFront's pass-through (`/api/*`)
    // resolves to a real APIGW route. Without the prefix, APIGW returns 403
    // and CloudFront's errorResponses rewrites it to the SPA index.html.
    api.addRoutes({ path: '/api/rooms', methods: [apigatewayv2.HttpMethod.POST], integration });
    api.addRoutes({
      path: '/api/rooms/{id}/join',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/rooms/{id}/peers',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/api/rooms/{id}/signal',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration,
    });
    api.addRoutes({
      path: '/api/rooms/{id}/signal/{peerId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/api/rooms/{id}/end',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    // Catchall — any unmatched /api/* path routes to Lambda, which returns
    // 200 + {error:...}. Without this, APIGW returns 404 → CloudFront's
    // errorResponses[404] rewrites to the SPA index.html and any client
    // that misconstructs a URL gets unparseable HTML back.
    api.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration,
    });

    // ── Throttling — keep blast radius small for the demo ──────────────
    const defaultStage = api.defaultStage?.node.defaultChild as apigatewayv2.CfnStage | undefined;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 20,
      };
    }

    // ── S3 bucket for static site ──────────────────────────────────────
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

    // ── DNS & Certificate ──────────────────────────────────────────────
    const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: rootDomain });
    const certificate = new Certificate(this, 'SiteCertificate', {
      domainName,
      validation: CertificateValidation.fromDns(zone),
    });

    // ── Cache policies ─────────────────────────────────────────────────
    // Use AWS-managed policies (do not count toward per-account CachePolicy
    // quota). CACHING_DISABLED for HTML so SPA changes are picked up; the
    // managed CACHING_OPTIMIZED policy is fine for hashed static assets.
    const staticCachePolicy = CachePolicy.CACHING_OPTIMIZED;
    const htmlCachePolicy = CachePolicy.CACHING_DISABLED;

    // ── CloudFront ─────────────────────────────────────────────────────
    const s3Origin = new S3Origin(bucket, { originAccessIdentity: oai });
    const apiOrigin = new HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`);

    const distribution = new Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: htmlCachePolicy,
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
              cachePolicy: staticCachePolicy,
              viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            },
          ])
        ),
      },
      domainNames: [domainName],
      certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
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
