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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AliasDomain {
  /** Hosted-zone apex, e.g. `arcades.click`. */
  rootDomain: string;
  /** Subdomain label, e.g. `qr`. */
  subdomain: string;
}

interface PairStackProps extends cdk.StackProps {
  rootDomain: string;
  subdomain: string;
  /**
   * Additional fully-qualified aliases that should also serve the same
   * site. Each gets a SAN on the ACM cert, a CloudFront alias entry,
   * and an A-record in its own hosted zone. CORS / ALLOWED_ORIGINS
   * include them too.
   */
  additionalAliases?: AliasDomain[];
  /** Base URL for ms-argus-api (e.g. https://merchant-dev-jw.argus.pw). */
  merchantApiUrl?: string;
  /** Dual-key credential from ms-argus-platform: `<keyId>.<base64-claims>.<base64-sig>`. */
  merchantApiCredential?: string;
  /** Public CPI used to partition integrity records (e.g. argus_cpi_test_…). */
  merchantCpi?: string;

  /**
   * OAuth provider configuration. Optional — when absent, the matching
   * verifier in oauth-providers.ts returns `*_not_configured` and the
   * client UI hides the corresponding button.
   *
   * client IDs / app IDs are non-secret; they're baked into the Lambda
   * env vars. App secrets (Facebook only) live in Secrets Manager so
   * they don't show up in CloudFormation diffs or process listings.
   */
  oauthGoogleClientId?: string;
  oauthGithubClientId?: string;
  oauthGithubClientSecretArn?: string;
  oauthFacebookAppId?: string;
  oauthFacebookAppSecretArn?: string;
}

export class PairStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PairStackProps) {
    super(scope, id, props);

    const {
      rootDomain,
      subdomain,
      additionalAliases = [],
      merchantApiUrl,
      merchantApiCredential,
      merchantCpi,
      oauthGoogleClientId,
      oauthGithubClientId,
      oauthGithubClientSecretArn,
      oauthFacebookAppId,
      oauthFacebookAppSecretArn,
    } = props;

    // Pair fundamentally can't run without the merchant API — every
    // /phone-attest call fetches the desktop + phone projections to
    // compute the verdict. If any of the three context flags is missing
    // the Lambda comes up with an empty MERCHANT_API_URL and every pair
    // attempt fails with `projection_lookup_failed`.
    //
    // The CDK deploy script in package.json sources `.env` and forwards
    // these via -c flags. Forgetting `source .env` before running
    // `npx cdk deploy` directly was the failure mode we just hit. Throw
    // at synth time so it can't happen silently again.
    const missingMerchant: string[] = [];
    if (!merchantApiUrl) missingMerchant.push('merchantApiUrl');
    if (!merchantApiCredential) missingMerchant.push('merchantApiCredential');
    if (!merchantCpi) missingMerchant.push('merchantCpi');
    if (missingMerchant.length > 0) {
      throw new Error(
        `PairStack is missing required merchant context: ${missingMerchant.join(', ')}. ` +
          'Pair calls the merchant API on every /phone-attest; without it, every ' +
          'pair fails with projection_lookup_failed. Source .env and pass via ' +
          '`-c merchantApiUrl=... -c merchantApiCredential=... -c merchantCpi=...` ' +
          '(or just use `npm run deploy`, which handles this).'
      );
    }

    const domainName = `${subdomain}.${rootDomain}`;

    const zone = HostedZone.fromLookup(this, 'HostedZone', { domainName: rootDomain });

    // Build out the alias domain list: each entry has its own hosted
    // zone lookup so we can emit a DNS-validation record + alias A-record
    // there. Index suffixes keep construct IDs unique.
    const aliases = additionalAliases.map((a, i) => {
      const fqdn = `${a.subdomain}.${a.rootDomain}`;
      const aliasZone = HostedZone.fromLookup(this, `AliasZone${i}`, {
        domainName: a.rootDomain,
      });
      return { fqdn, zone: aliasZone, idx: i };
    });
    const allDomains = [domainName, ...aliases.map((a) => a.fqdn)];
    const allOrigins = allDomains.map((d) => `https://${d}`);

