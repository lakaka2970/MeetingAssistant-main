/**
 * Answer-persona library (shared): the user writes and names several first-person
 * "who am I when I answer" profiles ahead of time and picks one per meeting.
 * Pure data + pure functions — the caps live here so main (settings guard) and
 * renderer (form hints) cannot drift apart.
 */

export interface AnswerPersona {
  id: string;
  name: string;
  /** first-person voice/profile text; rides the stable prompt prefix */
  text: string;
  updatedAt: number;
}

/** how many personas may be stored */
export const PERSONA_MAX_COUNT = 12;
/** a name longer than this is unreadable in the switcher anyway */
export const PERSONA_NAME_MAX = 24;
/** persona text enters every request, so it is budgeted like a prompt override */
export const PERSONA_TEXT_MAX = 2000;
/** cap for each editable prompt layer (基础人设模板 / 回答风格 / 自定义指令) */
export const PROMPT_OVERRIDE_MAX_CHARS = 2000;

export function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Never throws: a settings.json hand-edited into junk must degrade to a smaller
 * library, not to a failed boot.
 */
export function sanitizePersonas(raw: unknown): AnswerPersona[] {
  if (!Array.isArray(raw)) return [];
  const out: AnswerPersona[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const id = str(rec.id).trim();
    const text = str(rec.text).trim();
    if (!id || !text) continue;
    const name = str(rec.name).trim() || text.slice(0, PERSONA_NAME_MAX);
    const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
    out.push({ id, name: clampText(name, PERSONA_NAME_MAX), text: clampText(text, PERSONA_TEXT_MAX), updatedAt });
    if (out.length >= PERSONA_MAX_COUNT) break;
  }
  return out;
}

/** '' on either side means "no persona"; a dangling id means the same, silently */
export function resolveActivePersona(personas: AnswerPersona[], activeId: string | undefined): string {
  if (!activeId) return '';
  return personas.find((p) => p.id === activeId)?.text ?? '';
}
