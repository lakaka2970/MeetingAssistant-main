import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsStore, plainCipher } from '../electron/settings';
import {
  PERSONA_MAX_COUNT,
  PERSONA_NAME_MAX,
  PERSONA_TEXT_MAX,
  PROMPT_OVERRIDE_MAX_CHARS,
  resolveActivePersona,
  sanitizePersonas,
} from '../shared/personas';

function tempStore(): SettingsStore {
  const dir = mkdtempSync(join(tmpdir(), 'ma-persona-'));
  return new SettingsStore(join(dir, 'settings.json'), plainCipher);
}

const persona = (id: string, over: Partial<{ name: string; text: string }> = {}) => ({
  id,
  name: over.name ?? `P${id}`,
  text: over.text ?? `我是${id}的口吻`,
  updatedAt: 1,
});

describe('sanitizePersonas', () => {
  it('keeps well-formed entries untouched', () => {
    const list = [persona('a'), persona('b')];
    expect(sanitizePersonas(list)).toEqual(list);
  });

  it('drops entries without an id or with blank text', () => {
    const out = sanitizePersonas([
      persona('keep'),
      { ...persona('x'), id: '' },
      persona('blank', { text: '   ' }),
    ]);
    expect(out.map((p) => p.id)).toEqual(['keep']);
  });

  it('caps the library at PERSONA_MAX_COUNT, keeping the first N', () => {
    const many = Array.from({ length: PERSONA_MAX_COUNT + 3 }, (_, i) => persona(`p${i}`));
    const out = sanitizePersonas(many);
    expect(out).toHaveLength(PERSONA_MAX_COUNT);
    expect(out[0].id).toBe('p0');
    expect(out.at(-1)!.id).toBe(`p${PERSONA_MAX_COUNT - 1}`);
  });

  it('trims and clamps name, falling back to the text head when empty', () => {
    const long = '名'.repeat(PERSONA_NAME_MAX + 10);
    const [clamped] = sanitizePersonas([persona('a', { name: long })]);
    expect(clamped.name).toHaveLength(PERSONA_NAME_MAX);
    const [derived] = sanitizePersonas([persona('b', { name: '   ' })]);
    expect(derived.name).toBe(derived.text.slice(0, PERSONA_NAME_MAX));
  });

  it('clamps persona text to the prompt budget', () => {
    const [p] = sanitizePersonas([persona('a', { text: '字'.repeat(PERSONA_TEXT_MAX + 500) })]);
    expect(p.text).toHaveLength(PERSONA_TEXT_MAX);
  });

  it('tolerates junk input instead of throwing at a settings patch', () => {
    expect(sanitizePersonas(undefined)).toEqual([]);
    expect(sanitizePersonas('nope')).toEqual([]);
    expect(sanitizePersonas([null, 1, 'x', []])).toEqual([]);
  });
});

describe('resolveActivePersona', () => {
  const list = [persona('a', { text: 'A 的口吻' }), persona('b')];

  it('returns the selected persona text', () => {
    expect(resolveActivePersona(list, 'a')).toBe('A 的口吻');
  });

  it('returns empty for the disabled sentinel and for a dangling id', () => {
    expect(resolveActivePersona(list, '')).toBe('');
    expect(resolveActivePersona(list, 'gone')).toBe('');
  });
});

describe('settings: v1.0.1 answer-style fields', () => {
  it('a fresh install defaults to the v1.0.0 prompt behaviour', () => {
    const pub = tempStore().getPublic();
    expect(pub.llm.answerRichness).toBe('standard');
    expect(pub.llm.answerExpertise).toBe('professional');
    expect(pub.llm.personas).toEqual([]);
    expect(pub.llm.activePersonaId).toBe('');
    expect(pub.llm.promptPersona).toBeUndefined();
    expect(pub.llm.promptStyle).toBeUndefined();
    expect(pub.llm.promptExtra).toBeUndefined();
  });

  it('an existing v1.0.0 settings.json gains the same defaults without a migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-persona-legacy-'));
    const file = join(dir, 'settings.json');
    const { writeFileSync } = require('fs') as typeof import('fs');
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', answerLang: 'chinese' },
      }),
      'utf8',
    );
    const pub = new SettingsStore(file, plainCipher).getPublic();
    expect(pub.llm.answerRichness).toBe('standard');
    expect(pub.llm.personas).toEqual([]);
    expect(pub.llm.activePersonaId).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the ladder across a reload', () => {
    const store = tempStore();
    store.applyPatch({ llm: { answerRichness: 'detailed', answerExpertise: 'casual' } });
    const pub = store.getPublic();
    expect(pub.llm.answerRichness).toBe('detailed');
    expect(pub.llm.answerExpertise).toBe('casual');
  });

  it('replaces the whole persona library on each patch', () => {
    const store = tempStore();
    store.applyPatch({ llm: { personas: [persona('a'), persona('b')] } });
    store.applyPatch({ llm: { personas: [persona('c')] } });
    expect(store.getPublic().llm.personas.map((p) => p.id)).toEqual(['c']);
  });

  it('returns the trimmed library so the UI shows what actually got stored', () => {
    const store = tempStore();
    const many = Array.from({ length: PERSONA_MAX_COUNT + 5 }, (_, i) => persona(`p${i}`));
    store.applyPatch({ llm: { personas: many } });
    expect(store.getPublic().llm.personas).toHaveLength(PERSONA_MAX_COUNT);
  });

  it('deactivates a persona that was deleted while active', () => {
    const store = tempStore();
    store.applyPatch({ llm: { personas: [persona('a'), persona('b')], activePersonaId: 'a' } });
    expect(store.getPublic().llm.activePersonaId).toBe('a');
    store.applyPatch({ llm: { personas: [persona('b')] } });
    expect(store.getPublic().llm.activePersonaId).toBe('');
  });

  it('accepts an explicit disable without touching the library', () => {
    const store = tempStore();
    store.applyPatch({ llm: { personas: [persona('a')], activePersonaId: 'a' } });
    store.applyPatch({ llm: { activePersonaId: '' } });
    const pub = store.getPublic();
    expect(pub.llm.activePersonaId).toBe('');
    expect(pub.llm.personas).toHaveLength(1);
  });

  it('clamps an over-budget prompt override to the cap', () => {
    const store = tempStore();
    store.applyPatch({ llm: { promptExtra: '指'.repeat(PROMPT_OVERRIDE_MAX_CHARS + 300) } });
    expect(store.getPublic().llm.promptExtra).toHaveLength(PROMPT_OVERRIDE_MAX_CHARS);
  });

  it("'' on a prompt override clears it back to the built-in text", () => {
    const store = tempStore();
    store.applyPatch({ llm: { promptPersona: '自定义人设', promptStyle: '自定义风格' } });
    expect(store.getPublic().llm.promptPersona).toBe('自定义人设');
    store.applyPatch({ llm: { promptPersona: '', promptStyle: '' } });
    const pub = store.getPublic();
    expect(pub.llm.promptPersona).toBeUndefined();
    expect(pub.llm.promptStyle).toBeUndefined();
  });
});
