/**
 * Browser-side client for the ms-argus-pair WebSocket envelope flow.
 *
 * Wire protocol matches `cdk/lib/ws-handler.ts`:
 *   - whoami: client sends { action:'whoami', token, origin, publicKey? }
 *             server replies { action:'whoami', envelope, sessionId, role }
 *   - peer:   client sends { action:'message', me, peer, data }
 *             server forwards to peer as { action:'message', from,
 *                                          fromEnvelope, sessionId, data }
 *
 * Envelopes are opaque AES-GCM-sealed blobs minted by the server during
 * whoami. The client only ever round-trips them — never inspects.
 *
 * `fromEnvelope` arriving on a relayed peer message is how a recipient
 * learns the sender's envelope without a separate handshake. First
 * message in a session establishes the back-channel both directions.
 */

interface PeerMessage {
  action: 'message';
  from: 'desktop' | 'phone';
  /** The sender's sealed envelope — recipient stores it to reply later. */
  fromEnvelope: string;
  sessionId: string;
  /** Arbitrary application payload; sender chooses shape. */
  data: unknown;
}

export interface WsConnection {
  envelope: string;
  sessionId: string;
  role: 'desktop' | 'phone';
  /** Send an application payload to the peer at `peerEnvelope`. */
  sendPeer(peerEnvelope: string, data: unknown): void;
  /** Subscribe to ALL relayed peer messages. Returns an unsubscribe fn. */
  onMessage(handler: (msg: PeerMessage) => void): () => void;
  /** Resolves with the first peer message satisfying `predicate`. */
  waitForMessage(
    predicate: (msg: PeerMessage) => boolean,
    timeoutMs?: number
  ): Promise<PeerMessage>;
  close(): void;
}

function parseJson<T = unknown>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const onOpen = () => {
      ws.removeEventListener('error', onError);
      resolve();
    };
    const onError = (ev: Event) => {
      ws.removeEventListener('open', onOpen);
      reject(new Error(`ws open failed: ${(ev as ErrorEvent).message ?? 'unknown'}`));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
}

interface WhoamiResp {
  action: 'whoami';
  envelope: string;
  sessionId: string;
  role: 'desktop' | 'phone';
}

/**
 * Open a WebSocket and wait for the TCP+TLS handshake to complete.
 * Splitting open() from whoami() lets callers parallelise the WS
 * handshake with /session/start — the token comes from the HTTP
 * response but $connect doesn't require it, so the WS handshake can
 * race the HTTP round-trip and the two latencies overlap instead of
 * stacking.
 */
export async function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await waitOpen(ws);
  return ws;
}

/**
 * Open a WebSocket, send whoami, return a ready-to-use connection
 * carrying the sealed envelope. The envelope is the routing handle the
 * caller hands to peers (via QR, peer-relay, etc.) so they can address it.
 *
 * Pass `existingWs` when the caller has already opened the socket via
 * openWs() — this is the parallel-handshake path. Without it, we open
 * the socket here (the original behaviour, retained for callers that
 * don't have a static URL available before /session/start completes).
 */
export async function connectAndWhoami(opts: {
  url: string;
  token: string;
  origin: string;
  publicKey?: string;
  timeoutMs?: number;
  existingWs?: WebSocket;
}): Promise<WsConnection> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const ws = opts.existingWs ?? new WebSocket(opts.url);
  if (!opts.existingWs) await waitOpen(ws);

  // Set up the persistent peer-message fanout BEFORE sending whoami so
  // we never miss a server reply. The whoami response itself isn't a
  // peer message (action='whoami', not 'message'), but the fanout only
  // dispatches action='message', so the one-shot listener below sees
  // the whoami unambiguously.
  //
  // API Gateway returns the body of a non-2xx Lambda WS response as a
  // raw string back over the connection (not wrapped JSON). Watch for
  // those too — they're how the server tells us a peer message was
  // rejected (e.g. cross_session, envelope_expired). Silent drops here
  // were what made the first dev-jw run look like a hang.
  const peerHandlers = new Set<(msg: PeerMessage) => void>();
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') {
      const trimmed = ev.data.trim();
      if (trimmed && !trimmed.startsWith('{')) {
        console.warn(`[ws] server error from peer route: ${trimmed}`);
        return;
      }
    }
    const parsed = parseJson<PeerMessage>(ev.data);
    if (parsed && parsed.action === 'message') {
      for (const h of peerHandlers) h(parsed);
    }
  });

  const whoami = await new Promise<WhoamiResp>((resolve, reject) => {
    const t = window.setTimeout(() => {
      ws.removeEventListener('message', listener);
      reject(new Error('whoami timeout'));
    }, timeoutMs);
    const listener = (ev: MessageEvent) => {
      const parsed = parseJson<{ action?: string }>(ev.data);
      if (parsed?.action === 'whoami') {
        window.clearTimeout(t);
        ws.removeEventListener('message', listener);
        resolve(parsed as WhoamiResp);
      }
    };
    ws.addEventListener('message', listener);
    ws.send(
      JSON.stringify({
        action: 'whoami',
        token: opts.token,
        origin: opts.origin,
        publicKey: opts.publicKey,
      })
    );
  });

  return {
    envelope: whoami.envelope,
    sessionId: whoami.sessionId,
    role: whoami.role,
    sendPeer(peerEnvelope, data) {
      ws.send(
        JSON.stringify({
          action: 'message',
          me: whoami.envelope,
          peer: peerEnvelope,
          data,
        })
      );
    },
    onMessage(handler) {
      peerHandlers.add(handler);
      return () => peerHandlers.delete(handler);
    },
    waitForMessage(predicate, timeoutMs = 60_000) {
      return new Promise<PeerMessage>((resolve, reject) => {
        const t = window.setTimeout(() => {
          peerHandlers.delete(h);
          reject(new Error('peer message timeout'));
        }, timeoutMs);
        const h = (msg: PeerMessage) => {
          if (predicate(msg)) {
            window.clearTimeout(t);
            peerHandlers.delete(h);
            resolve(msg);
          }
        };
        peerHandlers.add(h);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
