/**
 * WebSocket handler for ms-argus-pair.
 *
 * Signed/sealed envelopes route peer messages without a server-side lookup.
 * `whoami` also claims one live connection slot per {sessionId, role} in DDB
 * so copied QR/session tokens cannot create duplicate active peers.
 *
 * **Bootstrap.** Clients receive an HMAC-signed `wsToken` from POST
 * /session/start (HTTP API). The token attests:
 *     {sessionId, role, iat, exp}
 * It rides as a query string to the WebSocket: `?token=…`.
 *
 * **$connect.** We don't enforce the token at $connect (API GW only lets
 * us inspect query string here, but the auth path is cleaner inside
 * `whoami`). Just accept.
 *
 * **whoami.** Client sends `{action:"whoami", token, publicKey}`. We
 * verify the HMAC token, then AES-256-GCM seal a connection-identity
 * envelope:
 *     {connectionId, sessionId, role, ip, origin, iat}
 * and return the base64 ciphertext as `envelope`. Client stores it.
 *
 * **message.** Client sends `{action:"message", me, peer, data}`. We
 * decrypt both envelopes (AES-GCM auth tag prevents forgery), check:
 *   - origin matches
 *   - sessionId matches (same pair session)
 *   - both envelopes are within MAX_AGE_SEC of issuance (replay window)
 * Then PostToConnection to the peer's connectionId with `{data}`.
 *
 * Keys derived from a single 64-byte secret via HKDF-SHA256:
 *   - "ws-bootstrap-hmac-v1" → bootstrap HMAC key
 *   - "ws-envelope-aes-v1"   → envelope AES-256-GCM key
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { markPhoneChallenge, markPhoneDone } from './pair-api/verdict-reveal-store';
import { createWsEventPublisher } from './ws-handler/publisher';
import {
  createWsRouter,
  type BootstrapClaims,
  type Envelope,
  type WsEvent,
  type WsResponse,
} from './ws-handler/router';

export type { Envelope } from './ws-handler/router';

// ── Constants ──────────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS = 5 * 60; // bootstrap token TTL
const ALLOWED_ROLES = new Set(['desktop', 'phone']);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const TABLE = process.env.TABLE_NAME;

// ── One-live-connection claims ────────────────────────────────────────

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface ConnectionClaim {
  sessionId: string;
  role: 'desktop' | 'phone';
}

async function claimRoleConnection(
  claims: BootstrapClaims,
  connectionId: string
): Promise<boolean> {
  if (!TABLE) throw new Error('TABLE_NAME not configured');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(claims.exp + 60, now + TOKEN_TTL_SECONDS + 60);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `WS#${claims.sessionId}`,
                SK: claims.role,
                connectionId,
                expiresAt,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `WSC#${connectionId}`,
                SK: 'META',
                sessionId: claims.sessionId,
                role: claims.role,
                expiresAt,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'TransactionCanceledException') return false;
    throw e;
  }
}

async function releaseRoleConnection(connectionId: string): Promise<void> {
  if (!TABLE) throw new Error('TABLE_NAME not configured');
  const reverse = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `WSC#${connectionId}`, SK: 'META' },
    })
  );
  const item = reverse.Item as Partial<ConnectionClaim> | undefined;
  if (!item?.sessionId || !item?.role) return;

  await Promise.allSettled([
    ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `WS#${item.sessionId}`, SK: item.role },
        ConditionExpression: 'connectionId = :connectionId',
        ExpressionAttributeValues: { ':connectionId': connectionId },
      })
    ),
    ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `WSC#${connectionId}`, SK: 'META' },
      })
    ),
  ]);
}

// ── Secret material (cold-start cached) ────────────────────────────────

const sm = new SecretsManagerClient({});
let cachedRoot: Buffer | null = null;
let cachedHmacKey: Buffer | null = null;
let cachedAesKey: Buffer | null = null;

async function loadSecretMaterial(): Promise<{
  hmacKey: Buffer;
  aesKey: Buffer;
}> {
  if (cachedHmacKey && cachedAesKey) {
    return { hmacKey: cachedHmacKey, aesKey: cachedAesKey };
  }
  const arn = process.env.WS_ENVELOPE_SECRET_ARN;
  if (!arn) throw new Error('WS_ENVELOPE_SECRET_ARN not configured');
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error('WS envelope secret empty');
  cachedRoot = Buffer.from(r.SecretString, 'utf-8');
  // HKDF-SHA256 — distinct info strings = independent keys from one root.
  cachedHmacKey = Buffer.from(
    hkdfSync(
      'sha256',
      cachedRoot,
      Buffer.alloc(0),
      Buffer.from('ws-bootstrap-hmac-v1', 'utf-8'),
      32
    )
  );
  cachedAesKey = Buffer.from(
    hkdfSync('sha256', cachedRoot, Buffer.alloc(0), Buffer.from('ws-envelope-aes-v1', 'utf-8'), 32)
  );
  return { hmacKey: cachedHmacKey, aesKey: cachedAesKey };
}

export function deriveVerdictRevealKeyFromRoot(root: Buffer, sessionId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      root,
      Buffer.from(sessionId, 'utf-8'),
      Buffer.from('pair-verdict-reveal-v1', 'utf-8'),
      32
    )
  );
}

/** Session-specific key withheld until an authenticated phone sends DONE. */
export async function deriveVerdictRevealKey(sessionId: string): Promise<Buffer> {
  await loadSecretMaterial();
  if (!cachedRoot) throw new Error('WS root secret unavailable');
  return deriveVerdictRevealKeyFromRoot(cachedRoot, sessionId);
}

