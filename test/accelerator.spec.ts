import { describe, expect, it } from 'vitest';
import { isLikelyAccelerator } from '../shared/accelerator';

describe('isLikelyAccelerator (settings input gate)', () => {
  it('accepts the shipped defaults', () => {
    for (const k of ['Alt+Q', 'Alt+W', 'Alt+E', 'Control+Alt+B', 'Control+Alt+S', 'Command+Alt+B']) {
      expect(isLikelyAccelerator(k)).toBe(true);
    }
  });

  it('accepts modifier spellings and case differences', () => {
    expect(isLikelyAccelerator('ctrl+shift+s')).toBe(true);
    expect(isLikelyAccelerator('Cmd+K')).toBe(true);
    expect(isLikelyAccelerator('Super+Space')).toBe(true);
  });

  it('accepts bare function and media keys but not a bare letter', () => {
    // a lone 'A' would swallow every keystroke of that letter system-wide —
    // Electron registers it happily, so the gate has to be the one saying no
    expect(isLikelyAccelerator('F5')).toBe(true);
    expect(isLikelyAccelerator('VolumeUp')).toBe(true);
    expect(isLikelyAccelerator('A')).toBe(false);
  });

  it('rejects malformed input, including an empty final key', () => {
    expect(isLikelyAccelerator('')).toBe(false);
    expect(isLikelyAccelerator('   ')).toBe(false);
    expect(isLikelyAccelerator('Control+')).toBe(false);
    expect(isLikelyAccelerator('Meta+Foo')).toBe(false);
    expect(isLikelyAccelerator('你好世界')).toBe(false);
    // every part but the last must be a modifier — 'S' mid-chain is a typo
    expect(isLikelyAccelerator('Control+Alt+S+A')).toBe(false);
  });
});
