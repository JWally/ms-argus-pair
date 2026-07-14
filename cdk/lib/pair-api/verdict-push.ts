import { postToPeer, type Envelope } from '../ws-handler';
import type { SealedVerdictEnvelope } from '../../../src/lib/verdict-envelope';

export async function pushVerdictToDesktop(args: {
  desktopEnv: Envelope;
  sessionId: string;
  envelope: SealedVerdictEnvelope;
  revealKey?: string;
}): Promise<void> {
  const mgmtEndpoint = process.env.WS_MGMT_ENDPOINT;
  if (!mgmtEndpoint) {
    console.warn('[pair] WS_MGMT_ENDPOINT not configured; skipping verdict push');
    return;
  }

  console.log(`[pair] verdict-push: posting sealed envelope cid=${args.desktopEnv.connectionId}`);
  const push = await postToPeer(mgmtEndpoint, args.desktopEnv.connectionId, {
    action: 'message',
    from: 'server',
    sessionId: args.sessionId,
    data: {
      kind: 'verdict-sealed',
      envelope: args.envelope,
    },
  });

  if (push.ok) {
    console.log(`[pair] verdict-push: ok cid=${args.desktopEnv.connectionId}`);
  } else {
    console.warn(`[pair] verdict-push failed: ${push.reason}`);
  }
  if (!args.revealKey) return;
  const release = await postToPeer(mgmtEndpoint, args.desktopEnv.connectionId, {
    action: 'message',
    from: 'server',
    sessionId: args.sessionId,
    data: { kind: 'verdict-release', revealKey: args.revealKey },
  });
  if (!release.ok) console.warn(`[pair] verdict-release push failed: ${release.reason}`);
}
