import type { ThinkingLevel } from '../../../shared/thinking';
import { useT } from '../../i18n';
import type { ThinkingBinding } from './types';

/**
 * One 思考强度 selector. Rendered only when the model behind `binding.cap`
 * declares a thinking mode; the 跟随默认 option sends no thinking parameter
 * at all (the provider's own default applies).
 */
export function ThinkingSelect({ label, binding }: { label: string; binding: ThinkingBinding }) {
  const t = useT();
  if (!binding.cap) return null;
  const levelText = (l: ThinkingLevel): string =>
    l === 'off'
      ? t.settings.thinkingOff
      : l === 'low'
        ? t.settings.thinkingLow
        : l === 'medium'
          ? t.settings.thinkingMedium
          : t.settings.thinkingHigh;
  const options: ThinkingLevel[] = ['off', ...binding.cap.levels];
  return (
    <div className="settings-row">
      <label>{label}</label>
      <select
        value={binding.value}
        onChange={(e) => binding.set(e.target.value as ThinkingLevel | '')}
      >
        <option value="">{t.settings.thinkingDefault}</option>
        {options.map((l) => (
          <option key={l} value={l}>
            {levelText(l)}
          </option>
        ))}
      </select>
      <span className="settings-inline-hint">{t.settings.thinkingHint}</span>
    </div>
  );
}
