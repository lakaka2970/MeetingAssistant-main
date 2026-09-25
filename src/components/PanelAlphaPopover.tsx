import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { PANEL_ALPHA_MAX, PANEL_ALPHA_MIN } from '../../shared/protocol';

/**
 * ◐ 面板透明度 popover — the mid-meeting path for fading this overlay back
 * into the screen behind it. Dragging writes `--panel-alpha` straight to the
 * document root so the fade tracks the pointer without a settings round-trip
 * per frame, and the release commits one persisted patch (same rule as the
 * rail divider's drag). Only the backdrop fades; text stays crisp.
 */
export function PanelAlphaPopover({
  alpha,
  onLive,
  onCommit,
}: {
  alpha: number;
  onLive: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const s = useT().panelAlpha;
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState(Math.round(alpha * 100));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setPct(Math.round(alpha * 100)), [alpha]);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const commit = (): void => onCommit(pct / 100);

  return (
    <div className="tb-menu-wrap" ref={ref}>
      <button
        className={`btn btn-icon${open ? ' btn-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={s.buttonTitle}
        aria-label={s.buttonTitle}
      >
        ◐
      </button>
      {open && (
        <div className="style-pop" role="menu">
          <div className="style-pop-row">
            <span className="style-pop-label">{s.label}</span>
            <span className="alpha-row">
              <input
                className="alpha-range"
                type="range"
                min={PANEL_ALPHA_MIN * 100}
                max={PANEL_ALPHA_MAX * 100}
                step={1}
                value={pct}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setPct(next);
                  onLive(next / 100);
                }}
                onPointerUp={commit}
                onKeyUp={commit}
              />
              <span className="alpha-value">{pct}%</span>
            </span>
          </div>
          <div className="style-pop-hint">{s.hint}</div>
        </div>
      )}
    </div>
  );
}
