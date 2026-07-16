import type { ReactNode } from 'react';
import { Wordmark } from './Brand';

const SSO_STAGES = [1, 2, 3] as const;

interface SsoStatusShellProps {
  step: (typeof SSO_STAGES)[number];
  status: string;
  detail: string;
  isBusy?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
  children?: ReactNode;
}

export function SsoStatusShell({
  step,
  status,
  detail,
  isBusy = false,
  action,
  children,
}: SsoStatusShellProps) {
  const countdown = 4 - step;

  return (
    <div className="argus-page">
      <div className="argus-layout">
        <header className="argus-header">
          <Wordmark />
          <span className="pill">Secure check</span>
        </header>
        <main className="argus-main">
          <section className="sso-shell sso-status-shell text-center" aria-live="polite">
            <div className="sso-stage-counter" aria-label={`Step ${step} of 3`}>
              <span className="sso-stage-value" key={step}>
                {countdown}
              </span>
            </div>
            <ol className="sso-progress" aria-hidden="true">
              {SSO_STAGES.map((stage) => (
                <li
                  className={`sso-progress-step ${
                    stage < step ? 'is-complete' : stage === step ? 'is-current' : ''
                  }`}
                  key={stage}
                >
                  <span />
                </li>
              ))}
            </ol>
            <div className="label">Argus</div>
            <h1 className="mt-2 text-2xl font-semibold">Secure session check</h1>
            <div className="sso-status-line">
              {isBusy && <span className="spinner" />}
              <span>{status}</span>
            </div>
            <p className="sso-status-detail">{detail}</p>
            {children}
            {action && (
              <button
                className="merchant-done sso-return-action"
                type="button"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
