import { Link } from 'react-router-dom';
import { MerchantWordmark } from '../components/Brand';
import { IconCheck, IconShield, IconX } from '../components/Icons';
import { SsoStatusShell } from '../components/SsoStatusShell';
import type { MerchantProofChoice } from '../lib/merchant-validation-flow';

export interface MerchantValidationViewProps {
  isMerchantCallback: boolean;
  approved: boolean;
  failed: boolean;
  returningToSite: boolean;
  needsProof: boolean;
  validating: boolean;
  passkeySeen: boolean;
  resultReason: string | null;
  error: string | null;
  isGoogleConfigured: boolean;
  onProof: (proofChoice: MerchantProofChoice) => void;
  onReturn: () => void;
}

interface ProofActionsProps {
  className: string;
  isVisible: boolean;
  isBusy: boolean;
  passkeySeen: boolean;
  isGoogleConfigured: boolean;
  onProof: (proofChoice: MerchantProofChoice) => void;
}
function ProofActions(props: ProofActionsProps) {
  if (!props.isVisible) return null;
  const primaryProof = props.passkeySeen ? 'passkey-auth' : 'passkey-create';
  return (
    <div className={props.className}>
      <button
        type="button"
        className="merchant-primary"
        onClick={props.onProof.bind(undefined, primaryProof)}
        disabled={props.isBusy}
      >
        {props.passkeySeen ? 'Use passkey' : 'Create passkey'}
      </button>
      {props.passkeySeen && (
        <button
          type="button"
          className="merchant-secondary"
          onClick={props.onProof.bind(undefined, 'passkey-create')}
          disabled={props.isBusy}
        >
          Create passkey
        </button>
      )}
      {props.isGoogleConfigured && (
        <button
          type="button"
          className="merchant-secondary"
          onClick={props.onProof.bind(undefined, 'google')}
          disabled={props.isBusy}
        >
          Continue with Google
        </button>
      )}
    </div>
  );
}

function callbackCopy(props: MerchantValidationViewProps): { status: string; detail: string } {
  if (props.returningToSite) {
    return { status: 'Returning securely', detail: 'Finishing the secure handoff.' };
  }
  if (props.needsProof) {
    return {
      status: 'Confirm your identity',
      detail: props.error
        ? 'That verification did not complete. Try another option.'
        : 'Choose a verification method to continue.',
    };
  }
  return {
    status: props.error ? 'Automatic return unavailable' : 'Completing secure check',
    detail: props.error
      ? 'Use the button below to continue back.'
      : 'This usually takes only a moment.',
  };
}

function CallbackValidationView(props: MerchantValidationViewProps) {
  const copy = callbackCopy(props);
  return (
    <SsoStatusShell
      step={3}
      status={copy.status}
      detail={copy.detail}
      isBusy={props.validating || props.returningToSite}
      action={
        props.error && !props.needsProof && !props.returningToSite
          ? { label: 'RETURN', onClick: props.onReturn }
          : undefined
      }
    >
      <ProofActions
        className="sso-proof-actions"
        isVisible={props.needsProof}
        isBusy={props.validating}
        passkeySeen={props.passkeySeen}
        isGoogleConfigured={props.isGoogleConfigured}
        onProof={props.onProof}
      />
    </SsoStatusShell>
  );
}

function resultTitle(props: MerchantValidationViewProps): string {
  if (props.approved) return 'Returning securely';
  if (props.failed) return 'Session could not be confirmed';
  if (props.needsProof) return 'Confirm your identity';
  return 'Validating session';
}

function resultDetail(props: MerchantValidationViewProps): string {
  if (props.approved) return 'redeeming approval';
  if (props.needsProof) return 'proof required';
  return props.resultReason?.replace(/_/g, ' ') ?? props.error ?? 'checking return';
}

function ValidationResultCard(props: MerchantValidationViewProps) {
  return (
    <section className="merchant-card merchant-result" aria-live="polite">
      <span
        className={`merchant-result-icon ${props.approved ? 'is-approved' : props.failed ? 'is-failed' : ''}`}
      >
        {props.approved ? (
          <IconCheck className="h-7 w-7" />
        ) : props.failed ? (
          <IconX className="h-7 w-7" />
        ) : (
          <IconShield className="h-7 w-7" />
        )}
      </span>
      <p className="merchant-eyebrow">Site response</p>
      <h1>{resultTitle(props)}</h1>
      <p className={props.approved ? 'merchant-approved' : 'merchant-copy'}>
        {resultDetail(props)}
      </p>
      {props.validating && <span className="spinner merchant-spinner" />}
    </section>
  );
}

function DemoValidationView(props: MerchantValidationViewProps) {
  return (
    <div className="merchant-page">
      <div className="merchant-layout merchant-layout-narrow">
        <header className="merchant-header">
          <MerchantWordmark />
          <span className="merchant-secured">
            <IconShield className="h-4 w-4" /> Returned from Argus
          </span>
        </header>
        <main className="merchant-main">
          <ValidationResultCard {...props} />
          {props.needsProof && (
            <section className="merchant-proof">
              <p className="merchant-eyebrow">Proof required</p>
              <ProofActions
                className="merchant-proof-actions"
                isVisible
                isBusy={props.validating}
                passkeySeen={props.passkeySeen}
                isGoogleConfigured={props.isGoogleConfigured}
                onProof={props.onProof}
              />
            </section>
          )}
          {props.failed && (
            <Link className="merchant-done" to="/merchant">
              BACK
            </Link>
          )}
        </main>
      </div>
    </div>
  );
}

export function MerchantValidationView(props: MerchantValidationViewProps) {
  return props.isMerchantCallback ? (
    <CallbackValidationView {...props} />
  ) : (
    <DemoValidationView {...props} />
  );
}
