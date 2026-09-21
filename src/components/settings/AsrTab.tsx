import { LOCAL_REALTIME_MODELS } from '../../../shared/providerCatalog';
import type { AsrLanguage } from '../../../shared/protocol';
import { type AsrBackend, type SettingsDraft } from './useSettingsDraft';

/** everything about turning speech into text: backend, its models/keys, language */
export function AsrTab({ d }: { d: SettingsDraft }) {
  const t = d.t;
  return (
    <>
      {window.mc.platform === 'darwin' && (
        <div className="settings-hint">{t.settings.macAudioHint}</div>
      )}
      <div className="settings-row">
        <label>{t.settings.asrBackend}</label>
        <select
          value={d.asrBackend}
          onChange={(e) => d.setAsrBackend(e.target.value as AsrBackend)}
        >
          <optgroup label={t.settings.asrLocalGroup}>
            <option value="local-realtime">{t.settings.asrLocalRealtime}</option>
            <option value="local">{t.settings.asrLocalWhisper}</option>
          </optgroup>
          <optgroup label={t.settings.asrCloudGroup}>
            <option value="cloud-realtime">{t.settings.asrCloudRealtime}</option>
            <option value="cloud">{t.settings.asrCloudSeg}</option>
          </optgroup>
        </select>
      </div>
      {d.asrBackend === 'local-realtime' && (
        <div className="settings-row">
          <label>{t.settings.localRtModel}</label>
          <select value={d.rtLocalModel} onChange={(e) => d.setRtLocalModel(e.target.value)}>
            {LOCAL_REALTIME_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {t.uiLang === 'zh' ? m.nameZh : m.nameEn}
              </option>
            ))}
          </select>
        </div>
      )}
      {d.asrBackend === 'local' && (
        <>
          <div className="settings-row">
            <label>{t.settings.strategyLabel}</label>
            <select
              value={d.strategy}
              onChange={(e) => d.setStrategy(e.target.value as typeof d.strategy)}
            >
              <option value="accuracy">{t.settings.strategyAccuracy}</option>
              <option value="balanced">{t.settings.strategyBalanced}</option>
              <option value="latency">{t.settings.strategyLatency}</option>
            </select>
          </div>
          <div className="settings-row">
            <label>{t.settings.moonshineLabel}</label>
            <select
              value={d.moonshine ? 'on' : 'off'}
              onChange={(e) => d.setMoonshine(e.target.value === 'on')}
            >
              <option value="off">{t.settings.autoLaunchOff}</option>
              <option value="on">{t.settings.autoLaunchOn}</option>
            </select>
            <span className="settings-inline-hint">{t.settings.moonshineHint}</span>
          </div>
        </>
      )}
      {d.asrBackend === 'cloud-realtime' && (
        <>
          <div className="settings-row">
            <label>{t.settings.providerPreset}</label>
            {d.providerSelect('asr-realtime', d.rtBaseUrl, d.rtModel, (p) => {
              d.setRtBaseUrl(p.baseUrl);
              d.setRtModel(p.model);
            })}
          </div>
          {d.keyRow(t.settings.rtApiKey, d.rtKey, 'asr-realtime', d.rtTarget())}
        </>
      )}
      {d.asrBackend === 'cloud' && (
        <>
          <div className="settings-row">
            <label>{t.settings.providerPreset}</label>
            {d.providerSelect('asr-segment', d.cloudBaseUrl, d.cloudModel, (p) => {
              d.setCloudBaseUrl(p.baseUrl);
              d.setCloudModel(p.model);
            })}
          </div>
          {d.keyRow(t.settings.cloudApiKey, d.cloudKey, 'asr-cloud', d.cloudTarget())}
        </>
      )}
      <div className="settings-row">
        <label>{t.settings.asrLanguage}</label>
        <select value={d.language} onChange={(e) => d.setLanguage(e.target.value as AsrLanguage)}>
          <option value="auto">{t.settings.asrLangAuto}</option>
          <option value="chinese">{t.settings.asrLangZh}</option>
          <option value="english">{t.settings.asrLangEn}</option>
        </select>
      </div>

      <details className="settings-advanced">
        <summary>{t.settings.advancedSection}</summary>
        <div className="settings-row">
          <label>{t.settings.rtBaseUrl}</label>
          <input
            value={d.rtBaseUrl}
            onChange={(e) => d.setRtBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="settings-row">
          <label>{t.settings.rtModel}</label>
          <input
            value={d.rtModel}
            onChange={(e) => d.setRtModel(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="settings-row">
          <label>{t.settings.cloudBaseUrl}</label>
          <input
            value={d.cloudBaseUrl}
            onChange={(e) => d.setCloudBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="settings-row">
          <label>{t.settings.cloudModel}</label>
          <input
            value={d.cloudModel}
            onChange={(e) => d.setCloudModel(e.target.value)}
            spellCheck={false}
          />
        </div>
      </details>
    </>
  );
}
