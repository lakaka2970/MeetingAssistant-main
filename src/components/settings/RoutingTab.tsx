import { findPresetById, presetsForCapability } from '../../../shared/providerCatalog';
import type { ThinkingLevel } from '../../../shared/thinking';
import { laneThinkingEntry, type KeySlot, type SettingsDraft } from './useSettingsDraft';
import { ThinkingSelect } from './ThinkingSelect';
import type { ThinkingBinding } from './types';

/**
 * Per-question-kind routing + failover. Each lane is a full model slot:
 * preset, own key when the provider differs from the primary, and its own
 * 思考强度 (falls back to the 模型 tab default when unset).
 */
export function RoutingTab({ d }: { d: SettingsDraft }) {
  const t = d.t;
  const lanes: [string, string, (v: string) => void, KeySlot][] = [
    [t.settings.routeCoding, d.routeCoding, d.setRouteCoding, d.routeCodingKey],
    [t.settings.routeQuality, d.routeQuality, d.setRouteQuality, d.routeQualityKey],
    [t.settings.routeFallback, d.routeFallback, d.setRouteFallback, d.routeFallbackKey],
  ];
  return (
    <>
      <div className="settings-hint">{t.settings.routeHint}</div>
      <div className="settings-row">
        <label>{t.settings.routeEnabled}</label>
        <select
          value={d.routeEnabled ? 'on' : 'off'}
          onChange={(e) => d.setRouteEnabled(e.target.value === 'on')}
        >
          <option value="off">{t.settings.autoLaunchOff}</option>
          <option value="on">{t.settings.autoLaunchOn}</option>
        </select>
      </div>
      {d.routeEnabled &&
        lanes.map(([label, value, set, keySlot]) => {
          const own = value ? d.laneNeedsOwnKey(value) : false;
          const meta = value ? d.laneRouteKey(value) : null;
          const preset = value ? findPresetById(value) : undefined;
          const thinkingBinding: ThinkingBinding | null =
            value && preset
              ? {
                  value: d.thinkingByPreset[value] ?? '',
                  cap: preset.thinking,
                  set: (v) =>
                    d.setThinkingByPreset(
                      laneThinkingEntry(
                        value,
                        v === '' ? undefined : (v as ThinkingLevel),
                        d.thinkingByPreset,
                      ),
                    ),
                }
              : null;
          return (
            <div key={label}>
              <div className="settings-row">
                <label>{label}</label>
                <select value={value} onChange={(e) => set(e.target.value)}>
                  <option value="">{t.settings.routeNone}</option>
                  {presetsForCapability('text-llm')
                    .filter((p) => p.baseUrl && p.model)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {d.presetName(p)}
                      </option>
                    ))}
                </select>
              </div>
              {thinkingBinding && (
                <ThinkingSelect
                  label={`${t.settings.thinkingLabel} · ${preset ? d.presetName(preset) : ''}`}
                  binding={thinkingBinding}
                />
              )}
              {own && (
                <div className="settings-row">
                  <label>
                    {t.settings.apiKey}
                    {preset ? ` · ${d.presetName(preset)}` : ''}
                  </label>
                  <input
                    type="password"
                    value={keySlot.value}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => keySlot.setValue(e.target.value)}
                    placeholder={
                      meta?.apiKeySet
                        ? `${t.settings.keyNewPlaceholder} (${meta.apiKeyHint ?? ''})`
                        : 'sk-…'
                    }
                  />
                  <span className="settings-inline-hint">{t.settings.routeKeyNeeded}</span>
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}
