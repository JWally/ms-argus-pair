export type EmbedCompletion = null | 'paired' | 'timeout' | 'failed';
export type EmbedPhase = 'scanning' | 'pairing' | 'verified' | 'timeout' | 'failed';

export interface EmbedPresentation {
  phase: EmbedPhase;
  title: string;
  instruction: string;
  trackStatus: string;
}

export const SCAN_HINT_DELAY_MS = 7_000;

const PRESENTATION: Record<EmbedPhase, Omit<EmbedPresentation, 'phase'>> = {
  scanning: {
    title: 'Scan with your phone',
    instruction: "Open your phone's camera and point it at the code.",
    trackStatus: 'WAITING FOR PHONE',
  },
  pairing: {
    title: 'Phone connected',
    instruction: 'Finishing check...',
    trackStatus: 'PHONE CONNECTED',
  },
  verified: {
    title: 'Verified',
    instruction: "You're all set",
    trackStatus: 'CHECK COMPLETE',
  },
  timeout: {
    title: "Didn't connect in time",
    instruction: 'Refresh to try again',
    trackStatus: 'CONNECTION TIMED OUT',
  },
  failed: {
    title: "Couldn't verify",
    instruction: 'Try again on a trusted network',
    trackStatus: 'CHECK ENDED',
  },
};

function getPhase(connected: boolean, completion: EmbedCompletion): EmbedPhase {
  if (completion === 'paired') return 'verified';
  if (completion === 'timeout' || completion === 'failed') return completion;
  return connected ? 'pairing' : 'scanning';
}

export function getEmbedPresentation(input: {
  connected: boolean;
  completion: EmbedCompletion;
  showScanHint: boolean;
}): EmbedPresentation {
  const phase = getPhase(input.connected, input.completion);
  // eslint-disable-next-line security/detect-object-injection -- phase is a closed union key.
  const presentation = PRESENTATION[phase];

  return {
    phase,
    ...presentation,
    instruction:
      phase === 'scanning' && input.showScanHint
        ? 'Having trouble? Move your phone slightly farther away.'
        : presentation.instruction,
  };
}
