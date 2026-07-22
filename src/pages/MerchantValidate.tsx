import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  browserMerchantValidationService,
  merchantValidationRedirect,
  readMerchantValidationMaterial,
  type MerchantProofChoice,
} from '../lib/merchant-validation-flow';
import { PROVIDERS_CONFIGURED } from '../lib/oauth';
import { loadSsoFailureReturnUrl } from '../lib/sso-failure-return';
import type { SsoValidateResult } from '../lib/sso-client';
import { MerchantValidationView } from './MerchantValidationView';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MerchantValidate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [result, setResult] = useState<SsoValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsProof, setNeedsProof] = useState(false);
  const [validating, setValidating] = useState(false);
  const [passkeySeen, setPasskeySeen] = useState(false);
  const materialResult = useMemo(
    () =>
      readMerchantValidationMaterial(params, (sessionId) =>
        window.sessionStorage.getItem(`argus-demo-sso-nonce:${sessionId}`)
      ),
    [params]
  );
  const sessionId = params.get('session');
  const cpi = params.get('cpi');
  const isMerchantCallback = params.get('flow') === 'merchant';
  const approved = result?.verdict === 'approved';
  const failed = Boolean(error) || result?.verdict === 'failed';
  const returningToSite = isMerchantCallback && (approved || failed);

  useEffect(() => {
    if (!materialResult.ok) {
      queueMicrotask(() => setError(materialResult.error));
      return;
    }
    let cancelled = false;
    void (async () => {
      setValidating(true);
      try {
        const outcome = await browserMerchantValidationService.validateInitial(
          materialResult.material
        );
        if (cancelled) return;
        setPasskeySeen(outcome.passkeySeen);
        if (outcome.kind === 'validated') {
          setResult(outcome.result);
          setNeedsProof(false);
        } else {
          setNeedsProof(true);
        }
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setValidating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [materialResult]);

  useEffect(() => {
    const redirect = merchantValidationRedirect({
      sessionId,
      cpi,
      isMerchantCallback,
      result,
      error,
      failureReturnUrl: sessionId ? loadSsoFailureReturnUrl(sessionId) : null,
    });
    if (redirect?.kind === 'replace') window.location.replace(redirect.url);
    else if (redirect?.kind === 'navigate') navigate(redirect.url, { replace: true });
  }, [cpi, error, isMerchantCallback, navigate, result, sessionId]);

  async function runProof(proofChoice: MerchantProofChoice): Promise<void> {
    if (!materialResult.ok || validating) return;
    setValidating(true);
    setError(null);
    try {
      const outcome = await browserMerchantValidationService.validateProof(
        materialResult.material,
        proofChoice,
        passkeySeen
      );
      setPasskeySeen(outcome.passkeySeen);
      if (outcome.kind === 'proof-error') {
        setError(outcome.error);
        return;
      }
      setResult(outcome.result);
      setNeedsProof(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setValidating(false);
    }
  }

  return (
    <MerchantValidationView
      isMerchantCallback={isMerchantCallback}
      approved={approved}
      failed={failed}
      returningToSite={returningToSite}
      needsProof={needsProof && !result}
      validating={validating}
      passkeySeen={passkeySeen}
      resultReason={result?.reason ?? null}
      error={error}
      isGoogleConfigured={PROVIDERS_CONFIGURED.google}
      onProof={(proofChoice) => void runProof(proofChoice)}
      onReturn={() => window.history.back()}
    />
  );
}
