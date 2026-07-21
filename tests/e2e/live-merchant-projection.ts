import { createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

// cspell:ignore webrtc

const DEFAULT_API_URL = 'https://merchant-dev-jw.argus.pw';
const DEV_TARGET = 'dev-jw';
const PARAMETER_NAMES = {
  integrityTable: '/argus/dev-jw/data/integrity-results-table-name',
  merchantsTable: '/argus/dev-jw/data/merchants-table-name',
  signingKeyArn: '/argus-platform/dev-jw/api-signing-key-arn',
  e2eApiKeyId: '/argus-api/dev-jw/merchant-projection-e2e-api-key-id',
} as const;

interface FixtureResources {
  ddb: DynamoDBDocumentClient;
  merchantsTable: string;
  merchantId: string;
  integrityTable: string;
  cpi: string;
  sessionId: string;
}

export interface LiveMerchantProjectionFixture {
  apiUrl: string;
  keyId: string;
  credential: string;
  cpi: string;
  sessionId: string;
  reset(): Promise<void>;
  creditsRemaining(): Promise<number>;
  cleanup(): Promise<void>;
}

function assertSafeTarget(apiUrl: string, tables: string[]): void {
  if (process.env.PAIR_E2E_ALLOW_NON_DEV === '1') return;
  if (!apiUrl.includes(DEV_TARGET) || tables.some((table) => !table.includes(DEV_TARGET))) {
    throw new Error(
      `refusing live merchant fixtures outside ${DEV_TARGET}; ` +
        'set PAIR_E2E_ALLOW_NON_DEV=1 to override explicitly'
    );
  }
}

interface LiveProjectionParameters {
  integrityTable: string;
  merchantsTable: string;
  signingKeyArn: string;
  e2eApiKeyId: string;
}

async function resolveParameters(ssm: SSMClient): Promise<LiveProjectionParameters> {
  const names = Object.values(PARAMETER_NAMES);
  const response = await ssm.send(new GetParametersCommand({ Names: names }));
  const values = new Map(
    (response.Parameters ?? []).flatMap((parameter) =>
      parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value]] : []
    )
  );
  const missing = names.filter((name) => !values.has(name));
  if (missing.length > 0) throw new Error(`missing dev-jw SSM parameters: ${missing.join(', ')}`);
  const required = (name: string) => values.get(name)!;
  return {
    integrityTable: required(PARAMETER_NAMES.integrityTable),
    merchantsTable: required(PARAMETER_NAMES.merchantsTable),
    signingKeyArn: required(PARAMETER_NAMES.signingKeyArn),
    e2eApiKeyId: required(PARAMETER_NAMES.e2eApiKeyId),
  };
}

function fixtureIntegrity(cpi: string, sessionId: string): Record<string, unknown> {
  const ip = '203.0.113.7';
  return {
    cpi,
    session_id: sessionId,
    device: {},
    meta: {},
    sigint: {},
    analysis: {
      network: { proxy_score: 0, proxy_component: 0, vpn_component: 0, signals: [] },
      worker: { lied: false, divergences: [], signals: [] },
      timezone: {
        lied: false,
        checks: {
          offsetMatchesComputed: true,
          locationMatchesCfTimezone: true,
          offsetMatchesWorker: true,
          clientReportedLie: false,
        },
        cfTimezone: null,
        clientTimezone: null,
        signals: [],
      },
      ip: {
        lied: false,
        ips: { api: ip, tls: ip, tcp: ip, webrtc: ip },
        asn: {
          number: '64500',
          category: 'residential',
          network_class: 'residential',
          org: 'Argus E2E Fixture',
        },
        checks: { probesConsistent: true, webrtcMatchesProbes: true },
        integrity: 1,
        ip,
        signals: [],
      },
    },
    client_ip: ip,
    user_agent: 'Mozilla/5.0 Chrome/150.0.0.0',
    created_at: Date.now(),
    ttl: Math.floor(Date.now() / 1000) + 300,
    e2eFixture: 'pair-merchant-projection',
  };
}

function signedToken(privateKeyPem: string, claims: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(encoded, 'utf8'), createPrivateKey(privateKeyPem));
  return `${encoded}.${signature.toString('base64url')}`;
}

