/**
 * 应答人设库 — the named personas the user writes ahead of a meeting and picks
 * from the 🎚 popover. Every write is a whole-list replace of `llm.personas`
 * straight to main (no draft/保存 row: these are not the shared draft form), so
 * what the settings store returns is what the switcher shows — including the
 * guard dropping a persona that broke a cap.
 */
import { useState } from 'react';
import { useT } from '../../i18n';
import type { PublicSettings } from '../../../shared/protocol';
import {
  PERSONA_MAX_COUNT,
  PERSONA_NAME_MAX,
  PERSONA_TEXT_MAX,
  clampText,
  type AnswerPersona,
} from '../../../shared/personas';

/** good enough for a per-user id nobody else ever has to guess */
const newId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface Editor {
  id: string;
  name: string;
  text: string;
}

export function PersonaLibrary({
  settings,
  onSaved,
  sessionId,
}: {
  settings: PublicSettings;
  onSaved: (s: PublicSettings) => void;
  /** the current interview — its résumé/JD seed the auto-draft */
  sessionId?: string;
}) {
  const t = useT();
  const s = t.promptLab;
  const personas = settings.llm.personas ?? [];
  const activeId = settings.llm.activePersonaId ?? '';
  const [editor, setEditor] = useState<Editor | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [notice, setNotice] = useState('');

  const write = async (next: AnswerPersona[]): Promise<void> => {
    onSaved(await window.mc.setSettings({ llm: { personas: next } }));
  };

  const openNew = (): void => {
    setNotice(personas.length >= PERSONA_MAX_COUNT ? s.personaLimit(PERSONA_MAX_COUNT) : '');
    if (personas.length >= PERSONA_MAX_COUNT) return;
    setEditor({ id: newId(), name: '', text: '' });
  };

  const save = async (): Promise<void> => {
    if (!editor) return;
    const name = clampText(editor.name.trim(), PERSONA_NAME_MAX);
    const text = clampText(editor.text.trim(), PERSONA_TEXT_MAX);
    if (!name) {
      setNotice(s.personaNeedName);
      return;
    }
    // main's guard silently drops an entry with no text, so refuse it here
    if (!text) {
      setNotice(s.personaNeedText);
      return;
    }
    const entry: AnswerPersona = { id: editor.id, name, text, updatedAt: Date.now() };
    const exists = personas.some((p) => p.id === entry.id);
    await write(
      exists ? personas.map((p) => (p.id === entry.id ? entry : p)) : [...personas, entry],
    );
    setEditor(null);
    setNotice('');
  };

  const remove = async (id: string): Promise<void> => {
    await write(personas.filter((p) => p.id !== id));
    if (id === activeId) setNotice(s.personaDeletedActive);
    if (editor?.id === id) setEditor(null);
  };

  const activate = async (id: string): Promise<void> => {
    onSaved(await window.mc.setSettings({ llm: { activePersonaId: id } }));
  };

  const draft = async (): Promise<void> => {
    if (!editor) return;
    setDrafting(true);
    setNotice('');
    try {
      const res = await window.mc.personaDraft(sessionId);
      if (res.error) setNotice(s.personaDraftFailed(res.error));
      else if (res.text) {
        setEditor({ ...editor, text: res.text });
        setNotice(s.personaDraftDone);
      }
    } finally {
      setDrafting(false);
    }
  };

  return (
    <>
      <div className="settings-section">{s.personaTitle}</div>
      <div className="settings-hint">{s.personaIntro}</div>

      {!personas.length && !editor && <div className="settings-hint">{s.personaEmpty}</div>}

      {personas.map((p) => {
        const active = p.id === activeId;
        return (
          <div className="persona-row" key={p.id}>
            <div className="persona-row-head">
              <span className="persona-row-name">{p.name}</span>
              {active && <span className="tag tag-ok">{s.personaUsed}</span>}
              <span className="settings-inline-hint">
                {p.text.length} / {PERSONA_TEXT_MAX} ·{' '}
                {p.updatedAt ? new Date(p.updatedAt).toLocaleString(t.locale) : '—'}
              </span>
            </div>
            <div className="persona-row-text">{p.text}</div>
            <div className="persona-row-actions">
              {active ? (
                <button className="btn btn-sm" onClick={() => void activate('')}>
                  {s.personaStop}
                </button>
              ) : (
                <button className="btn btn-sm" onClick={() => void activate(p.id)}>
                  {s.personaUse}
                </button>
              )}
              <button
                className="btn btn-sm"
                onClick={() => setEditor({ id: p.id, name: p.name, text: p.text })}
              >
                {s.personaEdit}
              </button>
              <button className="btn btn-sm" onClick={() => void remove(p.id)}>
                {s.personaDelete}
              </button>
            </div>
          </div>
        );
      })}

      {editor ? (
        <>
          <div className="settings-row">
            <label>{s.personaName}</label>
            <input
              value={editor.name}
              maxLength={PERSONA_NAME_MAX}
              placeholder={s.personaNamePlaceholder}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            />
          </div>
          <textarea
            className="persona-text"
            rows={8}
            value={editor.text}
            maxLength={PERSONA_TEXT_MAX}
            placeholder={s.personaTextPlaceholder}
            onChange={(e) => setEditor({ ...editor, text: e.target.value })}
          />
          <div className="settings-inline-hint">
            {editor.text.length} / {PERSONA_TEXT_MAX}
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={() => void save()}>
              {s.personaSave}
            </button>
            <button className="btn" onClick={() => setEditor(null)}>
              {s.personaCancel}
            </button>
            <button className="btn" disabled={drafting} onClick={() => void draft()}>
              {drafting ? s.personaDrafting : s.personaDraft}
            </button>
          </div>
        </>
      ) : (
        <div className="settings-actions">
          <button className="btn" onClick={openNew}>
            {s.personaNew}
          </button>
        </div>
      )}

      {notice && <div className="settings-warn">{notice}</div>}
    </>
  );
}
