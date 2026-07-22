import { awaitDesktopReady, signalChallengeDone, submitPhoneAttestation } from './pair';
import { clearPasskeyHint } from './passkey-client';

/** The only pair-orchestration operations exposed to the lazy phone entry. */
export const phonePair = {
  awaitDesktopReady,
  clearPasskeyHint,
  signalChallengeDone,
  submitPhoneAttestation,
};
