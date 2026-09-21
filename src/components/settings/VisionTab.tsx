import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_IDS,
  type SearchProviderId,
} from '../../../shared/searchProviders';
import type { SettingsDraft } from './useSettingsDraft';

/** screenshot-reading model + the web-search fallback behind knowledge misses */
export function VisionTab({ d }: { d: SettingsDraft }) {
  const t = d.t;
  return (
    <>
      <div className="settings-section">{t.settings.visionSection}</div>
      <div className="settings-hint">{t.settings.visionHint}</div>
      <div className="settings-row">
        <label>{t.settings.providerPreset}</label>
        {d.providerSelect('vision', d.visionBaseUrl, d.visionModel, (p) => {
          d.setVisionBaseUrl(p.baseUrl);
          d.setVisionModel(p.model);
          d.setVisionProxy(p.defaultProxyUrl ?? '');
        })}
      </div>
      <div className="settings-row">
        <label>{t.settings.visionBaseUrl}</label>
        <input
          value={d.visionBaseUrl}
          onChange={(e) => d.setVisionBaseUrl(e.target.value)}
          spellCheck={false}
          placeholder={t.settings.visionBaseUrlPlaceholder}
        />
      </div>
      <div className="settings-row">
        <label>{t.settings.visionModel}</label>
        <input
          value={d.visionModel}
          onChange={(e) => d.setVisionModel(e.target.value)}
          spellCheck={false}
        />
      </div>
      {d.keyRow(t.settings.visionApiKey, d.visionKey, 'vision', d.visionTarget())}
      <div className="settings-row">
        <label>{t.settings.visionProxy}</label>
        <input
          value={d.visionProxy}
          onChange={(e) => d.setVisionProxy(e.target.value)}
          spellCheck={false}
          placeholder={t.settings.visionProxyPlaceholder}
        />
      </div>
      <div className="settings-row">
        <label>{t.settings.ocrPrefilterLabel}</label>
        <select
          value={d.ocrPrefilter ? 'on' : 'off'}
          onChange={(e) => d.setOcrPrefilter(e.target.value === 'on')}
        >
          <option value="off">{t.settings.autoLaunchOff}</option>
          <option value="on">{t.settings.autoLaunchOn}</option>
        </select>
        <span className="settings-inline-hint">{t.settings.ocrPrefilterHint}</span>
      </div>

      <div className="settings-section">{t.settings.webSearchSection}</div>
      <div className="settings-hint">{t.settings.webSearchHint}</div>
      <div className="settings-row">
        <label>{t.settings.webSearchEnabled}</label>
        <select
          value={d.wsEnabled ? 'on' : 'off'}
          onChange={(e) => d.setWsEnabled(e.target.value === 'on')}
        >
          <option value="off">{t.settings.autoLaunchOff}</option>
          <option value="on">{t.settings.autoLaunchOn}</option>
        </select>
        <span className="settings-inline-hint">{t.settings.webSearchEnabledHint}</span>
      </div>
      <div className="settings-row">
        <label>{t.settings.webSearchProvider}</label>
        <select
          value={d.wsProvider}
          onChange={(e) => d.setWsProvider(e.target.value as SearchProviderId)}
        >
          {SEARCH_PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {t.uiLang === 'zh' ? SEARCH_PROVIDERS[id].labelZh : SEARCH_PROVIDERS[id].labelEn}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <label>{t.settings.webSearchApiKey}</label>
        {d.live.webSearch?.apiKeySet && !d.wsKey.editing && !d.wsKey.pendingDelete ? (
          <span className="settings-inline-hint">
            {t.settings.keyConfigured}（{d.live.webSearch.apiKeyHint ?? ''}） ·{' '}
            <button
              className="btn btn-sm"
              onClick={() => {
                d.wsKey.setEditing(true);
                d.wsKey.setValue('');
              }}
            >
              {t.settings.keyReplace}
            </button>
          </span>
        ) : (
          <input
            type="password"
            value={d.wsKey.value}
            onChange={(e) => d.wsKey.setValue(e.target.value)}
            placeholder={
              d.live.webSearch?.apiKeySet
                ? t.settings.keyNewPlaceholder
                : `${SEARCH_PROVIDERS[d.wsProvider].name} API Key`
            }
            spellCheck={false}
            autoComplete="off"
          />
        )}
        {d.wsKey.pendingDelete && (
          <span className="settings-inline-hint">{t.settings.keyPendingDelete}</span>
        )}
      </div>
      <div className="settings-actions">
        {d.live.webSearch?.apiKeySet && !d.wsKey.pendingDelete && (
          <button className="btn btn-sm" onClick={() => d.wsKey.setPendingDelete(true)}>
            {t.settings.keyDelete}
          </button>
        )}
        {(d.wsKey.editing || d.wsKey.pendingDelete) && (
          <button
            className="btn btn-sm"
            onClick={() => {
              d.wsKey.reset();
            }}
          >
            {t.settings.keyUndoDelete}
          </button>
        )}
        <a
          className="settings-inline-hint"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void window.mc.openExternal(SEARCH_PROVIDERS[d.wsProvider].keyUrl);
          }}
        >
          {t.settings.webSearchGetKey}
        </a>
        <span className="settings-inline-hint">
          {t.uiLang === 'zh'
            ? SEARCH_PROVIDERS[d.wsProvider].billingZh
            : SEARCH_PROVIDERS[d.wsProvider].billingEn}
        </span>
      </div>
      <div className="settings-row">
        <label>{t.settings.webSearchMax}</label>
        <select value={String(d.wsMax)} onChange={(e) => d.setWsMax(Number(e.target.value))}>
          {[3, 5, 8, 10].map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </select>
        <span className="settings-inline-hint">{t.settings.webSearchMaxHint}</span>
      </div>
    </>
  );
}
