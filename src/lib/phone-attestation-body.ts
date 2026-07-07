export interface PhoneAttestationBindings {
  desktopEnvelope: string;
  desktopArgusSessionId: string;
  desktopKeyId: string;
}

export interface PhoneAttestationRun {
  argusSessionId: string;
  attestation: unknown;
}

export interface PhoneOauthProof {
  provider: 'google' | 'github' | 'facebook';
  token: string;
}

export function buildTrustRedeemAttestationBody(
  run: PhoneAttestationRun,
  bindings: PhoneAttestationBindings,
  deviceTrustToken: string
): Record<string, unknown> {
  return {
    argusSessionId: run.argusSessionId,
    attestation: run.attestation,
    deviceTrustToken,
    desktopEnvelope: bindings.desktopEnvelope,
    desktopArgusSessionId: bindings.desktopArgusSessionId,
    desktopKeyId: bindings.desktopKeyId,
  };
}

export function buildProofAttestationBody({
  run,
  bindings,
  webauthn,
  oauth,
}: {
  run: PhoneAttestationRun;
  bindings: PhoneAttestationBindings;
  webauthn: unknown;
  oauth?: PhoneOauthProof;
}): Record<string, unknown> {
  return {
    argusSessionId: run.argusSessionId,
    attestation: run.attestation,
    webauthn,
    desktopEnvelope: bindings.desktopEnvelope,
    desktopArgusSessionId: bindings.desktopArgusSessionId,
    desktopKeyId: bindings.desktopKeyId,
    ...(oauth ? { oauth } : {}),
  };
}

export function createdCredentialIdFromProof(
  passkeyMode: 'passkey-create' | 'passkey-auth',
  webauthnSettled: PromiseSettledResult<unknown>
): string | null {
  if (
    passkeyMode !== 'passkey-create' ||
    webauthnSettled.status !== 'fulfilled' ||
    webauthnSettled.value === null ||
    typeof webauthnSettled.value !== 'object'
  ) {
    return null;
  }
  const id = (webauthnSettled.value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}
