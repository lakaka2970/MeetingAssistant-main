import { useT } from '../i18n';
import type { UpdaterView } from '../../shared/protocol';
import { DOCS } from '../../shared/docsLinks';

/**
 * Reasons this module produces itself (as codes, not prose) mapped to the
 * dictionary. Anything else is the library's own English message and is shown
 * verbatim — translating it would mean guessing at text we do not own.
 */
const REASON_CODE = new Set(['no-version', 'cancelled', 'handover-failed']);

/**
 * The overlay's install strip (v1.0.4).
 *
 * It renders only what this machine can actually do: `UpdaterView.allowed`
 * comes from main's gate, so a portable exe or a dev run shows nothing here at
 * all — the reason lives in Settings, next to the switch that turned it on.
 * An idle, checking or up-to-date run shows nothing either; a strip that
 * appears for "no news" would train the user to ignore it.
 *
 * The confirmation is in-window rather than a native dialog for the same
 * reason the overlay is content-protected: a system dialog is a window this
 * app does not control, and it would show up in a screen share.
 */
export function UpdateBanner({
  view,
  confirming,
  onAskConfirm,
  onCancelConfirm,
  onDownload,
  onInstall,
  onCheck,
  onCancel,
}: {
  view: UpdaterView;
  /** the confirm panel is open (raised by the banner button or by the tray) */
  confirming: boolean;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  onDownload: () => void;
  onInstall: () => void;
  /** re-ask the manifest: the retry a failure with no version needs */
  onCheck: () => void;
  /** abandon an in-flight download */
  onCancel: () => void;
}) {
  const t = useT();
  if (!view.allowed) return null;
  const s = view.state;

  if (s.kind === 'available') {
    return (
      <div className="update-banner">
        <span className="update-text">{t.updater.available(s.version)}</span>
        <button className="btn btn-primary btn-sm" onClick={onDownload}>
          {t.updater.download}
        </button>
      </div>
    );
  }

  if (s.kind === 'downloading') {
    return (
      <div className="update-banner">
        <span className="update-text">{t.updater.downloading(s.version, s.percent)}</span>
        <span className="update-track" aria-hidden>
          <span className="update-fill" style={{ width: `${s.percent}%` }} />
        </span>
        <button className="btn btn-sm" onClick={onCancel}>
          {t.updater.cancel}
        </button>
      </div>
    );
  }

  if (s.kind === 'ready') {
    if (!confirming) {
      return (
        <div className="update-banner">
          <span className="update-text">{t.updater.ready(s.version)}</span>
          <button className="btn btn-primary btn-sm" onClick={onAskConfirm}>
            {t.updater.installNow}
          </button>
        </div>
      );
    }
    return (
      <div className="update-banner update-confirm" role="alertdialog" aria-label={t.updater.confirmTitle(s.version)}>
        <div className="update-title">{t.updater.confirmTitle(s.version)}</div>
        <div className="update-body">{t.updater.confirmBody}</div>
        <div className="update-actions">
          <button className="btn btn-primary btn-sm" onClick={onInstall}>
            {t.updater.confirmOk}
          </button>
          <button className="btn btn-sm" onClick={onCancelConfirm}>
            {t.updater.confirmCancel}
          </button>
        </div>
      </div>
    );
  }

  if (s.kind === 'installing') {
    return (
      <div className="update-banner">
        <span className="update-text">{t.updater.starting}</span>
      </div>
    );
  }

  if (s.kind === 'failed') {
    // A failure that never learned a version cannot be retried as a download —
    // that was a dead end, and it is the exact state a machine gets into when
    // the published release carries no install manifest. So the retry is chosen
    // by what the state knows, and the manual page is always offered next to it.
    const reason = REASON_CODE.has(s.reason) ? t.updater[s.reason as 'no-version'] : s.reason;
    return (
      <div className="update-banner update-failed">
        <span className="update-text">{t.updater.failed(reason)}</span>
        <button className="btn btn-sm" onClick={s.version ? onDownload : onCheck}>
          {t.updater.retry}
        </button>
        <button className="btn btn-sm" onClick={() => void window.mc.openExternal(DOCS.releases)}>
          {t.updater.openPage}
        </button>
      </div>
    );
  }

  return null;
}
