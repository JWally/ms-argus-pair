import {
  decodeVerdictRevealKey,
  openFixedVerdictEnvelope,
  type SealedVerdictEnvelope,
} from './verdict-envelope';

const VERDICT_HOLD_CAP_MS = 90_000;

export interface DesktopVerdict {
  verdict: string;
  reason: string | null;
  annotations?: Record<string, unknown>;
}

export interface DesktopVerdictGate {
  result: Promise<DesktopVerdict>;
  settle: (verdict: DesktopVerdict) => void;
  fail: (error: unknown) => void;
  notePhoneChallenge: (isInChallenge: boolean) => void;
  releaseHeldVerdict: () => void;
  receiveSealedVerdict: (envelope: SealedVerdictEnvelope) => Promise<void>;
  receiveRevealKey: (revealKey: string) => Promise<void>;
  isSettled: () => boolean;
  hasHeldVerdict: () => boolean;
}

interface VerdictGateDependencies {
  openEnvelope: typeof openFixedVerdictEnvelope;
  decodeRevealKey: typeof decodeVerdictRevealKey;
  setHoldTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearHoldTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultDependencies: VerdictGateDependencies = {
  openEnvelope: openFixedVerdictEnvelope,
  decodeRevealKey: decodeVerdictRevealKey,
  setHoldTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearHoldTimeout: (timer) => globalThis.clearTimeout(timer),
};

class StatefulDesktopVerdictGate implements DesktopVerdictGate {
  readonly result: Promise<DesktopVerdict>;

  private resolveResult!: (verdict: DesktopVerdict) => void;
  private rejectResult!: (error: unknown) => void;
  private settled = false;
  private phoneInChallenge = false;
  private phoneDone = false;
  private heldVerdict: DesktopVerdict | null = null;
  private holdCapTimer: ReturnType<typeof setTimeout> | null = null;
  private sealedVerdict: SealedVerdictEnvelope | null = null;
  private verdictRevealKey: string | null = null;
  private isOpeningSealedVerdict = false;

  constructor(
    private readonly sessionId: string,
    private readonly dependencies: VerdictGateDependencies
  ) {
    this.result = new Promise<DesktopVerdict>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  isSettled = (): boolean => this.settled;

  hasHeldVerdict = (): boolean => this.heldVerdict !== null;

  notePhoneChallenge = (isInChallenge: boolean): void => {
    if (isInChallenge) this.phoneInChallenge = true;
  };

  settle = (verdict: DesktopVerdict): void => {
    if (this.settled) return;
    if (this.phoneInChallenge && !this.phoneDone) {
      if (!this.heldVerdict) {
        this.heldVerdict = verdict;
        this.holdCapTimer = this.dependencies.setHoldTimeout(
          this.releaseHeldVerdict,
          VERDICT_HOLD_CAP_MS
        );
      }
      return;
    }
    this.settled = true;
    this.resolveResult(verdict);
  };

  fail = (error: unknown): void => {
    if (this.settled) return;
    this.settled = true;
    this.clearHoldCap();
    this.rejectResult(error);
  };

  releaseHeldVerdict = (): void => {
    this.phoneDone = true;
    this.clearHoldCap();
    if (!this.heldVerdict) return;
    const verdict = this.heldVerdict;
    this.heldVerdict = null;
    this.settle(verdict);
  };

  receiveSealedVerdict = async (envelope: SealedVerdictEnvelope): Promise<void> => {
    this.sealedVerdict = envelope;
    await this.openSealedVerdictIfReady();
  };

  receiveRevealKey = async (revealKey: string): Promise<void> => {
    this.verdictRevealKey = revealKey;
    await this.openSealedVerdictIfReady();
  };

  private clearHoldCap(): void {
    if (this.holdCapTimer === null) return;
    this.dependencies.clearHoldTimeout(this.holdCapTimer);
    this.holdCapTimer = null;
  }

  private async openSealedVerdictIfReady(): Promise<void> {
    if (
      this.settled ||
      this.isOpeningSealedVerdict ||
      !this.sealedVerdict ||
      !this.verdictRevealKey
    ) {
      return;
    }
    this.isOpeningSealedVerdict = true;
    try {
      const payload = await this.dependencies.openEnvelope(
        this.dependencies.decodeRevealKey(this.verdictRevealKey),
        this.sessionId,
        this.sealedVerdict
      );
      if (payload.kind !== 'desktop-verdict') throw new Error('unexpected verdict payload kind');
      this.settle({
        verdict: payload.verdict,
        reason: payload.reason,
        annotations: payload.annotations,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.isOpeningSealedVerdict = false;
    }
  }
}

export function createDesktopVerdictGate(sessionId: string): DesktopVerdictGate {
  return new StatefulDesktopVerdictGate(sessionId, defaultDependencies);
}
