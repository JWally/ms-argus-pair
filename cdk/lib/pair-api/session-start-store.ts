import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { isValkeySessionsEnabled, startSessionValkey } from '../session-store';
import { validMerchantOrigin } from './host-preflight';

export interface NewPairSession {
  id: string;
  nonce: string;
  expiresAt: number;
  challengeId: string;
  cpi: string | null;
  proofRequired: boolean;
  freshProofRequired: boolean;
  hostPreflightRequired: boolean;
  hostOrigin?: string;
}

/** Persist session metadata without adding another Valkey key or read. */
async function storeStartedSession(
  session: NewPairSession,
  deps: { ddb: DynamoDBDocumentClient; tableName: string }
): Promise<boolean> {
  const {
    id,
    nonce,
    expiresAt,
    challengeId,
    cpi,
    proofRequired,
    freshProofRequired,
    hostPreflightRequired,
    hostOrigin,
  } = session;
  if (isValkeySessionsEnabled()) {
    return startSessionValkey(id, {
      nonce,
      expiresAt,
      challengeId,
      cpi,
      proofRequired,
      freshProofRequired,
      hostPreflightRequired,
      ...(hostOrigin ? { hostOrigin } : {}),
    });
  }

  await deps.ddb.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        PK: `SESSION#${id}`,
        SK: 'META',
        nonce,
        expiresAt,
        challengeId,
        cpi,
        proofRequired,
        freshProofRequired,
        hostPreflightRequired,
        ...(hostOrigin ? { hostOrigin } : {}),
        verdict: 'pending',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );
  return true;
}

type StartResult =
  | { ok: true }
  | { ok: false; status: 400 | 409; body: { error: string; reason?: string } };

export async function prepareAndStoreStartedSession(
  session: NewPairSession,
  deps: {
    ddb: DynamoDBDocumentClient;
    tableName: string;
  }
): Promise<StartResult> {
  if (session.hostPreflightRequired) {
    if (!session.cpi)
      return { ok: false, status: 400, body: { error: 'host_preflight_requires_cpi' } };
    if (!session.hostOrigin || !validMerchantOrigin(session.hostOrigin)) {
      return { ok: false, status: 400, body: { error: 'host_preflight_origin_invalid' } };
    }
  }

  const created = await storeStartedSession(session, deps);
  return created
    ? { ok: true }
    : { ok: false, status: 409, body: { error: 'session_id_collision' } };
}
