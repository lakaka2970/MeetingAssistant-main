import type { ReactNode } from 'react';
import { useT } from '../i18n';

/**
 * The one overlay chrome every in-window panel wears: a sticky title row with
 * a close ✕ above a scrolling body. Panels used to each re-invent this
 * (section header + trailing 关闭 button); the hub, help and diagnostics now
 * share exactly the same affordance.
 */
export function OverlayShell({
  title,
  onClose,
  variant,
  children,
}: {
  title: string;
  onClose: () => void;
  /** extra class for panel-specific styling (help-panel, settings-hub, …) */
  variant?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={`settings overlay-shell${variant ? ` ${variant}` : ''}`}>
      <header className="overlay-head">
        <span className="overlay-title">{title}</span>
        <button
          className="btn btn-icon"
          onClick={onClose}
          title={t.settings.closeTitle}
          aria-label={t.settings.closeTitle}
        >
          ✕
        </button>
      </header>
      {children}
    </div>
  );
}
