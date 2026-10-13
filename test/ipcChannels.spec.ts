import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `ipcMain.handle()` throws if a channel is registered twice, and the throw
 * happens at runtime, inside the promise chain of whichever handler was
 * registered second — so a duplicated registration is invisible to every unit
 * test and shows up on the user's machine as an unhandled rejection with no
 * dialog and no obvious cause. That is exactly how this file's existence was
 * earned: v1.0.4's install surface was registered twice during development and
 * only the packaged run said `Attempted to register a second handler for
 * 'updater:get'`.
 *
 * So the scan is cheap and runs on any host: read main.ts, take every
 * `ipcMain.handle(IPC.x` it registers, and require the names to be unique.
 */
const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function handledChannels(text: string): string[] {
  // both spellings: `IPC.updaterGet` and a literal 'updater:get'. A duplicate
  // registered the second way would otherwise slip past this guard
  const names = [...text.matchAll(/ipcMain\.handle\(IPC\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const literals = [...text.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return [...names, ...literals];
}

function duplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) twice.add(n);
    seen.add(n);
  }
  return [...twice];
}

describe('ipcMain.handle registrations', () => {
  it('finds the handlers at all (a scanner that matched nothing would pass forever)', () => {
    const names = handledChannels(source);
    expect(names.length).toBeGreaterThan(40);
    // the literal spelling is recognised too, or the widened scan is decoration
    expect(handledChannels("ipcMain.handle('updater:get', () => 1);")).toEqual(['updater:get']);
    expect(names).toContain('settingsGet');
    // in-memory mutation: the duplicate this test exists to catch
    expect(duplicates([...names, 'updaterGet'])).toEqual(['updaterGet']);
  });

  it('registers each channel exactly once', () => {
    expect(duplicates(handledChannels(source))).toEqual([]);
  });
});