// ── Bootstrap token (HMAC-signed JSON, base64url) ──────────────────────

function b64urlBytes(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export async function mintBootstrapToken(
  sessionId: string,
  role: 'desktop' | 'phone'
): Promise<string> {
  const { hmacKey } = await loadSecretMaterial();
  const iat = Math.floor(Date.now() / 1000);
  const claims: BootstrapClaims = {
    v: 1,
    sessionId,
    role,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  };
  const body = b64urlBytes(Buffer.from(JSON.stringify(claims), 'utf-8'));
  const mac = createHmac('sha256', hmacKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export async function verifyBootstrapToken(token: string): Promise<BootstrapClaims | null> {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  if (!body || !mac) return null;
  const { hmacKey } = await loadSecretMaterial();
  const expected = createHmac('sha256', hmacKey).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: BootstrapClaims;
  try {
    claims = JSON.parse(b64urlDecode(body).toString('utf-8')) as BootstrapClaims;
  } catch {
    return null;
  }
  if (claims.v !== 1) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now > claims.exp) return null;
  if (!ALLOWED_ROLES.has(claims.role)) return null;
  return claims;
}

// ── Connection-identity envelope (AES-256-GCM sealed) ──────────────────

async function sealEnvelope(env: Envelope): Promise<string> {
  const { aesKey } = await loadSecretMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const pt = Buffer.from(JSON.stringify(env), 'utf-8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  // wire layout: b64url( iv || ciphertext || tag )
  return b64urlBytes(Buffer.concat([iv, ct, tag]));
}

export async function openEnvelope(blob: string): Promise<Envelope | null> {
  try {
    const buf = b64urlDecode(blob);
    if (buf.length < 12 + 16) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const { aesKey } = await loadSecretMaterial();
    const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    const env = JSON.parse(pt.toString('utf-8')) as Envelope;
    if (env.v !== 1) return null;
    return env;
  } catch {
    return null;
  }
}

function isWarmingUp(event: unknown): boolean {
  const maybeWarmup = event as { source?: unknown; warmup?: unknown };
  return maybeWarmup.source === 'serverless-plugin-warmup' || maybeWarmup.warmup === true;
}

function requireMessageState(): void {
  if (!TABLE) throw new Error('TABLE_NAME not configured');
}

const sendToConnection = createWsEventPublisher();

const wsRouter = createWsRouter({
  allowedOrigins: new Set(ALLOWED_ORIGINS),
  verifyBootstrapToken,
  claimRoleConnection,
  releaseRoleConnection,
  sealEnvelope,
  openEnvelope,
  ensureMessageStateAvailable: requireMessageState,
  markPhoneChallenge: async (sessionId, challenge, expiresAt) => {
    requireMessageState();
    await markPhoneChallenge(ddb, TABLE!, sessionId, challenge, expiresAt);
  },
  markPhoneDone: async (sessionId, expiresAt) => {
    requireMessageState();
    await markPhoneDone(ddb, TABLE!, sessionId, expiresAt);
  },
  getVerdictRevealKey: async (sessionId) => b64urlBytes(await deriveVerdictRevealKey(sessionId)),
  sendToConnection,
  nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  logInfo: (message) => console.log(message),
});

export const handler = async (event: WsEvent | unknown): Promise<WsResponse> => {
  if (isWarmingUp(event)) return { statusCode: 200, body: JSON.stringify({ warmed: true }) };
  return wsRouter(event as WsEvent);
};
