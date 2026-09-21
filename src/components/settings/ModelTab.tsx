import { findPresetById } from '../../../shared/providerCatalog';
import { ThinkingSelect } from './ThinkingSelect';
import type { SettingsDraft } from './useSettingsDraft';
import type { ThinkingBinding } from './types';

/**
 * The primary answer model in one place: provider, endpoint, key, answer
 * language and its 思考强度 default. baseUrl/model used to hide in 高级 —
 * they belong here now that this tab is the whole 模型 setup story.
 */
export function ModelTab({ d }: { d: SettingsDraft }) {
  const t = d.t;
  const llmPreset = d.presetFor('text-llm', d.baseUrl, d.model);
  const defaultBinding: ThinkingBinding = {
    value: d.llmThinking,
    cap: llmPreset?.thinking,
    set: (v) => d.setLlmThinking(v),
  };
  const lanes: [string, string][] = [
    [t.settings.routeCoding, d.routeCoding],
    [t.settings.routeQuality, d.routeQuality],
    [t.settings.routeFallback, d.routeFallback],
  ];
  return (
    <>
      <div className="settings-hint">
        {t.settings.planSection}: {t.settings.planAsr} — {d.asrSummary()} · {t.settings.planLlm} —{' '}
        {d.llmSummary()}
      </div>
      {/* said once for the whole panel: every 测试连接 button costs one
          minimal billable request, and tests only ever run on a click */}
      <div className="settings-hint">{t.settings.testFeeNote}</div>

      <div className="settings-row">
        <label>
          {t.settings.planLlm} · {t.settings.providerPreset}
        </label>
        {d.providerSelect('text-llm', d.baseUrl, d.model, (p) => {
          d.setBaseUrl(p.baseUrl);
          d.setModel(p.model);
        })}
      </div>
      <div className="settings-row">
        <label>{t.settings.baseUrl}</label>
        <input value={d.baseUrl} onChange={(e) => d.setBaseUrl(e.target.value)} spellCheck={false} />
      </div>
      <div className="settings-row">
        <label>{t.settings.model}</label>
        <input value={d.model} onChange={(e) => d.setModel(e.target.value)} spellCheck={false} />
      </div>
      {d.keyRow(t.settings.apiKey, d.llmKey, 'llm', d.llmTarget())}
      <ThinkingSelect label={t.settings.thinkingLabel} binding={defaultBinding} />
      <div className="settings-row">
        <label>{t.settings.answerLangLabel}</label>
        <select
          value={d.answerLang}
          onChange={(e) => d.setAnswerLang(e.target.value as typeof d.answerLang)}
        >
          <option value="chinese">{t.settings.answerLangZh}</option>
          <option value="english">{t.settings.answerLangEn}</option>
        </select>
      </div>

      {/* routing is configured on its own tab; when it is on, show what the
          lanes currently resolve to so this tab still answers "which model
          will actually reply?" */}
      {d.routeEnabled && (
        <>
          <div className="settings-section">{t.settings.routeSection}</div>
          {lanes.map(([label, presetId]) => {
            const preset = presetId ? findPresetById(presetId) : undefined;
            return (
              <div key={label} className="settings-row">
                <label>{label}</label>
                <span className="settings-inline-hint">
                  {preset ? d.presetName(preset) : t.settings.routeNone}
                </span>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