    // ── Device-trust HMAC secret ──────────────────────────────────────
    // 64-byte auto-generated secret, stored in Secrets Manager so it
    // survives Lambda redeploys (otherwise every deploy would invalidate
    // every issued device-trust token).
    const deviceTrustSecret = new secretsmanager.Secret(this, 'DeviceTrustSecret', {
      description: 'HMAC secret for ms-argus-pair device-trust tokens',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

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
      memorySize: 768,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        ALLOWED_ORIGINS: allOrigins.join(','),
        DEVICE_TRUST_SECRET_ARN: deviceTrustSecret.secretArn,
        // Merchant-API access for the verdict-time scan lookup. When these
        // are absent the verdict logic degrades to "skipped" rather than
        // blocking on Argus availability.
        ...(merchantApiUrl ? { MERCHANT_API_URL: merchantApiUrl } : {}),
        ...(merchantApiCredential ? { MERCHANT_API_CREDENTIAL: merchantApiCredential } : {}),
        ...(merchantCpi ? { MERCHANT_CPI: merchantCpi } : {}),
        // OAuth client IDs / app IDs are non-secret. Absent → verifier
        // returns *_not_configured, client hides the button.
        ...(oauthGoogleClientId ? { OAUTH_GOOGLE_CLIENT_ID: oauthGoogleClientId } : {}),
        ...(oauthGithubClientId ? { OAUTH_GITHUB_CLIENT_ID: oauthGithubClientId } : {}),
        ...(oauthFacebookAppId ? { OAUTH_FACEBOOK_APP_ID: oauthFacebookAppId } : {}),
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });
    table.grantReadWriteData(pairFn);
    deviceTrustSecret.grantRead(pairFn);

