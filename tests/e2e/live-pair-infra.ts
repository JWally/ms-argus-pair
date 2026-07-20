import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

const DEFAULT_STACK_NAME = 'ms-argus-pair-dev-jw';
const DEV_TARGET = 'dev-jw';

export interface LivePairInfra {
  ddb: DynamoDBDocumentClient;
  tableName: string;
}

function assertSafeTarget(stackName: string, tableName: string): void {
  if (process.env.PAIR_E2E_ALLOW_NON_DEV === '1') return;
  if (!stackName.includes(DEV_TARGET) || !tableName.includes(DEV_TARGET)) {
    throw new Error(
      `refusing live Pair fixture writes outside ${DEV_TARGET}; set PAIR_E2E_ALLOW_NON_DEV=1 to override explicitly`
    );
  }
}

async function listPairTables(client: DynamoDBClient, stackName: string): Promise<string[]> {
  const matches: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.send(new ListTablesCommand({ ExclusiveStartTableName: cursor }));
    for (const tableName of page.TableNames ?? []) {
      if (tableName.startsWith(`${stackName}-`) && tableName.includes('PairSessions')) {
        matches.push(tableName);
      }
    }
    cursor = page.LastEvaluatedTableName;
  } while (cursor);
  return matches;
}

export async function resolveLivePairInfra(): Promise<LivePairInfra> {
  const stackName = process.env.PAIR_STACK_NAME ?? DEFAULT_STACK_NAME;
  const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const configuredTable = process.env.PAIR_TABLE_NAME;
  const matches = configuredTable ? [configuredTable] : await listPairTables(client, stackName);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one PairSessions table for ${stackName}, found ${matches.length}: ${matches.join(', ') || '(none)'}`
    );
  }
  const tableName = matches[0];
  assertSafeTarget(stackName, tableName);
  return { ddb: DynamoDBDocumentClient.from(client), tableName };
}

export async function putSsoFixture(
  infra: LivePairInfra,
  sessionId: string,
  item: Record<string, unknown>
): Promise<void> {
  await infra.ddb.send(
    new PutCommand({
      TableName: infra.tableName,
      Item: {
        ...item,
        PK: `SSO#${sessionId}`,
        SK: 'META',
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        e2eFixture: 'sso-infra',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );
}

export async function getSsoFixture(
  infra: LivePairInfra,
  sessionId: string
): Promise<Record<string, unknown> | undefined> {
  const result = await infra.ddb.send(
    new GetCommand({
      TableName: infra.tableName,
      Key: { PK: `SSO#${sessionId}`, SK: 'META' },
      ConsistentRead: true,
    })
  );
  return result.Item;
}

export async function deleteSsoFixture(infra: LivePairInfra, sessionId: string): Promise<void> {
  await infra.ddb.send(
    new DeleteCommand({
      TableName: infra.tableName,
      Key: { PK: `SSO#${sessionId}`, SK: 'META' },
    })
  );
}
