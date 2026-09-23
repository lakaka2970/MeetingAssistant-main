/**
 * Format gate for the hotkey inputs in Settings. Electron's
 * `globalShortcut.register` throws on a malformed accelerator and returns
 * false for an occupied one — the main process already handles both per key
 * (electron/main.ts registerHotkeys), but a user typing garbage in the
 * settings box deserves to see it AT THE BOX, not via a balloon after save.
 *
 * Deliberately permissive on spellings (Electron accepts several variants per
 * key); strict on structure, and it refuses a BARE letter/digit because that
 * hijacks the key for every app in the session.
 */

const MODIFIERS = new Set([
  'ctrl',
  'control',
  'alt',
  'shift',
  'super',
  'meta',
  'command',
  'cmd',
  'option',
]);

const NON_LETTER_KEYS = new Set([
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  'space',
  'tab',
  'enter',
  'return',
  'escape',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'printscreen',
  'volumeup',
  'volumedown',
  'volumemute',
  'mediaplaypause',
  'capslock',
  'numlock',
  'scrolllock',
]);

export function isLikelyAccelerator(input: string): boolean {
  const parts = input
    .trim()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  const last = parts[parts.length - 1].toLowerCase();
  if (parts.length === 1) return NON_LETTER_KEYS.has(last);
  for (const mod of parts.slice(0, -1)) {
    if (!MODIFIERS.has(mod.toLowerCase())) return false;
  }
  return NON_LETTER_KEYS.has(last) || /^[a-z0-9]$/.test(last);
}
