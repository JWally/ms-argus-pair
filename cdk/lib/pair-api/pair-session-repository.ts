import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PhoneBundle, SessionMeta } from '../session-store';
import type { StoredHostPreflight } from './host-preflight';
import type { StoredDesktopAttestation, StoredPairAttestation } from './desktop-attest';

type PairVerdict = 'pending' | 'paired' | 'failed';

export interface PairSessionItem {
  PK: string;
  SK: string;
  nonce: string;
  expiresAt: number;
  cpi?: string | null;
  challengeId?: string;
  proofRequired?: boolean;
  freshProofRequired?: boolean;
  hostPreflightRequired?: boolean;
  hostOrigin?: string;
  hostAttestation?: StoredHostPreflight;
  desktopAttestation?: StoredDesktopAttestation;
  phoneAttestation?: StoredPairAttestation;
  verdict: PairVerdict;
  verdictReason?: string;
  annotations?: Record<string, unknown>;
}

interface ValkeyPairSessionFields {
  meta: SessionMeta<StoredHostPreflight> | null;
  desktop: StoredDesktopAttestation | null;
  phone: PhoneBundle<StoredPairAttestation> | null;
}

interface PairSessionRepositoryDependencies {
  ddb: DynamoDBDocumentClient;
  tableName: string;
  proofRequiredByDefault: boolean;
  useValkey(): boolean;
  loadValkeySession(sessionId: string): Promise<ValkeyPairSessionFields>;
  storeDesktopValkey(sessionId: string, attestation: StoredDesktopAttestation): Promise<boolean>;
}

function fromValkey(
  sessionId: string,
  fields: ValkeyPairSessionFields,
  proofRequiredByDefault: boolean
): PairSessionItem | null {
  const { meta, desktop, phone } = fields;
  if (!meta) return null;

  return {
    PK: `SESSION#${sessionId}`,
    SK: 'META',
    nonce: meta.nonce,
    expiresAt: meta.expiresAt,
    cpi: meta.cpi ?? null,
    challengeId: meta.challengeId,
    proofRequired: meta.proofRequired ?? proofRequiredByDefault,
    freshProofRequired: meta.freshProofRequired ?? false,
    hostPreflightRequired: meta.hostPreflightRequired ?? false,
    hostOrigin: meta.hostOrigin,
    hostAttestation: desktop?.hostAttestation ?? meta.hostAttestation,
    verdict: phone?.verdict ?? 'pending',
    verdictReason: phone?.reason ?? undefined,
    desktopAttestation: desktop ?? undefined,
    phoneAttestation: phone?.att,
    ...(phone?.annotations ? { annotations: phone.annotations } : {}),
  };
}

function withLegacyHostEvidence(item: PairSessionItem): PairSessionItem {
  if (item.hostAttestation || !item.desktopAttestation?.hostAttestation) return item;
  return { ...item, hostAttestation: item.desktopAttestation.hostAttestation };
}

/** Storage boundary for backend-independent Pair session reads and desktop-slot claims. */
export function createPairSessionRepository(deps: PairSessionRepositoryDependencies) {
  return {
    async loadSession(sessionId: string): Promise<PairSessionItem | null> {
      if (deps.useValkey()) {
        return fromValkey(
          sessionId,
          await deps.loadValkeySession(sessionId),
          deps.proofRequiredByDefault
        );
      }

      const response = await deps.ddb.send(
        new GetCommand({
          TableName: deps.tableName,
          Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
        })
      );
      const item = response.Item as PairSessionItem | undefined;
      return item ? withLegacyHostEvidence(item) : null;
    },

    async storeDesktopAttestation(
      sessionId: string,
      stored: StoredDesktopAttestation
    ): Promise<boolean> {
      if (deps.useValkey()) return deps.storeDesktopValkey(sessionId, stored);

      try {
        await deps.ddb.send(
          new UpdateCommand({
            TableName: deps.tableName,
            Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
            UpdateExpression: 'SET desktopAttestation = :d',
            ConditionExpression:
              'attribute_exists(PK) AND attribute_not_exists(desktopAttestation)',
            ExpressionAttributeValues: { ':d': stored },
          })
        );
        return true;
      } catch (error) {
        if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
  };
}
