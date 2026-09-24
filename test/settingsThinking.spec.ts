import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsStore, plainCipher } from '../electron/settings';

function tempStore(initial?: string): { store: SettingsStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ma-settings-'));
  const file = join(dir, 'settings.json');
  if (initial !== undefined) {
    // the constructor reads the file, so write it before constructing
    const { writeFileSync } = require('fs') as typeof import('fs');
    writeFileSync(file, initial, 'utf8');
  }
  return { store: new SettingsStore(file, plainCipher), file };
}

describe('settings thinking levels', () => {
  it('persists llm.thinking and llm.thinkingByPreset across reloads', () => {
    const { store, file } = tempStore();
    store.applyPatch({
      llm: { thinking: 'low', thinkingByPreset: { 'deepseek.text.deep': 'high' } },
    });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.llm.thinking).toBe('low');
    expect(onDisk.llm.thinkingByPreset).toEqual({ 'deepseek.text.deep': 'high' });

    const reloaded = new SettingsStore(file, plainCipher);
    const pub = reloaded.getPublic();
    expect(pub.llm.thinking).toBe('low');
    expect(pub.llm.thinkingByPreset).toEqual({ 'deepseek.text.deep': 'high' });
    rmSync(file);
  });

  it('an old settings.json without the fields loads with the off default and an empty map', () => {
    const legacy = JSON.stringify({ version: 2, llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } });
    const { store } = tempStore(legacy);
    const pub = store.getPublic();
    expect(pub.llm.thinking).toBe('off');
    expect(pub.llm.thinkingByPreset).toEqual({});
  });

  it('a whole-map patch replaces the previous thinkingByPreset', () => {
    const { store } = tempStore();
    store.applyPatch({ llm: { thinkingByPreset: { a: 'low', b: 'high' } } });
    store.applyPatch({ llm: { thinkingByPreset: { c: 'medium' } } });
    expect(store.getPublic().llm.thinkingByPreset).toEqual({ c: 'medium' });
  });

  it('llm.thinking defaults to off so answers stop paying for hidden reasoning', () => {
    const { store } = tempStore();
    expect(store.getPublic().llm.thinking).toBe('off');
  });

  it("llm.thinking: '' clears a stored level back to provider default", () => {
    const { store } = tempStore();
    store.applyPatch({ llm: { thinking: 'high' } });
    expect(store.getPublic().llm.thinking).toBe('high');
    store.applyPatch({ llm: { thinking: '' } });
    expect(store.getPublic().llm.thinking).toBeUndefined();
  });
});
