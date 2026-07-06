import * as path from 'path';
import { fileURLToPath } from 'url';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
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
  ResponseHeadersPolicy,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
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
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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

    // HMAC secret for embeddable-widget verdict tokens (siteverify). A separate
    // key from device-trust for clean key separation; stored in Secrets Manager
    // so issued verdict tokens survive Lambda redeploys.
    const verdictSigningSecret = new secretsmanager.Secret(this, 'VerdictSigningSecret', {
      description: 'HMAC secret for ms-argus-pair embed verdict tokens',
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

    // ── Shared infra (VPC + Valkey) from ms-argus-infra via SSM ───────
    // VPC lookup is a synth-time context resolution (cached in
    // cdk.context.json). The other params are runtime-resolved tokens.
    // Stage is derived from the stack name suffix — `ms-argus-pair-dev-jw`
    // → `dev-jw`, matching the SSM path ms-argus-infra exports under
    // /argus/{stage}/*.
    const sharedStage = cdk.Stack.of(this).stackName.replace(/^ms-argus-pair-/, '');
    const vpcId = ssm.StringParameter.valueFromLookup(this, `/argus/${sharedStage}/vpc-id`);
    const sharedVpc = ec2.Vpc.fromLookup(this, 'SharedVpc', { vpcId });
    const sharedLambdaSgId = ssm.StringParameter.valueForStringParameter(
      this,
      `/argus/${sharedStage}/lambda-security-group-id`
    );
    const sharedLambdaSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'SharedLambdaSg',
      sharedLambdaSgId
    );
    const valkeyEndpoint = ssm.StringParameter.valueForStringParameter(
      this,
      `/argus/${sharedStage}/valkey-endpoint`
    );

    // ── Pair API Lambda ────────────────────────────────────────────────
    const pairFn = new lambda.NodejsFunction(this, 'PairApiFn', {
      entry: path.join(__dirname, 'pair-api.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      memorySize: 2048,
      timeout: cdk.Duration.seconds(10),
      // VPC-attached so the rate-limit path can reach Valkey on 6379.
      // The shared lambda SG (from ms-argus-infra) is already authorized
      // by Valkey's ingress rule, no per-stack SG plumbing needed.
      vpc: sharedVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sharedLambdaSg],
      environment: {
        TABLE_NAME: table.tableName,
        ALLOWED_ORIGINS: allOrigins.join(','),
        PAIR_PUBLIC_ORIGIN: `https://${domainName}`,
        DEVICE_TRUST_SECRET_ARN: deviceTrustSecret.secretArn,
        VERDICT_SIGNING_SECRET_ARN: verdictSigningSecret.secretArn,
        // Valkey rate-limit backend. USE_VALKEY_RATE_LIMITS=true switches
        // peek/check from 5 DDB calls to 1 pipelined Valkey round-trip.
        // Both code paths ship — flip the env to roll back without code.
        VALKEY_ENDPOINT: valkeyEndpoint,
        VALKEY_PORT: '6379',
        USE_VALKEY_RATE_LIMITS: 'true',
        // Valkey session-state backend. USE_VALKEY_SESSIONS=true routes
        // session/start, desktop-attest, phone-attest, argus claims,
        // and raffle-hash claims through per-key SET NX EX commands
        // instead of DDB Put/UpdateCommand. Both code paths ship; flip
        // the env to roll back without a code redeploy. Live on dev-jw
        // after smoke-testing /session/start and /info through the
        // Valkey backend.
        USE_VALKEY_SESSIONS: 'true',
        // Dev/test stage: allow the CDP virtual authenticator through WebAuthn
        // proof-of-life (so the demo + automated/red-team runs work). Prod
        // stages OMIT this → pair-api rejects virtual authenticators. Flip to
        // a stage check when a prod PairStack exists.
        PAIR_ALLOW_TEST_AUTHENTICATORS: 'true',
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
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        nodeModules: ['sharp'],
      },
    });
    table.grantReadWriteData(pairFn);
    deviceTrustSecret.grantRead(pairFn);
    verdictSigningSecret.grantRead(pairFn);

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

    // ── Provisioned concurrency for the pair Lambda ───────────────────
    // Pinning 1 warm execution kills the ~640ms cold start that was
    // showing up at the front of every fresh-container pair session.
    // Cost: ~$8/mo for 768MB × 1 PC at us-east-1. Cheap insurance.
    //
    // Routing requests through the alias instead of the function lets
    // CFN cut over to a new version atomically and keep PC pinned to
    // the latest deploy. addAlias auto-bumps when the code hash changes.
    const pairFnAlias = pairFn.addAlias('live', {
      provisionedConcurrentExecutions: 3,
    });

    // ── HTTP API ───────────────────────────────────────────────────────
    const api = new apigatewayv2.HttpApi(this, 'PairApi', {
      corsPreflight: {
        allowOrigins: allOrigins,
        allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
      },
    });
    const integration = new integrations.HttpLambdaIntegration('PairInt', pairFnAlias);

    api.addRoutes({
      path: '/api/session/start',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/sso/start',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/sso/{id}/challenge',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/sso/{id}/validate',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/sso/{id}/claim',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      // Temporary diagnostic — DNS+TCP+TLS reachability check against
      // the Valkey endpoint, for debugging the post-migration timeouts.
      path: '/api/_valkey-debug',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/api/session/{id}/info',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    // Embeddable widget: mint a signed verdict token (desktop participant),
    // and server-to-server verify it (the host's backend).
    api.addRoutes({
      path: '/api/session/{id}/verdict-token',
      methods: [apigatewayv2.HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: '/api/verify',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    // Short pairing token: desktop mints (per-session), phone redeems (single-use).
    api.addRoutes({
      path: '/api/session/{id}/pair-token',
      methods: [apigatewayv2.HttpMethod.POST],
      integration,
    });
    api.addRoutes({
      path: '/api/pair-token/redeem',
      methods: [apigatewayv2.HttpMethod.POST],
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
    // Handles $connect / $disconnect / message routes. Peer routing uses
    // sealed envelopes; whoami also claims one DDB slot per session role
    // so a copied QR/session token cannot create duplicate active peers.
    const wsHandlerFn = new lambda.NodejsFunction(this, 'PairWsHandlerFn', {
      entry: path.join(__dirname, 'ws-handler.ts'),
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        ALLOWED_ORIGINS: allOrigins.join(','),
        WS_ENVELOPE_SECRET_ARN: wsEnvelopeSecret.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });
    table.grantReadWriteData(wsHandlerFn);
    wsEnvelopeSecret.grantRead(wsHandlerFn);
    // The pair HTTP Lambda mints bootstrap tokens at /session/start →
    // shares the same secret.
    wsEnvelopeSecret.grantRead(pairFn);
    pairFn.addEnvironment('WS_ENVELOPE_SECRET_ARN', wsEnvelopeSecret.secretArn);

    // Provisioned concurrency for the WS handler too — the 450ms WS
    // cold start was the second-biggest delay on the first-pair flow.
    // Cost: ~$5/mo for 512MB × 1 PC.
    const wsHandlerAlias = wsHandlerFn.addAlias('live', {
      provisionedConcurrentExecutions: 3,
    });

    // ── WebSocket API ──────────────────────────────────────────────────
    const wsApi = new apigatewayv2.WebSocketApi(this, 'PairWsApi', {
      apiName: `${cdk.Stack.of(this).stackName}-ws`,
      routeSelectionExpression: '$request.body.action',
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ConnectInt', wsHandlerAlias),
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DisconnectInt', wsHandlerAlias),
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('DefaultInt', wsHandlerAlias),
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
    // /phone-attest server-pushes the verdict to the desktop's WS
    // connection (replaces the desktop's /result polling). To do that
    // the HTTP Lambda needs PostToConnection rights on this WS API.
    // The management endpoint is the https:// form (apiEndpoint is wss://).
    wsApi.grantManageConnections(pairFn);
    pairFn.addEnvironment(
      'WS_MGMT_ENDPOINT',
      `https://${wsApi.apiId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com/prod`
    );

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
    const siteHeaders = new ResponseHeadersPolicy(this, 'SiteResponseHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        frameOptions: {
          frameOption: HeadersFrameOption.DENY,
          override: true,
        },
      },
    });

    // The embeddable widget (/embed) MUST be iframable by customer sites, so it
    // can't carry X-Frame-Options: DENY. Same security headers minus frameOptions
    // — framing is gated by the single-use token (and, later, originAllowlist),
    // not by the frame header.
    const embedHeaders = new ResponseHeadersPolicy(this, 'EmbedResponseHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });
    const spaRouter = new CloudFrontFunction(this, 'SpaRouter', {
      code: FunctionCode.fromFile({
        filePath: path.join(__dirname, '../cloudfront/spa-router.js'),
      }),
    });

    const distribution = new Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: siteHeaders,
        functionAssociations: [
          {
            function: spaRouter,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: siteHeaders,
        },
        // The embeddable widget route — served by index.html (via the SPA router
        // CFF) but with frame-allowing headers so customer sites can iframe it.
        '/embed': {
          origin: s3Origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: embedHeaders,
          functionAssociations: [
            {
              function: spaRouter,
              eventType: FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
        ...Object.fromEntries(
          ['*.js', '*.css', '*.woff*', '*.png', '*.jpg', '*.svg'].map((pattern) => [
            pattern,
            {
              origin: s3Origin,
              cachePolicy: CachePolicy.CACHING_OPTIMIZED,
              viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              responseHeadersPolicy: siteHeaders,
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
