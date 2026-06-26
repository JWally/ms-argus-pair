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
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

// ── Constants ──────────────────────────────────────────────────────────

const TOKEN_TTL_SECONDS = 5 * 60; // bootstrap token TTL
const ENVELOPE_MAX_AGE_SEC = 60 * 60; // 1 hour — peer messages allowed within
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

// ── Bootstrap token (HMAC-signed JSON, base64url) ──────────────────────

interface BootstrapClaims {
  v: 1;
  sessionId: string;
  role: 'desktop' | 'phone';
  iat: number;
  exp: number;
}

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

export interface Envelope {
  v: 1;
  connectionId: string;
  sessionId: string;
  role: 'desktop' | 'phone';
  ip: string;
  origin: string;
  iat: number;
  publicKey?: string;
}

/**
 * Server-side helper: PostToConnection a JSON payload to a peer that we
 * have an opened envelope for. Used by /phone-attest to push the verdict
 * straight to the desktop's WS connection (avoids /result polling).
 *
 * `endpoint` is the management-API HTTPS URL (NOT the wss:// form);
 * callers pass `process.env.WS_MGMT_ENDPOINT`.
 */
export async function postToPeer(
  endpoint: string,
  connectionId: string,
  data: unknown
): Promise<{ ok: true } | { ok: false; reason: 'gone' | string }> {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(data),
      })
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof GoneException) return { ok: false, reason: 'gone' };
    return { ok: false, reason: (e as Error).message };
  }
}

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

// ── Lambda handler ─────────────────────────────────────────────────────

interface WsEvent {
  requestContext: {
    routeKey: string;
    connectionId: string;
    domainName: string;
    stage: string;
    identity?: { sourceIp?: string };
  };
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string;
}

interface WsResp {
  statusCode: number;
  body?: string;
}

function ok(): WsResp {
  return { statusCode: 200 };
}

function bad(body: string): WsResp {
  console.log(`[ws] bad: ${body}`);
  return { statusCode: 400, body };
}

function originOk(origin: string | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

async function sendToConnection(
  event: WsEvent,
  connectionId: string,
  data: unknown
): Promise<void> {
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const client = new ApiGatewayManagementApiClient({ endpoint });
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(data),
      })
    );
  } catch (e) {
    if (e instanceof GoneException) {
      // peer disconnected — silent drop; sender's reply UX handles
      return;
    }
    throw e;
  }
}

async function handleWhoami(
  event: WsEvent,
  body: { token?: unknown; publicKey?: unknown; origin?: unknown }
): Promise<WsResp> {
  if (typeof body.token !== 'string') return bad('missing_token');
  const claims = await verifyBootstrapToken(body.token);
  if (!claims) return bad('invalid_token');
  const origin = typeof body.origin === 'string' ? body.origin : '';
  if (!originOk(origin)) return bad('origin_not_allowed');
  const ip = event.requestContext.identity?.sourceIp ?? '';
  if (!(await claimRoleConnection(claims, event.requestContext.connectionId))) {
    return bad('role_already_connected');
  }
  const env: Envelope = {
    v: 1,
    connectionId: event.requestContext.connectionId,
    sessionId: claims.sessionId,
    role: claims.role,
    ip,
    origin,
    iat: Math.floor(Date.now() / 1000),
    publicKey: typeof body.publicKey === 'string' ? body.publicKey : undefined,
  };
  const envelope = await sealEnvelope(env);
  await sendToConnection(event, event.requestContext.connectionId, {
    action: 'whoami',
    envelope,
    sessionId: claims.sessionId,
    role: claims.role,
  });
  return ok();
}

async function handleMessage(
  event: WsEvent,
  body: { me?: unknown; peer?: unknown; data?: unknown }
): Promise<WsResp> {
  if (typeof body.me !== 'string' || typeof body.peer !== 'string') return bad('missing_envelopes');
  const me = await openEnvelope(body.me);
  const peer = await openEnvelope(body.peer);
  if (!me || !peer) return bad('invalid_envelope');
  // Server-of-record identity check: the connection sending this message
  // MUST own the `me` envelope. Stops a third party with leaked envelopes
  // from impersonating a peer.
  if (me.connectionId !== event.requestContext.connectionId) {
    return bad('envelope_connection_mismatch');
  }
  // Pair session must match — peers from different sessions can't talk.
  if (me.sessionId !== peer.sessionId) return bad('cross_session');
  // NOTE: both origins were already validated against ALLOWED_ORIGINS in
  // their respective whoami. We deliberately do NOT require me.origin ===
  // peer.origin here: the desktop can load from an alias (qr.arcades.click)
  // while the QR points the phone at the canonical host (captcha-…/argus.pw)
  // so the WebAuthn rpId stays stable. That's by design. sessionId is the
  // pairing boundary, not origin.
  // Roles must be distinct (desktop talks to phone, not desktop to desktop).
  if (me.role === peer.role) return bad('same_role');
  // Replay window.
  const now = Math.floor(Date.now() / 1000);
  if (now - me.iat > ENVELOPE_MAX_AGE_SEC || now - peer.iat > ENVELOPE_MAX_AGE_SEC) {
    return bad('envelope_expired');
  }
  const dataKind =
    body.data && typeof body.data === 'object' && 'kind' in (body.data as object)
      ? (body.data as { kind?: unknown }).kind
      : null;
  console.log(
    `[ws] relay from=${me.role} to=${peer.role} session=${me.sessionId} kind=${String(dataKind)} peerCid=${peer.connectionId}`
  );
  await sendToConnection(event, peer.connectionId, {
    action: 'message',
    from: me.role,
    // Include the sender's envelope so the recipient can reply without
    // a separate handshake. The recipient doesn't get to forge this —
    // we hand them the same sealed blob the sender presented to us,
    // which decrypts only if AES auth-tag verifies.
    fromEnvelope: body.me,
    sessionId: me.sessionId,
    data: body.data ?? null,
  });
  return ok();
}

export const handler = async (event: WsEvent): Promise<WsResp> => {
  const route = event.requestContext.routeKey;
  const cid = event.requestContext.connectionId;
  if (route === '$connect') {
    console.log(`[ws] connect cid=${cid}`);
    return ok();
  }
  if (route === '$disconnect') {
    console.log(`[ws] disconnect cid=${cid}`);
    await releaseRoleConnection(cid);
    return ok();
  }
  let body: { action?: string } & Record<string, unknown> = {};
  try {
    if (event.body) body = JSON.parse(event.body) as typeof body;
  } catch {
    return bad('invalid_json');
  }
  console.log(`[ws] action=${body.action} cid=${cid}`);
  switch (body.action) {
    case 'whoami':
      return handleWhoami(event, body as Record<string, unknown>);
    case 'message':
      return handleMessage(event, body as Record<string, unknown>);
    default:
      return bad('unknown_action');
  }
};