    // ── OAuth provider secrets ────────────────────────────────────────
    // Each provider's app secret lives in Secrets Manager so it stays
    // out of CFN templates. The Lambda gets read access + the secret
    // value materialised into the named env var at cold start (CDK's
    // built-in fromSecretCompleteArn + addEnvironment pattern would
    // also work; this form keeps the lookup explicit).
    if (oauthGithubClientSecretArn) {
      const ghSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'OAuthGithubClientSecret',
        oauthGithubClientSecretArn
      );
      ghSecret.grantRead(pairFn);
      pairFn.addEnvironment('OAUTH_GITHUB_CLIENT_SECRET_ARN', ghSecret.secretArn);
    }
    if (oauthFacebookAppSecretArn) {
      const fbSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'OAuthFacebookAppSecret',
        oauthFacebookAppSecretArn
      );
      fbSecret.grantRead(pairFn);
      pairFn.addEnvironment('OAUTH_FACEBOOK_APP_SECRET_ARN', fbSecret.secretArn);
    }

    // ── HTTP API ───────────────────────────────────────────────────────
    const api = new apigatewayv2.HttpApi(this, 'PairApi', {
      corsPreflight: {
        allowOrigins: allOrigins,
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
    api.addRoutes({
      path: '/api/raffle/entry',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/raffle/leaderboard',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/api/raffle/status/{id}',
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

    // ── WebSocket envelope secret ─────────────────────────────────────
    // Single 64-byte secret used as HKDF source for two derived keys:
    //   - HMAC key: signs the short-lived bootstrap token returned by
    //     POST /session/start so the WS $whoami call can prove the
    //     client is allowed to talk
    //   - AES-256-GCM key: seals the connection-identity envelope
    //     ({connectionId, sessionId, role, ip, origin, iat}) so the
    //     client holds an opaque, tamper-proof routing handle without
    //     a server-side lookup table
    // Same pattern as DeviceTrustSecret — survives Lambda redeploys.
    const wsEnvelopeSecret = new secretsmanager.Secret(this, 'WsEnvelopeSecret', {
      description: 'HKDF source for ms-argus-pair WebSocket bootstrap HMAC + envelope AES keys',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // ── WebSocket handler Lambda ───────────────────────────────────────
    // Handles $connect / $disconnect / message routes. Stateless —
    // routes peer messages by decrypting the envelopes the clients
    // present, no DDB lookup. See cdk/lib/ws-handler.ts.
    const wsHandlerFn = new lambda.NodejsFunction(this, 'PairWsHandlerFn', {
      entry: path.join(__dirname, 'ws-handler.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
      environment: {
        ALLOWED_ORIGINS: allOrigins.join(','),
        WS_ENVELOPE_SECRET_ARN: wsEnvelopeSecret.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });
    wsEnvelopeSecret.grantRead(wsHandlerFn);
    // The pair HTTP Lambda mints bootstrap tokens at /session/start →
    // shares the same secret.
    wsEnvelopeSecret.grantRead(pairFn);
    pairFn.addEnvironment('WS_ENVELOPE_SECRET_ARN', wsEnvelopeSecret.secretArn);

    // ── WebSocket API ──────────────────────────────────────────────────
    const wsApi = new apigatewayv2.WebSocketApi(this, 'PairWsApi', {
      apiName: `${cdk.Stack.of(this).stackName}-ws`,
      routeSelectionExpression: '$request.body.action',
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ConnectInt', wsHandlerFn),
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DisconnectInt', wsHandlerFn),
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DefaultInt', wsHandlerFn),
      },
    });
    new apigatewayv2.WebSocketStage(this, 'PairWsStage', {
      webSocketApi: wsApi,
      stageName: 'prod',
      autoDeploy: true,
    });
    // Grant the handler permission to PostToConnection on this API —
    // needed for sending messages back to clients (and routing
    // peer-to-peer messages once that wiring lands).
    wsApi.grantManageConnections(wsHandlerFn);
    // Surface the deployed API id + endpoint for the handler to construct
    // the management-API URL at runtime.
    wsHandlerFn.addEnvironment('WS_API_ID', wsApi.apiId);
    // The pair HTTP Lambda needs the public WS URL so /session/start can
    // return it in the response body for the client to dial.
    pairFn.addEnvironment('WS_API_URL', `${wsApi.apiEndpoint}/prod`);

    // ── Lambda warmer ──────────────────────────────────────────────────
    // Fires a synthetic event every 5 minutes so the Lambda's container
    // stays warm during idle periods. The `source` matches what
    // @middy/warmup looks for via `isWarmingUp` in pair-api.ts — the
    // middleware short-circuits before the route switch runs.
    const warmupRule = new events.Rule(this, 'PairApiWarmupRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: `Keepalive ping for ${pairFn.functionName}`,
    });
    warmupRule.addTarget(
      new targets.LambdaFunction(pairFn, {
        event: events.RuleTargetInput.fromObject({ source: 'serverless-plugin-warmup' }),
      })
    );

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

    // Single cert with SANs covering every alias. DNS validation needs the
    // record placed in the correct hosted zone per name — fromDnsMultiZone
    // takes a {fqdn -> zone} map.
    const zoneMap: Record<string, ReturnType<typeof HostedZone.fromLookup>> = {
      [domainName]: zone,
    };
    for (const a of aliases) zoneMap[a.fqdn] = a.zone;
    const siteCert = new Certificate(this, 'SiteCertificate', {
      domainName,
      subjectAlternativeNames: aliases.map((a) => a.fqdn),
      validation: CertificateValidation.fromDnsMultiZone(zoneMap),
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
      domainNames: allDomains,
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
    for (const a of aliases) {
      new ARecord(this, `AliasRecord${a.idx}`, {
        zone: a.zone,
        recordName: a.fqdn,
        target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
      });
    }

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
    new cdk.CfnOutput(this, 'WsApiUrl', { value: `${wsApi.apiEndpoint}/prod` });
  }
}
