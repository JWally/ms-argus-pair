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
  CachePolicy,
  OriginAccessIdentity,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement, CanonicalUserPrincipal, Effect } from 'aws-cdk-lib/aws-iam';
import { BucketDeployment, Source, CacheControl } from 'aws-cdk-lib/aws-s3-deployment';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PairStackProps extends cdk.StackProps {
  rootDomain: string;
  subdomain: string;
  /** Subdomain for the WebSocket signaling endpoint (wss://). */
  signalSubdomain: string;
}

export class PairStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PairStackProps) {
    super(scope, id, props);

    const { rootDomain, subdomain, signalSubdomain } = props;
    const domainName = `${subdomain}.${rootDomain}`;
    const signalDomain = `${signalSubdomain}.${rootDomain}`;

    const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: rootDomain });

    // ── HMAC secret for stateless pairing tokens ───────────────────────
    const hmacSecret = new secretsmanager.Secret(this, 'HmacSecret', {
      description: 'HMAC secret for ms-argus-pair WebSocket token signing',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // ── WebSocket signaling Lambda ─────────────────────────────────────
    const signalingFn = new lambda.NodejsFunction(this, 'SignalingFn', {
      entry: path.join(__dirname, 'signaling-ws.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        HMAC_SECRET_ARN: hmacSecret.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });
    hmacSecret.grantRead(signalingFn);

    // ── WebSocket API ──────────────────────────────────────────────────
    // Use separate integration instances per route — when the same
    // WebSocketLambdaIntegration is reused across all three route options
    // CDK only emits the Lambda invoke permission for one of them and
    // APIGW silently returns "Internal server error" for the rest.
    const wsApi = new apigatewayv2.WebSocketApi(this, 'PairWsApi', {
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ConnectInt', signalingFn),
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DisconnectInt', signalingFn),
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DefaultInt', signalingFn),
      },
    });
    const wsStage = new apigatewayv2.WebSocketStage(this, 'PairWsStage', {
      webSocketApi: wsApi,
      stageName: 'prod',
      autoDeploy: true,
      throttle: { burstLimit: 50, rateLimit: 20 },
    });

    // Lambda needs to call back to clients via the management API.
    signalingFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['execute-api:ManageConnections'],
        resources: [
          this.formatArn({
            service: 'execute-api',
            resource: `${wsApi.apiId}/${wsStage.stageName}/POST/@connections/*`,
          }),
        ],
      })
    );

    // ── WSS custom domain ──────────────────────────────────────────────
    const wsCert = new Certificate(this, 'WsCertificate', {
      domainName: signalDomain,
      validation: CertificateValidation.fromDns(zone),
    });

    const wsDomain = new apigatewayv2.DomainName(this, 'WsDomain', {
      domainName: signalDomain,
      certificate: wsCert,
    });
    new apigatewayv2.ApiMapping(this, 'WsApiMapping', {
      api: wsApi,
      domainName: wsDomain,
      stage: wsStage,
    });

    new ARecord(this, 'WsAliasRecord', {
      zone,
      recordName: signalDomain,
      target: RecordTarget.fromAlias({
        bind: () => ({
          dnsName: wsDomain.regionalDomainName,
          hostedZoneId: wsDomain.regionalHostedZoneId,
        }),
      }),
    });

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
    const siteCert = new Certificate(this, 'SiteCertificate', {
      domainName,
      validation: CertificateValidation.fromDns(zone),
    });

    // ── CloudFront ─────────────────────────────────────────────────────
    // Static site only. Signaling lives on its own WSS subdomain — no
    // CloudFront proxy = no /api/* behavior, no errorResponses trickery,
    // no caching layer to misroute live API traffic.
    const s3Origin = new S3Origin(bucket, { originAccessIdentity: oai });

    const distribution = new Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: Object.fromEntries(
        ['*.js', '*.css', '*.woff*', '*.png', '*.jpg', '*.svg'].map((pattern) => [
          pattern,
          {
            origin: s3Origin,
            cachePolicy: CachePolicy.CACHING_OPTIMIZED,
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          },
        ])
      ),
      domainNames: [domainName],
      certificate: siteCert,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      // SPA fallback: S3 returns 403 (OAI blocks listing) for unknown
      // keys, CloudFront rewrites to index.html so client-side routes
      // (/pair/<uuid>) resolve.
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
    new cdk.CfnOutput(this, 'SignalingURL', { value: `wss://${signalDomain}` });
  }
}
