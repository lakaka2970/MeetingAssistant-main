import type { FontScale, ThemeMode, UiLang } from '../../../shared/protocol';
import type { SettingsDraft } from './useSettingsDraft';

/** everything that is not a model: appearance, hotkeys, audio, companion, help */
export function GeneralTab({
  d,
  onRerunWizard,
  onOpenDiagnostics,
  onOpenHelp,
  onOpenPersonas,
  onOpenPrompt,
}: {
  d: SettingsDraft;
  onRerunWizard?: () => void;
  onOpenDiagnostics?: () => void;
  onOpenHelp?: () => void;
  /** v1.0.1 A5 entries into the prompt lab, rendered by SettingsPanel */
  onOpenPersonas?: () => void;
  onOpenPrompt?: () => void;
}) {
  const t = d.t;
  const deviceOptions = (
    <>
      <option value="">{t.settings.deviceDefault}</option>
      {d.devices.map((dev) => (
        <option key={dev.deviceId} value={dev.deviceId}>
          {dev.label || dev.deviceId}
        </option>
      ))}
    </>
  );
  return (
    <>
      <div className="settings-row">
        <label>{t.settings.uiLang}</label>
        <select value={d.uiLang} onChange={(e) => d.setUiLang(e.target.value as UiLang)}>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <div className="settings-row">
        <label>{t.settings.theme}</label>
        <select value={d.theme} onChange={(e) => d.setTheme(e.target.value as ThemeMode)}>
          <option value="dark">{t.settings.themeDark}</option>
          <option value="light">{t.settings.themeLight}</option>
          <option value="system">{t.settings.themeSystem}</option>
        </select>
      </div>
      <div className="settings-row">
        <label>{t.settings.fontScaleLabel}</label>
        <select value={d.fontScale} onChange={(e) => d.setFontScale(e.target.value as FontScale)}>
          <option value="small">{t.settings.fontSmall}</option>
          <option value="medium">{t.settings.fontMedium}</option>
          <option value="large">{t.settings.fontLarge}</option>
        </select>
      </div>

      <div className="settings-row">
        <label>{t.settings.hotkeyToggle}</label>
        <input value={d.hotkey} onChange={(e) => d.setHotkey(e.target.value)} spellCheck={false} />
      </div>
      <div className="settings-row">
        <label>{t.settings.hotkeyShot}</label>
        <input
          value={d.hotkeyShot}
          onChange={(e) => d.setHotkeyShot(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="settings-row">
        <label>{t.settings.hotkeyAnswer}</label>
        <input
          value={d.hotkeyAnswer}
          onChange={(e) => d.setHotkeyAnswer(e.target.value)}
          spellCheck={false}
        />
      </div>
      {d.hotkeyError && (
        <div className="settings-warn">{t.settings.hotkeyInvalid(d.hotkeyError)}</div>
      )}

      <div className="settings-section">{t.settings.examSection}</div>
      <div className="settings-hint">{t.settings.examHint}</div>
      <div className="settings-row">
        <label>{t.settings.hotkeyExamOpen}</label>
        <input
          value={d.examHotkeyOpen}
          onChange={(e) => d.setExamHotkeyOpen(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="settings-row">
        <label>{t.settings.hotkeyExamAsk}</label>
        <input
          value={d.examHotkeyAsk}
          onChange={(e) => d.setExamHotkeyAsk(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={d.examPreferOcr}
            onChange={(e) => d.setExamPreferOcr(e.target.checked)}
          />{' '}
          {t.settings.examPreferOcr}
        </label>
        <span className="settings-inline-hint">{t.settings.examPreferOcrHint}</span>
      </div>
      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={d.examWebFallback}
            onChange={(e) => d.setExamWebFallback(e.target.checked)}
          />{' '}
          {t.settings.examWebFallback}
        </label>
      </div>

      <div className="settings-row">
        <label>{t.settings.autoLaunch}</label>
        <select
          value={d.autoLaunch ? 'on' : 'off'}
          onChange={(e) => d.setAutoLaunch(e.target.value === 'on')}
        >
          <option value="off">{t.settings.autoLaunchOff}</option>
          <option value="on">{t.settings.autoLaunchOn}</option>
        </select>
        <span className="settings-inline-hint">{t.settings.autoLaunchHint}</span>
      </div>

      <div className="settings-section">{t.settings.audioSection}</div>
      {window.mc.platform === 'win32' && (
        <div className="settings-row">
          <label>{t.settings.captureBackendLabel}</label>
          <select
            value={d.captureBackend}
            onChange={(e) => d.setCaptureBackend(e.target.value as 'webaudio' | 'native')}
          >
            <option value="webaudio">{t.settings.captureWebAudio}</option>
            <option value="native">{t.settings.captureNative}</option>
          </select>
          <span className="settings-inline-hint">{t.settings.captureBackendHint}</span>
        </div>
      )}
      <div className="settings-row">
        <label>{t.settings.themDevice}</label>
        <select value={d.themDeviceId} onChange={(e) => d.setThemDeviceId(e.target.value)}>
          {deviceOptions}
        </select>
      </div>
      <div className="settings-row">
        <label>{t.settings.micDevice}</label>
        <select value={d.micDeviceId} onChange={(e) => d.setMicDeviceId(e.target.value)}>
          {deviceOptions}
        </select>
        <span className="settings-inline-hint">{t.settings.deviceNote}</span>
      </div>

      <div className="settings-section">{t.settings.companionSection}</div>
      <div className="settings-hint">{t.settings.companionHint}</div>
      <div className="settings-row">
        <label>
          <input type="checkbox" checked={d.cOn} onChange={(e) => d.setCOn(e.target.checked)} />{' '}
          {t.settings.companionEnable}
        </label>
      </div>
      {d.cOn && (
        <>
          <div className="settings-row">
            <label>
              <input
                type="checkbox"
                checked={d.cHttps}
                onChange={(e) => d.setCHttps(e.target.checked)}
              />{' '}
              {t.settings.companionHttps}
            </label>
            <span className="settings-inline-hint">{t.settings.companionHttpsHint}</span>
          </div>
          <div className="settings-row">
            <label>
              <input
                type="checkbox"
                checked={d.cTranscript}
                onChange={(e) => d.setCTranscript(e.target.checked)}
              />{' '}
              {t.settings.companionPushTranscript}
            </label>
            <label>
              <input
                type="checkbox"
                checked={d.cAnswers}
                onChange={(e) => d.setCAnswers(e.target.checked)}
              />{' '}
              {t.settings.companionPushAnswers}
            </label>
            <label>
              <input
                type="checkbox"
                checked={d.cShot}
                onChange={(e) => d.setCShot(e.target.checked)}
              />{' '}
              {t.settings.companionPushShot}
            </label>
            <span className="settings-inline-hint">{t.settings.companionPush}</span>
          </div>
          <div className="settings-row">
            <label>
              <input
                type="checkbox"
                checked={d.cPhoneOnly}
                onChange={(e) => d.setCPhoneOnly(e.target.checked)}
              />{' '}
              {t.settings.companionPhoneOnly}
            </label>
            <span className="settings-inline-hint">{t.settings.companionPhoneOnlyHint}</span>
          </div>
          {d.cState && !d.cState.running && (
            <div className="settings-warn">
              {t.settings.companionNotRunning}
              {d.cState.error ? ` — ${d.cState.error}` : ''}
            </div>
          )}
          {/* The address, QR, pairing code and device list deliberately do NOT
              live here. This panel is a scroll pane at the end of the app, and
              the one thing you must do with that information is point a phone
              camera at it — so it got its own window, raised by the 双屏 switch
              in the title bar. A row here only has to get you there. */}
          <div className="settings-row">
            <button className="btn btn-sm" onClick={() => void window.mc.openConnect()}>
              {t.settings.companionOpen}
            </button>
            <span className="settings-inline-hint">
              {d.cState?.running
                ? `${d.cState.url} · ${t.settings.companionDevices} ${
                    d.cState.devices.filter((x) => x.online).length
                  }/${d.cState.devices.length}`
                : t.settings.companionOpenHint}
            </span>
          </div>
          <div className="settings-row">
            <label>{t.settings.companionPort}</label>
            <input
              type="number"
              min={1}
              max={65535}
              style={{ width: 90 }}
              value={d.cPort}
              onChange={(e) => d.setCPort(e.target.value)}
            />
            <span className="settings-inline-hint">{t.settings.companionPortHint}</span>
          </div>
        </>
      )}

      <div className="settings-section">{t.settings.advancedSection}</div>
      <div className="settings-hint">{t.settings.advancedHint}</div>
      {onOpenPersonas && (
        <div className="settings-row">
          <button className="btn" onClick={onOpenPersonas}>
            {t.promptLab.personaEntry}
          </button>
          <span className="settings-inline-hint">{t.promptLab.personaEntryHint}</span>
        </div>
      )}
      {onOpenPrompt && (
        <div className="settings-row">
          <button className="btn" onClick={onOpenPrompt}>
            {t.promptLab.promptEntry}
          </button>
          <span className="settings-inline-hint">{t.promptLab.promptEntryHint}</span>
        </div>
      )}
      {onOpenDiagnostics && (
        <div className="settings-row">
          <button className="btn" onClick={onOpenDiagnostics}>
            {t.diagnostics.title}
          </button>
          <span className="settings-inline-hint">{t.diagnostics.intro}</span>
        </div>
      )}

      <div className="settings-hint">{t.settings.otherHint}</div>
      {onOpenHelp && (
        <div className="settings-row">
          <button className="btn" onClick={onOpenHelp}>
            {t.help.title}
          </button>
          <span className="settings-inline-hint">{t.settings.helpHint}</span>
        </div>
      )}
      {onRerunWizard && (
        <div className="settings-row">
          <button className="btn" onClick={onRerunWizard}>
            {t.settings.rerunWizard}
          </button>
          <span className="settings-inline-hint">{t.settings.rerunWizardHint}</span>
        </div>
      )}
    </>
  );
}
