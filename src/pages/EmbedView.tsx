import { forwardRef } from 'react';
import { EmbedSeal, EyeMark, MonitorIcon, PhoneIcon } from '../components/EmbedIcons';
import type { EmbedPresentation } from '../lib/embed-presentation';

export interface EmbedViewProps {
  compact: boolean;
  qrReady: boolean;
  qrImageUrl: string | null;
  connected: boolean;
  presentation: EmbedPresentation;
}

export const EmbedView = forwardRef<HTMLDivElement, EmbedViewProps>(
  function EmbedView(props, moduleRef) {
    const { phase, title, instruction, trackStatus } = props.presentation;
    return (
      <div className="aegis-stage">
        <div className={`aegis ${phase}${props.compact ? ' compact' : ''}`} ref={moduleRef}>
          <div className="ax-bar">
            <div className="ax-brand">
              <EyeMark />
              <span className="ax-name">ARGUS</span>
            </div>
            <div className="ax-stat">
              <span className="ax-dot" />
            </div>
          </div>

          <div className="ax-scan">
            <div className="ax-tile">
              {/* Crisp pixels: the poison must reach the screen sharp; the phone's
                lens supplies the blur that recovers the true code. */}
              {props.qrImageUrl && (
                <img
                  alt=""
                  src={props.qrImageUrl}
                  style={{ imageRendering: 'pixelated', display: props.qrReady ? 'block' : 'none' }}
                />
              )}
              {!props.qrReady && <span className="ax-tile-load" />}
            </div>
            <div className="ax-seal">
              <EmbedSeal phase={phase} />
            </div>
            <span className="ax-tick tl" />
            <span className="ax-tick tr" />
            <span className="ax-tick bl" />
            <span className="ax-tick br" />
          </div>

          <p className="ax-label" aria-live="polite">
            {title}
            <span className="ax-sub">{instruction}</span>
          </p>

          <div className="ax-link">
            <div className="ax-node here">
              <span className="ax-chip">
                <MonitorIcon />
              </span>
              <span className="ax-tag">this device</span>
            </div>
            <div className="ax-track">
              <span className="ax-track-label" aria-hidden="true">
                {trackStatus}
              </span>
              <span className="ax-rail" />
              <span className="ax-live" />
              <span className="ax-pulse" />
            </div>
            <div className={`ax-node ${props.connected ? 'here' : ''}`}>
              <span className="ax-chip">
                <PhoneIcon />
              </span>
              <span className="ax-tag">your phone</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