async function waitForApiKeyReadiness(
  apiUrl: string,
  cpi: string,
  sessionId: string,
  keyId: string
) {
  const deadline = Date.now() + 60_000;
  const url = `${apiUrl}/v1/session/${encodeURIComponent(cpi)}/${encodeURIComponent(sessionId)}`;
  let lastStatus = 0;
  let lastBody = '';
  do {
    const response = await fetch(url, {
      headers: { 'x-api-key': keyId, 'x-argus-token': 'invalid.invalid' },
    });
    lastStatus = response.status;
    if (response.status === 401) return;
    lastBody = (await response.text().catch(() => '')).slice(0, 200);
    if (response.status !== 403 && response.status !== 429) {
      throw new Error(
        `unexpected merchant API readiness status: ${response.status}; body=${lastBody}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(
    `timed out waiting for the dev-jw API Gateway key to become usable; ` +
      `last status=${lastStatus} body=${lastBody}`
  );
}

async function cleanupResources(resources: FixtureResources): Promise<void> {
  const tasks: Array<Promise<unknown>> = [
    resources.ddb.send(
      new DeleteCommand({
        TableName: resources.merchantsTable,
        Key: { merchantId: resources.merchantId },
      })
    ),
    resources.ddb.send(
      new DeleteCommand({
        TableName: resources.integrityTable,
        Key: { cpi: resources.cpi, session_id: resources.sessionId },
      })
    ),
  ];
  const results = await Promise.allSettled(tasks);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => (failure as PromiseRejectedResult).reason),
      'failed to clean one or more live merchant fixtures'
    );
  }
}

export async function createLiveMerchantProjectionFixture(): Promise<LiveMerchantProjectionFixture> {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const apiUrl = process.env.MERCHANT_API_URL ?? DEFAULT_API_URL;
  const ssm = new SSMClient({ region });
  const secrets = new SecretsManagerClient({ region });
  const apigw = new APIGatewayClient({ region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const parameters = await resolveParameters(ssm);
  const { merchantsTable, integrityTable } = parameters;
  assertSafeTarget(apiUrl, [merchantsTable, integrityTable]);

  const merchantId = randomUUID();
  const cpi = `argus_cpi_test_${randomBytes(12).toString('hex')}`;
  const sessionId = `e2e-${randomUUID()}`;
  const resources: FixtureResources = {
    ddb,
    merchantsTable,
    merchantId,
    integrityTable,
    cpi,
    sessionId,
  };

  try {
    await Promise.all([
      ddb.send(
        new PutCommand({
          TableName: merchantsTable,
          Item: {
            merchantId,
            name: 'Pair projection E2E fixture',
            email: 'pair-projection-e2e@invalid.example',
            cognitoSub: `e2e-${merchantId}`,
            credits: 2,
            plan: 'starter',
            allowedReturnUrls: [],
            active: true,
            createdAt: new Date().toISOString(),
            e2eFixture: 'pair-merchant-projection',
          },
          ConditionExpression: 'attribute_not_exists(merchantId)',
        })
      ),
      ddb.send(
        new PutCommand({
          TableName: integrityTable,
          Item: fixtureIntegrity(cpi, sessionId),
          ConditionExpression: 'attribute_not_exists(cpi)',
        })
      ),
    ]);

    const gatewayKey = await apigw.send(
      new GetApiKeyCommand({
        apiKey: parameters.e2eApiKeyId,
        includeValue: true,
      })
    );
    const keyId = gatewayKey.value;
    if (!keyId) throw new Error('dev-jw projection E2E API key has no value');

    const secret = await secrets.send(
      new GetSecretValueCommand({ SecretId: parameters.signingKeyArn })
    );
    if (!secret.SecretString) throw new Error('dev-jw platform signing key secret is empty');
    const token = signedToken(secret.SecretString, {
      merchantId,
      cpi,
      keyId,
      plan: 'starter',
      iat: Math.floor(Date.now() / 1000),
    });
    await waitForApiKeyReadiness(apiUrl, cpi, sessionId, keyId);

    let cleaned = false;
    return {
      apiUrl,
      keyId,
      credential: `${keyId}.${token}`,
      cpi,
      sessionId,
      async reset() {
        await Promise.all([
          ddb.send(
            new UpdateCommand({
              TableName: merchantsTable,
              Key: { merchantId },
              UpdateExpression: 'SET credits = :credits, active = :active',
              ExpressionAttributeValues: { ':credits': 2, ':active': true },
            })
          ),
          ddb.send(
            new PutCommand({
              TableName: integrityTable,
              Item: fixtureIntegrity(cpi, sessionId),
            })
          ),
        ]);
      },
      async creditsRemaining() {
        const result = await ddb.send(
          new GetCommand({
            TableName: merchantsTable,
            Key: { merchantId },
            ConsistentRead: true,
            ProjectionExpression: 'credits',
          })
        );
        const credits = result.Item?.credits;
        if (typeof credits !== 'number') throw new Error('fixture merchant credits are missing');
        return credits;
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await cleanupResources(resources);
      },
    };
  } catch (error) {
    await cleanupResources(resources).catch(() => undefined);
    throw error;
  }
}
