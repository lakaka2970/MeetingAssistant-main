/**
 * The dual-screen connect window's page: QR big enough to scan, the address
 * copyable, the pairing code, live device status, and the few switches that
 * matter while you are setting this up.
 *
 * Everything here is derived from CompanionState polled from main. The renderer
 * never guesses a port or an address: when the configured port was taken the
 * bridge falls back to the next one, and a QR built from the configured value
 * would point the phone at nothing while still looking perfectly plausible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompanionState, PublicSettings } from '../../shared/protocol';
import { STRINGS, type Lang } from './i18n';
import './connect.css';

const POLL_MS = 1000;

export function ConnectApp() {
  const [state, setState] = useState<CompanionState | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [svg, setSvg] = useState('');
  const [copied, setCopied] = useState(false);
  const [shotBusy, setShotBusy] = useState(false);
  const t = STRINGS[(settings?.ui.lang ?? 'zh') as Lang];

  useEffect(() => {
    void window.mcConnect.getSettings().then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    let dead = false;
    const tick = async (): Promise<void> => {
      try {
        const s = await window.mcConnect.state();
        if (!dead) setState(s);
      } catch {
        /* main not answering yet */
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), POLL_MS);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, []);

  // The QR only changes with the address, not with every poll tick.
  const url = state?.url ?? '';
  useEffect(() => {
    if (!url) {
      setSvg('');
      return;
    }
    let dead = false;
    void window.mcConnect
      .qr()
      .then((s) => {
        if (!dead) setSvg(s);
      })
      .catch(() => {
        if (!dead) setSvg('');
      });
    return () => {
      dead = true;
    };
  }, [url]);

  const patch = useCallback((p: Parameters<typeof window.mcConnect.patch>[0]) => {
    // Re-read settings after the write, not just state: every checkbox here is
    // bound to settings.companion, so without this a toggle would snap straight
    // back to its old value and look broken.
    void window.mcConnect
      .patch(p)
      .then(async (s) => {
        setState(s);
        setSettings(await window.mcConnect.getSettings());
      })
      .catch(() => {});
  }, []);

  const enabled = !!settings?.companion.enabled;
  const c = settings?.companion;

  const secondsLeft = useMemo(() => {
    if (!state?.pairingCode || !state.pairingExpiresAt) return 0;
    return Math.max(0, Math.round((state.pairingExpiresAt - Date.now()) / 1000));
  }, [state?.pairingCode, state?.pairingExpiresAt, state]);

  const copy = async (): Promise<void> => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // file:// is not a secure context, so the async clipboard can be denied;
      // the classic path still works in Electron
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing better available */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const online = state?.devices.filter((d) => d.online) ?? [];
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div className="conn" ref={ref}>
      <header className="conn-head">
        <div>
          <div className="conn-title">{t.title}</div>
          <div className="conn-sub">{t.sub}</div>
        </div>
        {/* The way out lives in the header, not at the bottom of a scroll pane:
            if leaving the mode needs a scroll you have to discover, the window
            that exists to be glanced at becomes a trap. */}
        {enabled && (
          <button className="conn-leave" onClick={() => patch({ enabled: false })}>
            {t.disable}
          </button>
        )}
        <button className="conn-x" onClick={() => window.mcConnect.hide()} title="✕">
          ✕
        </button>
      </header>

      {!state?.running ? (
        <div className="conn-idle">
          <div className="conn-badge bad">{t.notRunning}</div>
          {state?.error && <div className="conn-warn">{state.error}</div>}
          <button className="conn-primary" onClick={() => patch({ enabled: true })}>
            {t.enable}
          </button>
        </div>
      ) : (
        <>
          <div className="conn-qr">
            {svg ? (
              <span className="conn-svg" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              <div className="conn-qr-empty" />
            )}
          </div>
          <div className="conn-scan">{t.scan}</div>
          <div className="conn-addr-row">
            <span className="conn-or">{t.orAddress}</span>
            <code className="conn-addr">{url}</code>
            <button className="conn-mini" onClick={() => void copy()}>
              {copied ? t.copied : t.copy}
            </button>
          </div>

          <div className="conn-status">
            <span className={online.length ? 'conn-dot ok' : 'conn-dot'} />
            {online.length ? (
              online.map((d) => (
                <span key={d.name} className="conn-chip ok">
                  {d.name}
                </span>
              ))
            ) : (
              <span className="conn-chip">{t.noDevices}</span>
            )}
            {state.lagMs >= 0 && (
              <span className="conn-chip dim">
                {t.lag} {state.lagMs}ms
              </span>
            )}
            <span className="conn-chip dim">
              {t.sent} {state.sentEvents}
            </span>
            {state.droppedEvents > 0 && (
              <span className="conn-chip warn" title={t.droppedHint}>
                {t.dropped} {state.droppedEvents}
              </span>
            )}
          </div>
          {!state.https && <div className="conn-warn">{t.warnHttp}</div>}
          {!url && <div className="conn-warn">{t.warnNoLan}</div>}
        </>
      )}

      {state?.running && (
        <section className="conn-sec">
          <div className="conn-sec-t">{t.pairTitle}</div>
          {state.pairingCode && secondsLeft > 0 ? (
            <>
              <div className="conn-code">{state.pairingCode}</div>
              <div className="conn-hint">
                {t.pairStep1} → {t.pairStep2} · {t.codeExpires.replace('%s', String(secondsLeft))}
              </div>
            </>
          ) : (
            <div className="conn-hint">{t.pairStep1}</div>
          )}
          <button className="conn-mini" onClick={() => void window.mcConnect.pair().then(setState)}>
            {t.newCode}
          </button>
          <div className="conn-note">{t.pairNote}</div>
          <div className="conn-note">{t.notFound}</div>
        </section>
      )}

      {c && (
        <section className="conn-sec">
          <div className="conn-sec-t">{t.pushTitle}</div>
          <div className="conn-checks">
            <label>
              <input
                type="checkbox"
                checked={c.pushTranscript}
                onChange={(e) => patch({ pushTranscript: e.target.checked })}
              />{' '}
              {t.pushTranscript}
            </label>
            <label>
              <input
                type="checkbox"
                checked={c.pushExam || c.pushInterview}
                onChange={(e) => patch({ pushExam: e.target.checked, pushInterview: e.target.checked })}
              />{' '}
              {t.pushAnswers}
            </label>
            <label>
              <input
                type="checkbox"
                checked={c.pushScreenshot}
                onChange={(e) => patch({ pushScreenshot: e.target.checked })}
              />{' '}
              {t.pushShot}
            </label>
          </div>
          <label className="conn-checks">
            <input
              type="checkbox"
              checked={c.hotkeyToPhone}
              onChange={(e) => patch({ hotkeyToPhone: e.target.checked })}
            />{' '}
            {t.phoneOnly}
            <span className="conn-note"> {t.phoneOnlyHint}</span>
          </label>
        </section>
      )}

      {settings && (
        <section className="conn-sec">
          <div className="conn-sec-t">{t.hotkeysTitle}</div>
          <ul className="conn-keys">
            <li>
              <kbd>{settings.ui.hotkeyShot}</kbd> {t.hotkeyShot}
            </li>
            <li>
              <kbd>{settings.exam?.hotkeyAsk}</kbd> {t.hotkeyAsk}
            </li>
            <li>
              <kbd>{settings.ui.hotkeyAnswer}</kbd> {t.hotkeyAnswer}
            </li>
            <li>
              <kbd>{settings.ui.hotkeyToggle}</kbd> {t.hotkeyToggle}
            </li>
          </ul>
        </section>
      )}

      <footer className="conn-foot">
        {state?.running && (
          <>
            <button
              className="conn-mini"
              disabled={shotBusy}
              onClick={() => {
                setShotBusy(true);
                void window.mcConnect
                  .shot()
                  .catch(() => {})
                  .finally(() => setTimeout(() => setShotBusy(false), 400));
              }}
            >
              {t.shotNow}
            </button>
            <button className="conn-mini" onClick={() => void window.mcConnect.apply().then(setState)}>
              {t.rebinding}
            </button>
          </>
        )}
        {state?.running && (
          /* A self-signed cert still stops the phone at a warning screen, and
             some Android browsers offer no way past it. Without this escape the
             whole feature is unreachable on those devices, so HTTP has to be
             one tap away — with its cost (no wake lock) stated, not hidden. */
          <button
            className="conn-mini"
            title={t.useHttpHint}
            onClick={() => patch({ useHttps: !state.https })}
          >
            {state.https ? t.useHttp : t.useHttps}
          </button>
        )}
      </footer>
    </div>
  );
}
