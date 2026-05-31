/**
 * 2-client smoke test for the WebSocket envelope flow.
 *
 * - POST /session/start  → grabs WS URL + desktopToken + phoneToken
 * - Opens TWO WebSocket connections (desktop + phone), both send whoami,
 *   both receive an AES-sealed envelope
 * - Desktop sends a `message` to phone using `{me: desktopEnv, peer: phoneEnv}`
 * - Phone confirms it received the relayed payload
 *
 * Pure cli, no browser. Run from the repo root:
 *
 *   npx tsx scripts/test-ws-pair.mts
 */
import WebSocket from 'ws';

const PAIR_HOST = process.env.PAIR_HOST ?? 'https://captcha-dev-jw.argus.pw';
const ORIGIN = process.env.PAIR_ORIGIN ?? PAIR_HOST;

interface SessionStart {
  sessionId: string;
  nonce: string;
  expiresAt: number;
  ws: {
    url: string;
    desktopToken: string;
    phoneToken: string;
  };
}

async function startSession(): Promise<SessionStart> {
  const res = await fetch(`${PAIR_HOST}/api/session/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`session/start ${res.status}`);
  return (await res.json()) as SessionStart;
}

interface ClientState {
  ws: WebSocket;
  envelope?: string;
  inbox: unknown[];
}

function openClient(wsUrl: string, role: string): Promise<ClientState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const state: ClientState = { ws, inbox: [] };
    ws.on('open', () => resolve(state));
    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { action?: string; envelope?: string };
        console.log(`[${role}] <-`, parsed);
        state.inbox.push(parsed);
        if (parsed.action === 'whoami' && typeof parsed.envelope === 'string') {
          state.envelope = parsed.envelope;
        }
      } catch (e) {
        console.error(`[${role}] message parse error`, e);
      }
    });
    ws.on('error', (e) => reject(e));
  });
}

async function sendAndWait(
  state: ClientState,
  payload: unknown,
  predicate: (m: unknown) => boolean,
  timeoutMs = 5_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMsg = (raw: WebSocket.RawData) => {
      try {
        const m = JSON.parse(raw.toString());
        if (predicate(m)) {
          state.ws.off('message', onMsg);
          resolve(m);
        }
      } catch {
        /* ignore */
      }
    };
    state.ws.on('message', onMsg);
    state.ws.send(JSON.stringify(payload));
    setTimeout(() => {
      state.ws.off('message', onMsg);
      reject(new Error('timeout'));
    }, timeoutMs);
  });
}

async function main() {
  console.log('--- starting session ---');
  const s = await startSession();
  console.log(`sessionId=${s.sessionId}`);
  console.log(`ws url   =${s.ws.url}`);

  console.log('--- connecting desktop + phone ---');
  const [desktop, phone] = await Promise.all([
    openClient(s.ws.url, 'desktop'),
    openClient(s.ws.url, 'phone'),
  ]);
  console.log('both connected');

  console.log('--- whoami: desktop ---');
  const desktopWhoami = (await sendAndWait(
    desktop,
    {
      action: 'whoami',
      token: s.ws.desktopToken,
      origin: ORIGIN,
      publicKey: 'desktop-pubkey-stub',
    },
    (m) => (m as { action?: string }).action === 'whoami'
  )) as { envelope: string };
  console.log('desktop envelope length:', desktopWhoami.envelope.length);

  console.log('--- whoami: phone ---');
  const phoneWhoami = (await sendAndWait(
    phone,
    {
      action: 'whoami',
      token: s.ws.phoneToken,
      origin: ORIGIN,
      publicKey: 'phone-pubkey-stub',
    },
    (m) => (m as { action?: string }).action === 'whoami'
  )) as { envelope: string };
  console.log('phone envelope length:', phoneWhoami.envelope.length);

  if (desktopWhoami.envelope === phoneWhoami.envelope) {
    throw new Error('envelopes are identical — sealing is broken');
  }
  console.log('✓ envelopes distinct');

  console.log('--- desktop → phone message ---');
  // Listen on phone for the relayed payload BEFORE desktop sends.
  const phoneRecv = new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('phone never received message')), 5_000);
    phone.ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if ((m as { action?: string }).action === 'message') {
          clearTimeout(t);
          resolve(m);
        }
      } catch {
        /* ignore */
      }
    });
  });
  desktop.ws.send(
    JSON.stringify({
      action: 'message',
      me: desktopWhoami.envelope,
      peer: phoneWhoami.envelope,
      data: { hello: 'phone', from: 'desktop' },
    })
  );
  const relayed = (await phoneRecv) as { from: string; data: unknown };
  console.log('phone received:', relayed);
  if (relayed.from !== 'desktop') throw new Error('wrong from');
  console.log('✓ message routed via sealed envelopes');

  console.log('--- closing ---');
  desktop.ws.close();
  phone.ws.close();
  console.log('\n✓✓✓ all checks passed ✓✓✓');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
