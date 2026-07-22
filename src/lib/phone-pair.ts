import {
  awaitDesktopReady,
  clearPasskeyHint,
  signalChallengeDone,
  submitPhoneAttestation,
} from './pair';

/** The only pair-orchestration operations exposed to the lazy phone entry. */
export const phonePair = {
  awaitDesktopReady,
  clearPasskeyHint,
  signalChallengeDone,
  submitPhoneAttestation,
};
