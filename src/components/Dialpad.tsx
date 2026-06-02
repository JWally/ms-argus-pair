import { useEffect, useMemo, useState } from 'react';

/**
 * Hot-pink neon dialer, full-bleed. Shown on the silent-reauth path
 * as the tactile beat between trust-token recognition and the
 * /phone-attest POST. argus.run is already running in the
 * background; the POST waits behind SEND so user-perceived time
 * collapses to max(dial, server) instead of dial + server.
 *
 * 3-digit code derived deterministically from the session nonce.
 * The target digits double as the entry display — each lights up
 * as the user taps the matching key. Wrong key shakes the row but
 * doesn't advance. Pure UI theater on the wire: server never sees
 * the code, it's there to give the user something to do.
 */
export interface DialpadProps {
  nonce: string;
  onSend(): void;
}

const CODE_LEN = 3;

function codeFromNonce(nonce: string): string {
  let hex = nonce.replace(/[^0-9a-f]/gi, '').slice(0, 14);
  if (hex.length < 14) hex = hex.padEnd(14, '0');
  const n = BigInt('0x' + hex);
  const three = Number(n % 1000n);
  return three.toString().padStart(CODE_LEN, '0');
}

interface Key {
  digit: string;
  letters: string;
}

const KEYS: Key[] = [
  { digit: '1', letters: ' ' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: ' ' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: ' ' },
];

function BackspaceIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="M21 5H9.5a2 2 0 0 0-1.5.7L2 12l6 6.3a2 2 0 0 0 1.5.7H21a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
      <line x1="18" y1="9" x2="12" y2="15" />
      <line x1="12" y1="9" x2="18" y2="15" />
    </svg>
  );
}

export function Dialpad({ nonce, onSend }: DialpadProps) {
  const target = useMemo(() => codeFromNonce(nonce), [nonce]);
  const [entered, setEntered] = useState('');
  const [shake, setShake] = useState(false);
  const complete = entered === target;

  function press(d: string) {
    if (complete) return;
    if (d === '⌫') {
      setEntered((e) => e.slice(0, -1));
      try {
        navigator.vibrate?.(4);
      } catch {
        /* noop */
      }
      return;
    }
    if (!/^[0-9]$/.test(d)) {
      // *, # are decorative — pressing them is harmless, just no-op.
      return;
    }
    const expected = target[entered.length];
    if (d !== expected) {
      setShake(true);
      window.setTimeout(() => setShake(false), 180);
      try {
        navigator.vibrate?.(8);
      } catch {
        /* noop */
      }
      return;
    }
    setEntered(entered + d);
    try {
      navigator.vibrate?.(4);
    } catch {
      /* noop */
    }
  }

  useEffect(() => {
    if (!complete) return;
    try {
      navigator.vibrate?.([18, 40, 18]);
    } catch {
      /* noop */
    }
  }, [complete]);

  return (
    <div className="dialer">
      <div className="dialer-screen">
        <div className="dialer-prompt">Enter this code</div>
        <div className="dialer-display-row">
          <span className="dialer-display-spacer" aria-hidden />
          <div className={'dialer-display' + (shake ? ' dialer-shake' : '')}>
            {Array.from(target, (d, i) => {
              const state = i < entered.length ? 'on' : i === entered.length ? 'next' : 'pending';
              return (
                <span key={i} className={`dialer-digit dialer-digit-${state}`}>
                  {d}
                </span>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => press('⌫')}
            className={
              'dialer-backspace' + (entered.length > 0 && !complete ? ' dialer-backspace-on' : '')
            }
            aria-label="Backspace"
            disabled={entered.length === 0 || complete}
          >
            <BackspaceIcon className="dialer-backspace-icon" />
          </button>
        </div>
      </div>

      <div className={'dialer-keypad' + (complete ? ' dialer-keypad-muted' : '')}>
        {KEYS.map((k) => (
          <button
            key={k.digit}
            type="button"
            className="dialer-key"
            onClick={() => press(k.digit)}
            aria-label={`Dial ${k.digit}`}
            disabled={complete}
          >
            <span className="dialer-key-digit">{k.digit}</span>
            <span className="dialer-key-letters">{k.letters}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={!complete}
        onClick={onSend}
        className={'dialer-send' + (complete ? ' dialer-send-armed' : '')}
      >
        SEND
      </button>
    </div>
  );
}
