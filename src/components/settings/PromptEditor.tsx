/**
 * 高级设置 · 提示词进阶 — the three editable layers of the stable prefix.
 *
 * Each box saves on its own click: these are slow knobs that ride the provider
 * prefix cache, and main re-warms the same bytes on the write, so there is no
 * draft form to commit. An empty box means "use the built-in" — that is what
 * the placeholder shows and what `''` clears to in the settings guard. The
 * preview is main's real `stablePrefixFor()` output, never a second assembly.
 */
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { PublicSettings, SettingsPatch } from '../../../shared/protocol';
import { PROMPT_OVERRIDE_MAX_CHARS } from '../../../shared/personas';
import {
  DEFAULT_PERSONA_TEMPLATE,
  DEFAULT_STYLE_DIRECTIVES,
} from '../../../shared/promptLayers';

type LlmPatch = NonNullable<SettingsPatch['llm']>;
type LayerKey = 'promptPersona' | 'promptStyle' | 'promptExtra';

const layerPatch = (key: LayerKey, value: string): LlmPatch => {
  if (key === 'promptPersona') return { promptPersona: value };
  if (key === 'promptStyle') return { promptStyle: value };
  return { promptExtra: value };
};

export function PromptEditor({
  settings,
  onSaved,
  sessionId,
}: {
  settings: PublicSettings;
  onSaved: (s: PublicSettings) => void;
  /** the current interview — its résumé/JD/notes are what the preview assembles */
  sessionId?: string;
}) {
  const t = useT();
  const s = t.promptLab;
  const llm = settings.llm;
  const [draft, setDraft] = useState<Record<LayerKey, string>>({
    promptPersona: llm.promptPersona ?? '',
    promptStyle: llm.promptStyle ?? '',
    promptExtra: llm.promptExtra ?? '',
  });
  const [preview, setPreview] = useState('');
  const [previewChars, setPreviewChars] = useState(0);
  const [previewError, setPreviewError] = useState('');
  const [savedKey, setSavedKey] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await window.mc.promptPreview(sessionId);
      setPreview(r.prefix);
      setPreviewChars(r.chars);
      setPreviewError('');
    } catch (e) {
      setPreviewError(s.promptPreviewFailed((e as Error).message));
    }
  }, [sessionId, s]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const write = async (patch: LlmPatch, mark: string): Promise<void> => {
    onSaved(await window.mc.setSettings({ llm: patch }));
    setSavedKey(mark);
    void refresh();
  };

  const LAYERS: { key: LayerKey; label: string; hint: string; rows: number; ph: string }[] = [
    {
      key: 'promptPersona',
      label: s.promptPersonaLabel,
      hint: s.promptPersonaHint,
      rows: 9,
      ph: DEFAULT_PERSONA_TEMPLATE,
    },
    {
      key: 'promptStyle',
      label: s.promptStyleLabel,
      hint: s.promptStyleHint,
      rows: 4,
      ph: DEFAULT_STYLE_DIRECTIVES.join('\n'),
    },
    {
      key: 'promptExtra',
      label: s.promptExtraLabel,
      hint: s.promptExtraHint,
      rows: 4,
      ph: s.promptExtraPlaceholder,
    },
  ];

  return (
    <>
      <div className="settings-section">{s.promptTitle}</div>
      <div className="settings-hint">{s.promptIntro}</div>

      {LAYERS.map((layer) => (
        <div className="prompt-layer" key={layer.key}>
          <div className="prompt-layer-head">
            <span className="prompt-layer-label">{layer.label}</span>
            <span className="settings-inline-hint">
              {draft[layer.key].length} / {PROMPT_OVERRIDE_MAX_CHARS}
            </span>
            <button
              className="btn btn-sm"
              onClick={() => void write(layerPatch(layer.key, draft[layer.key]), layer.key)}
            >
              {s.promptSave}
            </button>
            <button
              className="btn btn-sm"
              disabled={!draft[layer.key]}
              // '' is the guard's clear-sentinel: the layer falls back to built-in
              onClick={() => {
                setDraft((d) => ({ ...d, [layer.key]: '' }));
                void write(layerPatch(layer.key, ''), layer.key);
              }}
            >
              {s.promptRestore}
            </button>
            {savedKey === layer.key && draft[layer.key] === (llm[layer.key] ?? '') && (
              <span className="tag tag-ok">{s.promptSaved}</span>
            )}
          </div>
          <div className="settings-inline-hint">{layer.hint}</div>
          <textarea
            className="prompt-layer-text"
            rows={layer.rows}
            spellCheck={false}
            value={draft[layer.key]}
            maxLength={PROMPT_OVERRIDE_MAX_CHARS}
            placeholder={layer.ph}
            onChange={(e) => setDraft((d) => ({ ...d, [layer.key]: e.target.value }))}
          />
        </div>
      ))}

      <div className="settings-actions">
        <button
          className="btn"
          onClick={() => {
            setDraft({ promptPersona: '', promptStyle: '', promptExtra: '' });
            void write({ promptPersona: '', promptStyle: '', promptExtra: '' }, 'all');
          }}
        >
          {s.promptRestoreAll}
        </button>
        <button className="btn" onClick={() => void refresh()}>
          {s.promptPreviewRefresh}
        </button>
      </div>

      <div className="settings-section">{s.promptPreviewTitle}</div>
      <div className="settings-inline-hint">
        {previewError || s.promptPreviewMeta(previewChars)}
      </div>
      <div className="settings-inline-hint">{s.promptPreviewNote}</div>
      <pre className="prompt-preview">{preview || s.promptPreviewLoading}</pre>
    </>
  );
}
