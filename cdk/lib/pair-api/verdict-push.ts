import { postToPeer, type Envelope } from '../ws-handler';

export async function pushVerdictToDesktop(args: {
  desktopEnv: Envelope;
  sessionId: string;
  verdict: string;
  reason: string;
  annotations: Record<string, unknown>;
}): Promise<void> {
  const mgmtEndpoint = process.env.WS_MGMT_ENDPOINT;
  if (!mgmtEndpoint) {
    console.warn('[pair] WS_MGMT_ENDPOINT not configured; skipping verdict push');
    return;
  }

  console.log(
    `[pair] verdict-push: posting to cid=${args.desktopEnv.connectionId} verdict=${args.verdict}`
  );
  const push = await postToPeer(mgmtEndpoint, args.desktopEnv.connectionId, {
    action: 'message',
    from: 'server',
    sessionId: args.sessionId,
    data: {
      kind: 'verdict',
      verdict: args.verdict,
      reason: args.reason,
      annotations: args.annotations,
    },
  });

  if (push.ok) {
    console.log(`[pair] verdict-push: ok cid=${args.desktopEnv.connectionId}`);
  } else {
    console.warn(`[pair] verdict-push failed: ${push.reason}`);
  }
}
