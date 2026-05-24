import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME!;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const ROOM_TTL_SECONDS = 60;
const MAX_PEERS = 2;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CANDIDATES_PER_PEER = 30;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type SignalType = 'offer' | 'answer' | 'ice-to-client' | 'ice-to-host';

function ttl(): number {
  return Math.floor(Date.now() / 1000) + ROOM_TTL_SECONDS;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function originAllowed(event: { headers?: Record<string, string | undefined> }): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true; // dev mode
  const origin = event.headers?.origin || event.headers?.Origin;
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

function parseBody(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return {};
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isValidRoomId(id: string | undefined): id is string {
  return !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

export const handler = async (event: {
  routeKey: string;
  pathParameters?: Record<string, string | undefined>;
  body?: string;
  headers?: Record<string, string | undefined>;
}) => {
  if (!originAllowed(event)) return json(403, { error: 'Origin not allowed' });

  const routeKey = event.routeKey;
  const roomId = event.pathParameters?.id?.toLowerCase();
  const peerIdParam = event.pathParameters?.peerId;
  const body = parseBody(event.body);
  if (body === null) return json(400, { error: 'Invalid or oversized body' });

  if (routeKey !== 'POST /api/rooms' && !isValidRoomId(roomId)) {
    return json(400, { error: 'Invalid room id' });
  }

  switch (routeKey) {
    // ── Create room ────────────────────────────────────────────────────
    case 'POST /api/rooms': {
      // ── Create room ────────────────────────────────────────────────────
      const newId = randomUUID();
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            PK: `ROOM#${newId}`,
            SK: 'META',
            nextPeerId: 2, // host claims peerId=1 implicitly; next joiner gets 2
            peerCount: 1, // host counts as one peer slot
            ttl: ttl(),
          },
          // Defense-in-depth: a UUID collision would be cosmic, but reject it anyway.
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
      return json(200, { roomId: newId, peerId: 1, ttlSeconds: ROOM_TTL_SECONDS });
    }

    // ── Join room (phone after QR scan) ────────────────────────────────
    case 'POST /api/rooms/{id}/join': {
      try {
        const updated = await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: `ROOM#${roomId}`, SK: 'META' },
            UpdateExpression:
              'SET nextPeerId = nextPeerId + :one, peerCount = peerCount + :one, #t = :t',
            ConditionExpression: 'attribute_exists(PK) AND peerCount < :max',
            ExpressionAttributeNames: { '#t': 'ttl' },
            ExpressionAttributeValues: { ':one': 1, ':t': ttl(), ':max': MAX_PEERS },
            ReturnValues: 'ALL_OLD',
          })
        );
        const peerId = (updated.Attributes?.nextPeerId as number) ?? 2;
        await ddb.send(
          new PutCommand({
            TableName: TABLE,
            Item: { PK: `ROOM#${roomId}`, SK: `PEER#${peerId}`, peerId, ttl: ttl() },
          })
        );
        return json(200, { peerId });
      } catch (e) {
        const err = e as { name?: string };
        if (err.name === 'ConditionalCheckFailedException') {
          return json(409, { error: 'Room not found, expired, or full' });
        }
        throw e;
      }
    }

    // ── List peers ─────────────────────────────────────────────────────
    case 'GET /api/rooms/{id}/peers': {
      const [meta, peers] = await Promise.all([
        ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `ROOM#${roomId}`, SK: 'META' } })),
        ddb.send(
          new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: { ':pk': `ROOM#${roomId}`, ':sk': 'PEER#' },
          })
        ),
      ]);
      // Return 200 with expired:true rather than 404 so CloudFront's
      // errorResponses[404] (which rewrites to the SPA index.html) doesn't
      // turn a legitimate API response into HTML.
      if (!meta.Item) {
        return json(200, { peers: [], peerCount: 0, expired: true });
      }
      return json(200, {
        peers: (peers.Items || []).map((i) => i.peerId as number),
        peerCount: meta.Item.peerCount,
      });
    }

    // ── Write signal (offer, answer, ICE candidate) ────────────────────
    case 'PUT /api/rooms/{id}/signal': {
      const { peerId, type, sdp, candidate } = body as {
        peerId?: number;
        type?: SignalType;
        sdp?: unknown;
        candidate?: unknown;
      };
      if (typeof peerId !== 'number' || !type) {
        return json(400, { error: 'Missing peerId or type' });
      }

      if (type === 'offer' || type === 'answer') {
        // SDP is a JSON object {type, sdp}. Lightweight sanity check.
        if (typeof sdp !== 'object' || sdp === null) {
          return json(400, { error: 'Invalid sdp' });
        }
        await ddb.send(
          new PutCommand({
            TableName: TABLE,
            Item: { PK: `ROOM#${roomId}`, SK: `SIG#${peerId}#${type}`, sdp, ttl: ttl() },
          })
        );
      } else if (type === 'ice-to-client' || type === 'ice-to-host') {
        if (typeof candidate !== 'object' || candidate === null) {
          return json(400, { error: 'Invalid candidate' });
        }
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { PK: `ROOM#${roomId}`, SK: `SIG#${peerId}#${type}` },
              // Cap candidate list to MAX_CANDIDATES_PER_PEER to prevent abuse.
              UpdateExpression:
                'SET candidates = list_append(if_not_exists(candidates, :empty), :new), #t = :t',
              ConditionExpression: 'attribute_not_exists(candidates) OR size(candidates) < :cap',
              ExpressionAttributeNames: { '#t': 'ttl' },
              ExpressionAttributeValues: {
                ':empty': [],
                ':new': [candidate],
                ':t': ttl(),
                ':cap': MAX_CANDIDATES_PER_PEER,
              },
            })
          );
        } catch (e) {
          const err = e as { name?: string };
          if (err.name === 'ConditionalCheckFailedException') {
            return json(429, { error: 'ICE candidate cap reached' });
          }
          throw e;
        }
      } else {
        return json(400, { error: 'Invalid signal type' });
      }

      return json(200, { ok: true });
    }

    // ── Read signals for a peer ────────────────────────────────────────
    case 'GET /api/rooms/{id}/signal/{peerId}': {
      const peerIdNum = peerIdParam ? parseInt(peerIdParam, 10) : NaN;
      if (!Number.isInteger(peerIdNum) || peerIdNum < 1 || peerIdNum > MAX_PEERS) {
        return json(400, { error: 'Invalid peerId' });
      }
      const signals = await ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `ROOM#${roomId}`, ':sk': `SIG#${peerIdNum}#` },
        })
      );
      const result: {
        offer: unknown;
        answer: unknown;
        iceToClient: unknown[];
        iceToHost: unknown[];
      } = { offer: null, answer: null, iceToClient: [], iceToHost: [] };
      for (const item of signals.Items || []) {
        const sk = item.SK as string;
        if (sk.endsWith('#offer')) result.offer = item.sdp;
        else if (sk.endsWith('#answer')) result.answer = item.sdp;
        else if (sk.endsWith('#ice-to-client')) result.iceToClient = item.candidates || [];
        else if (sk.endsWith('#ice-to-host')) result.iceToHost = item.candidates || [];
      }
      return json(200, result);
    }

    // ── End room (destroy after successful pairing) ────────────────────
    case 'POST /api/rooms/{id}/end': {
      // Delete META + any PEER#/SIG# rows. Single Query + batched deletes
      // would be more thorough; for the demo, deleting META is enough —
      // remaining items expire via DDB TTL within 60s.
      await ddb.send(
        new DeleteCommand({ TableName: TABLE, Key: { PK: `ROOM#${roomId}`, SK: 'META' } })
      );
      return json(200, { ok: true });
    }

    default:
      // 200 instead of 404 so CloudFront's errorResponses[404] (which
      // rewrites 404 → SPA index.html) doesn't turn this into HTML.
      // Clients inspect the `error` field on the body.
      return json(200, { error: 'No matching route', routeKey });
  }
};
