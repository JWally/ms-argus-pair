/**
 * Stateless WebSocket signaling Lambda.
 *
 * No database. Pairing state is baked into HMAC-signed tokens that clients
 * pass back and forth — the host's connectionId, encoded with a short
 * expiry and a server-side HMAC, becomes the QR-friendly "room token".
 *
 * Wire protocol (client → server actions):
 *   {action: "create"}
 *     Mint a roomToken containing the host's connectionId. Reply with
 *     {event: "room_created", roomId, roomToken}.
 *   {action: "join", roomToken}
 *     Verify the token, extract host's connectionId. Mint a peerToken for
 *     the joiner's own connectionId. Push {event: "peer_joined", peerToken}
 *     to the host and {event: "joined", peerToken: <original roomToken>}
 *     to the joiner.
 *   {action: "relay", to: <peerToken>, payload: <any>}
 *     Verify peerToken, postToConnection({event: "relay", payload}) to the
 *     extracted connectionId. If the destination has disconnected APIGW
 *     returns 410 — surface that as {event: "peer_gone"} to the sender.
 *
 * No $disconnect handler — relay failures are how surviving peers learn
 * the other side left.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const SECRET_ARN = process.env.HMAC_SECRET_ARN!;
const TOKEN_TTL_SECONDS = 300; // 5 minutes — generous for a pairing session
const MAX_PAYLOAD_BYTES = 16 * 1024;

const sm = new SecretsManagerClient({});
let cachedSecret: string | null = null;

async function getSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  const value = resp.SecretString;
  if (!value) throw new Error('HMAC secret missing');
  cachedSecret = value;
  return value;
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

async function mintToken(connId: string): Promise<string> {
  const secret = await getSecret();
  const payload = { c: connId, e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const body = b64urlEncode(JSON.stringify(payload));
  const mac = b64urlEncode(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

async function verifyToken(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.', 2);
  if (!body || !mac) return null;
  const secret = await getSecret();
  const expected = createHmac('sha256', secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(mac);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as { c?: string; e?: number };
    if (!parsed.c || typeof parsed.e !== 'number') return null;
    if (Math.floor(Date.now() / 1000) > parsed.e) return null;
    return parsed.c;
  } catch {
    return null;
  }
}

function client(domain: string, stage: string): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClient({
    endpoint: `https://${domain}/${stage}`,
  });
}

async function send(
  c: ApiGatewayManagementApiClient,
  connId: string,
  data: Record<string, unknown>
): Promise<'ok' | 'gone'> {
  try {
    await c.send(
      new PostToConnectionCommand({
        ConnectionId: connId,
        Data: Buffer.from(JSON.stringify(data)),
      })
    );
    return 'ok';
  } catch (e) {
    if (e instanceof GoneException) return 'gone';
    throw e;
  }
}

interface WsEvent {
  requestContext: {
    routeKey: string;
    connectionId: string;
    domainName: string;
    stage: string;
  };
  body?: string;
}

export const handler = async (event: WsEvent) => {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;
  const api = client(domainName, stage);

  // Hard cap on inbound message size to keep abuse off the table.
  if (event.body && event.body.length > MAX_PAYLOAD_BYTES) {
    await send(api, connectionId, { event: 'error', message: 'Payload too large' });
    return { statusCode: 200 };
  }

  if (routeKey === '$connect') {
    return { statusCode: 200 };
  }
  if (routeKey === '$disconnect') {
    // Nothing to clean up — relay failures will surface peer departures.
    return { statusCode: 200 };
  }

  // $default — parse the body for an action.
  let body: { action?: string; roomToken?: string; to?: string; payload?: unknown };
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    await send(api, connectionId, { event: 'error', message: 'Invalid JSON' });
    return { statusCode: 200 };
  }

  const action = body.action;

  if (action === 'create') {
    const roomId = randomUUID();
    const roomToken = await mintToken(connectionId);
    await send(api, connectionId, { event: 'room_created', roomId, roomToken });
    return { statusCode: 200 };
  }

  if (action === 'join') {
    if (!body.roomToken) {
      await send(api, connectionId, { event: 'error', message: 'Missing roomToken' });
      return { statusCode: 200 };
    }
    const hostConnId = await verifyToken(body.roomToken);
    if (!hostConnId) {
      await send(api, connectionId, { event: 'error', message: 'Invalid or expired roomToken' });
      return { statusCode: 200 };
    }
    if (hostConnId === connectionId) {
      await send(api, connectionId, { event: 'error', message: 'Cannot join your own room' });
      return { statusCode: 200 };
    }
    const joinerToken = await mintToken(connectionId);
    // Tell the joiner who to relay to (use the same roomToken — it's the
    // signed host connection ID).
    await send(api, connectionId, { event: 'joined', peerToken: body.roomToken });
    // Tell the host the joiner has arrived and give them a token to relay to.
    const hostNotice = await send(api, hostConnId, {
      event: 'peer_joined',
      peerToken: joinerToken,
    });
    if (hostNotice === 'gone') {
      await send(api, connectionId, { event: 'error', message: 'Host disconnected' });
    }
    return { statusCode: 200 };
  }

  if (action === 'relay') {
    if (!body.to) {
      await send(api, connectionId, { event: 'error', message: 'Missing to' });
      return { statusCode: 200 };
    }
    const targetConnId = await verifyToken(body.to);
    if (!targetConnId) {
      await send(api, connectionId, { event: 'error', message: 'Invalid or expired peer token' });
      return { statusCode: 200 };
    }
    const result = await send(api, targetConnId, { event: 'relay', payload: body.payload });
    if (result === 'gone') {
      await send(api, connectionId, { event: 'peer_gone' });
    }
    return { statusCode: 200 };
  }

  await send(api, connectionId, { event: 'error', message: `Unknown action: ${action}` });
  return { statusCode: 200 };
};
