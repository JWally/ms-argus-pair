import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  encodeVerdictRevealKey,
  sealFixedVerdictEnvelope,
  type DesktopVerdictPayload,
  type PhoneStatePayload,
  type SealedVerdictEnvelope,
} from '../../../src/lib/verdict-envelope';
import { deriveVerdictRevealKey } from '../ws-handler';
import type { Envelope } from '../ws-handler/router';
import { pushVerdictToDesktop } from './verdict-push';
import {
  loadVerdictRevealState,
  shouldReleaseVerdict,
  type VerdictRevealState,
} from './verdict-reveal-store';

interface VerdictDisclosureDeps {
  ddb: DynamoDBDocumentClient;
  tableName: string;
}

interface DecisionInput {
  sessionId: string;
  verdict: 'paired' | 'failed';
  reason: string | null;
  annotations: Record<string, unknown>;
  nextDeviceTrust: string | null;
  decidedAt: number;
}

interface SealedDecision {
  desktopEnvelope: SealedVerdictEnvelope;
  phoneEnvelope: SealedVerdictEnvelope;
  revealKey: string;
  revealState: VerdictRevealState | null;
}

async function sealDesktopVerdict(
  revealKey: Uint8Array,
  sessionId: string,
  payload: DesktopVerdictPayload
): Promise<SealedVerdictEnvelope> {
  try {
    return await sealFixedVerdictEnvelope(revealKey, sessionId, payload);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'verdict payload exceeds fixed envelope') {
      throw error;
    }
    // Preserve authorization if diagnostic annotations exceed the fixed WS
    // envelope. Length remains constant and truncation stays explicit.
    return sealFixedVerdictEnvelope(revealKey, sessionId, {
      ...payload,
      annotations: { verdict_annotations_truncated: true },
    });
  }
}

async function buildSealedDecision(
  deps: VerdictDisclosureDeps,
  input: DecisionInput
): Promise<SealedDecision> {
  const revealKey = await deriveVerdictRevealKey(input.sessionId);
  const desktopPayload: DesktopVerdictPayload = {
    kind: 'desktop-verdict',
    verdict: input.verdict,
    reason: input.reason,
    annotations: input.annotations,
  };
  const phonePayload: PhoneStatePayload = {
    kind: 'phone-state',
    verdict: input.verdict,
    nextDeviceTrust: input.nextDeviceTrust,
  };
  const [desktopEnvelope, phoneEnvelope, revealState] = await Promise.all([
    sealDesktopVerdict(revealKey, input.sessionId, desktopPayload),
    sealFixedVerdictEnvelope(revealKey, input.sessionId, phonePayload),
    loadVerdictRevealState(deps.ddb, deps.tableName, input.sessionId),
  ]);
  return {
    desktopEnvelope,
    phoneEnvelope,
    revealKey: encodeVerdictRevealKey(revealKey),
    revealState,
  };
}

export async function deliverSealedVerdict(
  deps: VerdictDisclosureDeps,
  input: DecisionInput & { desktopEnv: Envelope; now: number }
): Promise<Record<string, unknown>> {
  const sealed = await buildSealedDecision(deps, input);
  const releaseNow = shouldReleaseVerdict(sealed.revealState, input.decidedAt, input.now);
  await pushVerdictToDesktop({
    desktopEnv: input.desktopEnv,
    sessionId: input.sessionId,
    envelope: sealed.desktopEnvelope,
    ...(releaseNow ? { revealKey: sealed.revealKey } : {}),
  });
  return {
    verdict: 'complete',
    reason: null,
    annotations: {},
    phoneState: sealed.phoneEnvelope,
    ...(releaseNow ? { revealKey: sealed.revealKey } : {}),
  };
}

export async function buildSealedResult(
  deps: VerdictDisclosureDeps,
  input: DecisionInput & { now: number }
): Promise<Record<string, unknown>> {
  const sealed = await buildSealedDecision(deps, input);
  const releaseNow = shouldReleaseVerdict(sealed.revealState, input.decidedAt, input.now);
  return {
    status: 'sealed',
    envelope: sealed.desktopEnvelope,
    ...(releaseNow ? { revealKey: sealed.revealKey } : {}),
  };
}

export async function isVerdictReleased(
  deps: VerdictDisclosureDeps,
  sessionId: string,
  decidedAt: number,
  now: number
): Promise<boolean> {
  const revealState = await loadVerdictRevealState(deps.ddb, deps.tableName, sessionId);
  return shouldReleaseVerdict(revealState, decidedAt, now);
}
