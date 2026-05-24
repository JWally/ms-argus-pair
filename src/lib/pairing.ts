/**
 * WebRTC pairing client. Adapted from web-quaker for two-peer-only pairing
 * over same-origin /api signaling. Returns a Promise that resolves when the
 * DataChannel opens.
 *
 * Host (desktop): createRoom() → POST /api/rooms; poll for peers; on join,
 * create offer + DataChannel; poll for answer + ICE.
 *
 * Client (phone): joinRoom(roomId) → POST /api/rooms/:id/join; poll for offer;
 * create answer + send ICE.
 */

const API = '/api';
const POLL_MS = 500;
// Stop polling after this long if the channel never opens. Matches the
// signaling-room TTL on the server — past this point the room is gone
// anyway, and idle polls just bill Lambda invocations.
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

interface CreateRoomResponse {
  roomId: string;
  peerId: number;
  ttlSeconds: number;
}

interface JoinRoomResponse {
  peerId: number;
}

interface SignalsResponse {
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
  iceToClient: RTCIceCandidateInit[];
  iceToHost: RTCIceCandidateInit[];
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
  const method = init?.method || 'GET';
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const snippet = (await res.text()).slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(
      `${method} ${input} → ${res.status} non-JSON (${contentType || 'no content-type'}): ${snippet}`
    );
  }
  if (!res.ok) {
    // Status is a real error code AND body is JSON; surface the error body.
    const errBody = await res.text();
    throw new Error(`${method} ${input} → ${res.status} ${errBody.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function putSignal(
  roomId: string,
  peerId: number,
  type: 'offer' | 'answer' | 'ice-to-client' | 'ice-to-host',
  payload: RTCSessionDescription | RTCIceCandidate
): Promise<unknown> {
  const body: Record<string, unknown> = { peerId, type };
  if (type === 'offer' || type === 'answer') body.sdp = payload;
  else body.candidate = payload;
  return jsonFetch(`${API}/rooms/${roomId}/signal`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }).catch((e) => {
    console.warn('[pair] signal PUT error', e);
  });
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
  stop: () => void;
  ready: Promise<void>;
}> {
  events.onStatus?.('creating room');
  const room = await jsonFetch<CreateRoomResponse>(`${API}/rooms`, { method: 'POST' });
  const roomId = room.roomId;

  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  const dc = pc.createDataChannel('argus-pair', { ordered: true });
  let sentOffer = false;
  let appliedAnswer = false;
  let iceIdx = 0;
  let pollTimer: number | null = null;
  let resolveReady: () => void = () => {};
  let rejectReady: (e: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  pc.onicecandidate = (ev) => {
    // Host sends candidates intended for the client (the joiner).
    if (ev.candidate) putSignal(roomId, /* joiner */ 2, 'ice-to-client', ev.candidate);
  };

  dc.onopen = async () => {
    events.onStatus?.('connected');
    const pair = await selectedCandidatePair(pc);
    events.onConnected?.(dc, { selectedCandidatePair: pair });
    resolveReady();
  };
  dc.onmessage = (ev) => events.onMessage?.(ev.data);
  dc.onerror = (e) => events.onError?.(e);

  // Poll: discover joiner, then exchange offer/answer/ICE.
  events.onStatus?.('waiting for phone');
  let peerSeen = false;
  const pollStartedAt = Date.now();
  pollTimer = window.setInterval(async () => {
    try {
      if (Date.now() - pollStartedAt > PAIR_TIMEOUT_MS && dc.readyState !== 'open') {
        if (pollTimer !== null) window.clearInterval(pollTimer);
        pollTimer = null;
        rejectReady(new Error('Pairing timed out'));
        return;
      }
      if (!peerSeen) {
        const list = await jsonFetch<{ peers: number[]; peerCount: number; expired?: boolean }>(
          `${API}/rooms/${roomId}/peers`
        );
        if (list.expired) {
          if (pollTimer !== null) window.clearInterval(pollTimer);
          pollTimer = null;
          rejectReady(new Error('Room expired'));
          return;
        }
        if (list.peers.includes(2)) {
          peerSeen = true;
          events.onPeerJoined?.();
          events.onStatus?.('phone joined; negotiating');
          if (!sentOffer) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await putSignal(roomId, 2, 'offer', pc.localDescription!);
            sentOffer = true;
          }
        }
      }

      if (peerSeen) {
        // We polled the joiner's signaling slot (peerId=2) for answer + ICE.
        const sigs = await jsonFetch<SignalsResponse>(`${API}/rooms/${roomId}/signal/2`);
        if (sigs.answer && !appliedAnswer) {
          await pc.setRemoteDescription(new RTCSessionDescription(sigs.answer));
          appliedAnswer = true;
        }
        if (sigs.iceToHost.length > iceIdx) {
          for (let i = iceIdx; i < sigs.iceToHost.length; i++) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(sigs.iceToHost[i]));
            } catch (e) {
              console.warn('[pair] addIceCandidate', e);
            }
          }
          iceIdx = sigs.iceToHost.length;
        }
      }

      if (dc.readyState === 'open' && pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
        jsonFetch(`${API}/rooms/${roomId}/end`, { method: 'POST' }).catch(() => {});
      }
    } catch (e) {
      events.onError?.(e);
      rejectReady(e);
    }
  }, POLL_MS);

  const stop = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    try {
      dc.close();
    } catch {
      /* noop */
    }
    pc.close();
  };

  return { roomId, stop, ready };
}

// ── CLIENT (phone) ───────────────────────────────────────────────────────

export async function joinRoom(
  roomId: string,
  events: PairEvents = {}
): Promise<{ stop: () => void; ready: Promise<void> }> {
  events.onStatus?.('joining room');
  const join = await jsonFetch<JoinRoomResponse>(`${API}/rooms/${roomId}/join`, {
    method: 'POST',
  });
  const myPeerId = join.peerId;

  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  let dc: RTCDataChannel | null = null;
  let appliedOffer = false;
  let iceIdx = 0;
  let pollTimer: number | null = null;
  let resolveReady: () => void = () => {};
  let rejectReady: (e: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  pc.onicecandidate = (ev) => {
    if (ev.candidate) putSignal(roomId, myPeerId, 'ice-to-host', ev.candidate);
  };

  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = async () => {
      events.onStatus?.('connected');
      const pair = await selectedCandidatePair(pc);
      events.onConnected?.(dc!, { selectedCandidatePair: pair });
      resolveReady();
    };
    dc.onmessage = (e) => events.onMessage?.(e.data);
    dc.onerror = (e) => events.onError?.(e);
  };

  events.onStatus?.('waiting for offer');
  const pollStartedAt = Date.now();
  pollTimer = window.setInterval(async () => {
    try {
      if (Date.now() - pollStartedAt > PAIR_TIMEOUT_MS && dc?.readyState !== 'open') {
        if (pollTimer !== null) window.clearInterval(pollTimer);
        pollTimer = null;
        rejectReady(new Error('Pairing timed out'));
        return;
      }
      const sigs = await jsonFetch<SignalsResponse>(`${API}/rooms/${roomId}/signal/${myPeerId}`);
      if (sigs.offer && !appliedOffer) {
        appliedOffer = true;
        await pc.setRemoteDescription(new RTCSessionDescription(sigs.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await putSignal(roomId, myPeerId, 'answer', pc.localDescription!);
        events.onStatus?.('negotiating');
      }
      if (sigs.iceToClient.length > iceIdx) {
        for (let i = iceIdx; i < sigs.iceToClient.length; i++) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(sigs.iceToClient[i]));
          } catch (e) {
            console.warn('[pair] addIceCandidate', e);
          }
        }
        iceIdx = sigs.iceToClient.length;
      }
      if (dc && dc.readyState === 'open' && pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (e) {
      events.onError?.(e);
      rejectReady(e);
    }
  }, POLL_MS);

  const stop = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    try {
      dc?.close();
    } catch {
      /* noop */
    }
    pc.close();
  };

  return { stop, ready };
}
