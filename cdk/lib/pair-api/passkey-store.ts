import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Resident passkeys are long-lived but still garbage-collected when abandoned.
const PASSKEY_TTL_SECONDS = 365 * 24 * 60 * 60;

export interface StoredPasskey {
  credentialId: string;
  publicKey: string;
  signCount: number;
  argusPubkey: string | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface PasskeyStore {
  load(credentialId: string): Promise<StoredPasskey | null>;
  save(passkey: StoredPasskey): Promise<void>;
}

export function createDdbPasskeyStore(
  ddb: DynamoDBDocumentClient,
  tableName: string
): PasskeyStore {
  return {
    async load(credentialId) {
      const res = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `PASSKEY#${credentialId}`, SK: 'META' },
        })
      );
      return (res.Item as StoredPasskey | undefined) ?? null;
    },

    async save(passkey) {
      const ttl = Math.floor(Date.now() / 1000) + PASSKEY_TTL_SECONDS;
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { PK: `PASSKEY#${passkey.credentialId}`, SK: 'META' },
          UpdateExpression:
            'SET publicKey = :pk, signCount = :sc, argusPubkey = :ap, ' +
            'createdAt = if_not_exists(createdAt, :now), lastUsedAt = :now, ' +
            'expiresAt = :ttl, credentialId = :cid',
          ExpressionAttributeValues: {
            ':pk': passkey.publicKey,
            ':sc': passkey.signCount,
            ':ap': passkey.argusPubkey,
            ':now': passkey.lastUsedAt,
            ':ttl': ttl,
            ':cid': passkey.credentialId,
          },
        })
      );
    },
  };
}
