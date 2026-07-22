export type PhoneProofMode = 'integrity' | 'passkey' | 'passkey-create' | 'google';

interface PhonePairFailureOptions {
  proofMode: PhoneProofMode;
  keepDrawingBoard: boolean;
}

export interface PhonePairFailure {
  phase: 'ready' | 'taken' | 'error';
  errorMessage: string;
  resetTrust: boolean;
  clearStatus: boolean;
}

export function decidePhonePairFailure(
  error: unknown,
  options: PhonePairFailureOptions
): PhonePairFailure {
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (options.keepDrawingBoard) {
    return {
      phase: 'ready',
      errorMessage: 'Trusted device expired. Choose a check.',
      resetTrust: true,
      clearStatus: true,
    };
  }
  if (options.proofMode === 'passkey' || options.proofMode === 'passkey-create') {
    return {
      phase: 'ready',
      errorMessage,
      resetTrust: false,
      clearStatus: false,
    };
  }
  return {
    phase: errorMessage.includes('session_paired_with_other_device') ? 'taken' : 'error',
    errorMessage,
    resetTrust: false,
    clearStatus: false,
  };
}
