#!/usr/bin/env node
// Local in-memory signaling server. Mirrors the Lambda's contract so the
// Vite dev proxy (vite.config.ts → /api → localhost:9090) just works.
// State lives in process memory and disappears when the server stops.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.PORT || '9090', 10);
const ROOM_TTL_MS = 60_000;
const MAX_PEERS = 2;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CANDIDATES = 30;

/** @type {Map<string, {nextPeerId: number, peerCount: number, expiresAt: number, peers: Set<number>, signals: Map<string, any>}>} */
const rooms = new Map();

function ttl() {
  return Date.now() + ROOM_TTL_MS;
}

function getRoom(id) {
  const r = rooms.get(id);
  if (!r) return null;
  if (Date.now() > r.expiresAt) {
    rooms.delete(id);
    return null;
  }
  return r;
}

function touch(r) {
  r.expiresAt = ttl();
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method;

  if (m === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '3600',
    });
    res.end();
    return;
  }

  // POST /rooms
  if (m === 'POST' && p === '/rooms') {
    const id = crypto.randomUUID();
    rooms.set(id, {
      nextPeerId: 2,
      peerCount: 1,
      expiresAt: ttl(),
      peers: new Set(),
      signals: new Map(),
    });
    console.log(`[sig] room ${id} created`);
    return send(res, 200, { roomId: id, peerId: 1, ttlSeconds: 60 });
  }

  const match = (re) => p.match(re);
  let mm;

  // POST /rooms/:id/join
  if (m === 'POST' && (mm = match(/^\/rooms\/([^/]+)\/join$/))) {
    const id = mm[1].toLowerCase();
    if (!UUID_RE.test(id)) return send(res, 400, { error: 'Invalid room id' });
    const r = getRoom(id);
    if (!r) return send(res, 409, { error: 'Room not found, expired, or full' });
    if (r.peerCount >= MAX_PEERS) return send(res, 409, { error: 'Room full' });
    const peerId = r.nextPeerId++;
    r.peerCount++;
    r.peers.add(peerId);
    touch(r);
    console.log(`[sig] peer ${peerId} joined ${id}`);
    return send(res, 200, { peerId });
  }

  // GET /rooms/:id/peers
  if (m === 'GET' && (mm = match(/^\/rooms\/([^/]+)\/peers$/))) {
    const id = mm[1].toLowerCase();
    if (!UUID_RE.test(id)) return send(res, 400, { error: 'Invalid room id' });
    const r = getRoom(id);
    // 200 + expired:true so client behavior matches prod (CloudFront's
    // errorResponses[404] would otherwise turn a real 404 into SPA HTML).
    if (!r) return send(res, 200, { peers: [], peerCount: 0, expired: true });
    return send(res, 200, { peers: [...r.peers], peerCount: r.peerCount });
  }

  // PUT /rooms/:id/signal
  if (m === 'PUT' && (mm = match(/^\/rooms\/([^/]+)\/signal$/))) {
    const id = mm[1].toLowerCase();
    if (!UUID_RE.test(id)) return send(res, 400, { error: 'Invalid room id' });
    const r = getRoom(id);
    if (!r) return send(res, 404, { error: 'Room not found' });
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 413, { error: e.message });
    }
    if (body === null) return send(res, 400, { error: 'Invalid body' });
    const { peerId, type, sdp, candidate } = body;
    if (typeof peerId !== 'number' || !type) {
      return send(res, 400, { error: 'Missing peerId or type' });
    }
    if (type === 'offer' || type === 'answer') {
      if (typeof sdp !== 'object' || sdp === null) {
        return send(res, 400, { error: 'Invalid sdp' });
      }
      r.signals.set(`${peerId}#${type}`, { sdp });
    } else if (type === 'ice-to-client' || type === 'ice-to-host') {
      if (typeof candidate !== 'object' || candidate === null) {
        return send(res, 400, { error: 'Invalid candidate' });
      }
      const key = `${peerId}#${type}`;
      const slot = r.signals.get(key) || { candidates: [] };
      if (slot.candidates.length >= MAX_CANDIDATES) {
        return send(res, 429, { error: 'ICE candidate cap reached' });
      }
      slot.candidates.push(candidate);
      r.signals.set(key, slot);
    } else {
      return send(res, 400, { error: 'Invalid signal type' });
    }
    touch(r);
    return send(res, 200, { ok: true });
  }

  // GET /rooms/:id/signal/:peerId
  if (m === 'GET' && (mm = match(/^\/rooms\/([^/]+)\/signal\/(\d+)$/))) {
    const id = mm[1].toLowerCase();
    if (!UUID_RE.test(id)) return send(res, 400, { error: 'Invalid room id' });
    const peerId = parseInt(mm[2], 10);
    if (!Number.isInteger(peerId) || peerId < 1 || peerId > MAX_PEERS) {
      return send(res, 400, { error: 'Invalid peerId' });
    }
    const r = getRoom(id);
    if (!r) return send(res, 404, { error: 'Room not found' });
    return send(res, 200, {
      offer: r.signals.get(`${peerId}#offer`)?.sdp || null,
      answer: r.signals.get(`${peerId}#answer`)?.sdp || null,
      iceToClient: r.signals.get(`${peerId}#ice-to-client`)?.candidates || [],
      iceToHost: r.signals.get(`${peerId}#ice-to-host`)?.candidates || [],
    });
  }

  // POST /rooms/:id/end
  if (m === 'POST' && (mm = match(/^\/rooms\/([^/]+)\/end$/))) {
    const id = mm[1].toLowerCase();
    if (!UUID_RE.test(id)) return send(res, 400, { error: 'Invalid room id' });
    rooms.delete(id);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Not found' });
});

// Periodic GC for expired rooms.
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (r.expiresAt < now) {
      rooms.delete(id);
      console.log(`[sig] room ${id} expired`);
    }
  }
}, 10_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sig] listening on http://0.0.0.0:${PORT}`);
});
