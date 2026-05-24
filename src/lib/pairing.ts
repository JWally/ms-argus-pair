/**
 * WebSocket-based pairing client.
 *
 * Wire protocol matches cdk/lib/signaling-ws.ts. Each side opens its own
 * WebSocket to the signaling server, exchanges a handful of messages, and
 * builds a direct WebRTC DataChannel. The signaling WS closes as soon as
 * the data channel is open.
 *
 * Stateless on the server side: pairing info is carried in HMAC-signed
 * tokens. Host gets a roomToken on create; phone receives it via the QR
 * code, validates by sending {action:"join", roomToken}, and the server
 * pushes each side a peerToken it can address the other with.
 */

const SIGNALING_URL = 'wss://signal-dev-jw.argus.pw';

const PAIR_TIMEOUT_MS = 60_000;
const STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export interface PairEvents {
  onStatus?: (status: string) => void;
  onPeerJoined?: () => void;
  onConnected?: (
    dc: RTCDataChannel,
    info: { selectedCandidatePair?: RTCIceCandidatePairStats }
  ) => void;
  onMessage?: (data: string | ArrayBuffer) => void;
  onError?: (err: unknown) => void;
}

interface ServerEvent {
  event: string;
  [k: string]: unknown;
}

class Signaler {
  private ws: WebSocket;
  private opened: Promise<void>;
  private handlers = new Map<string, (msg: ServerEvent) => void>();
  private closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`WebSocket error: ${String(e)}`));
    });
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerEvent;
        const h = this.handlers.get(msg.event);
        if (h) h(msg);
        else console.warn('[pair] unhandled signaling event', msg);
      } catch (e) {
        console.warn('[pair] bad signaling message', e, ev.data);
      }
    };
    this.ws.onclose = () => {
      this.closed = true;
    };
  }

  ready(): Promise<void> {
    return this.opened;
  }

  on(event: string, handler: (msg: ServerEvent) => void): void {
    this.handlers.set(event, handler);
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

function buildPC(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: STUN_SERVERS });
}

async function selectedCandidatePair(
  pc: RTCPeerConnection
): Promise<RTCIceCandidatePairStats | undefined> {
  try {
    const stats = await pc.getStats();
    for (const [, report] of stats) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        return report as RTCIceCandidatePairStats;
      }
    }
  } catch {
    /* noop */
  }
  return undefined;
}

// ── HOST (desktop) ───────────────────────────────────────────────────────

export async function createRoom(events: PairEvents = {}): Promise<{
  roomId: string;
  roomToken: string;
  stop: () => void;
  ready: Promise<void>;
}> {
  events.onStatus?.('connecting to signaling');
  const sig = new Signaler(SIGNALING_URL);
  await sig.ready();

  const pc = buildPC();
  const dc = pc.createDataChannel('argus-pair', { ordered: true });
  let peerToken: string | null = null;
  let timer: number | null = null;

  let resolveReady: () => void = () => {};
  let rejectReady: (e: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveCreated: (v: { roomId: string; roomToken: string }) => void = () => {};
  const createdP = new Promise<{ roomId: string; roomToken: string }>((resolve) => {
    resolveCreated = resolve;
  });

  const stop = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    sig.close();
    try {
      dc.close();
    } catch {
      /* noop */
    }
    pc.close();
  };

  timer = window.setTimeout(() => {
    if (dc.readyState !== 'open') {
      rejectReady(new Error('Pairing timed out'));
      stop();
    }
  }, PAIR_TIMEOUT_MS);

  pc.onicecandidate = (ev) => {
    if (ev.candidate && peerToken) {
      sig.send({
        action: 'relay',
        to: peerToken,
        payload: { kind: 'ice', candidate: ev.candidate },
      });
    }
  };

  dc.onopen = async () => {
    events.onStatus?.('connected');
    const pair = await selectedCandidatePair(pc);
    events.onConnected?.(dc, { selectedCandidatePair: pair });
    resolveReady();
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    sig.close();
  };
  dc.onmessage = (ev) => events.onMessage?.(ev.data);
  dc.onerror = (e) => events.onError?.(e);

  sig.on('room_created', (msg) => {
    resolveCreated({ roomId: msg.roomId as string, roomToken: msg.roomToken as string });
    events.onStatus?.('waiting for phone');
  });

  sig.on('peer_joined', async (msg) => {
    peerToken = msg.peerToken as string;
    events.onPeerJoined?.();
    events.onStatus?.('phone joined; negotiating');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig.send({
      action: 'relay',
      to: peerToken,
      payload: { kind: 'offer', sdp: pc.localDescription },
    });
  });

  sig.on('relay', async (msg) => {
    const payload = msg.payload as {
      kind: string;
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    if (payload.kind === 'answer' && payload.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    } else if (payload.kind === 'ice' && payload.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (e) {
        console.warn('[pair] addIceCandidate', e);
      }
    }
  });

  sig.on('peer_gone', () => {
    events.onStatus?.('peer disconnected');
    rejectReady(new Error('Peer disconnected'));
    stop();
  });

  sig.on('error', (msg) => {
    rejectReady(new Error((msg.message as string) || 'Signaling error'));
    stop();
  });

  sig.send({ action: 'create' });
  const { roomId, roomToken } = await createdP;

  return { roomId, roomToken, stop, ready };
}

// ── CLIENT (phone) ───────────────────────────────────────────────────────

export async function joinRoom(
  roomToken: string,
  events: PairEvents = {}
): Promise<{ stop: () => void; ready: Promise<void> }> {
  events.onStatus?.('connecting to signaling');
  const sig = new Signaler(SIGNALING_URL);
  await sig.ready();

  const pc = buildPC();
  let dc: RTCDataChannel | null = null;
  let peerToken: string | null = null;
  let timer: number | null = null;

  let resolveReady: () => void = () => {};
  let rejectReady: (e: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const stop = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    sig.close();
    try {
      dc?.close();
    } catch {
      /* noop */
    }
    pc.close();
  };

  timer = window.setTimeout(() => {
    if (dc?.readyState !== 'open') {
      rejectReady(new Error('Pairing timed out'));
      stop();
    }
  }, PAIR_TIMEOUT_MS);

  pc.onicecandidate = (ev) => {
    if (ev.candidate && peerToken) {
      sig.send({
        action: 'relay',
        to: peerToken,
        payload: { kind: 'ice', candidate: ev.candidate },
      });
    }
  };

  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = async () => {
      events.onStatus?.('connected');
      const pair = await selectedCandidatePair(pc);
      events.onConnected?.(dc!, { selectedCandidatePair: pair });
      resolveReady();
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      sig.close();
    };
    dc.onmessage = (e) => events.onMessage?.(e.data);
    dc.onerror = (e) => events.onError?.(e);
  };

  sig.on('joined', (msg) => {
    // Server echoes back the original roomToken — it's the address that
    // routes to the host's connection.
    peerToken = msg.peerToken as string;
    events.onStatus?.('joined; waiting for offer');
  });

  sig.on('relay', async (msg) => {
    const payload = msg.payload as {
      kind: string;
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    if (payload.kind === 'offer' && payload.sdp && peerToken) {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sig.send({
        action: 'relay',
        to: peerToken,
        payload: { kind: 'answer', sdp: pc.localDescription },
      });
      events.onStatus?.('negotiating');
    } else if (payload.kind === 'ice' && payload.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (e) {
        console.warn('[pair] addIceCandidate', e);
      }
    }
  });

  sig.on('peer_gone', () => {
    rejectReady(new Error('Peer disconnected'));
    stop();
  });

  sig.on('error', (msg) => {
    rejectReady(new Error((msg.message as string) || 'Signaling error'));
    stop();
  });

  sig.send({ action: 'join', roomToken });

  return { stop, ready };
}
