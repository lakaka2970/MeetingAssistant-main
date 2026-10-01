import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import {
  AUTOSTART_ENTRY_NAME,
  applyLinuxAutostart,
  autostartDir,
  autostartExecPath,
  desktopEntryFor,
} from '../electron/autostartLinux';

describe('XDG autostart entry (Linux)', () => {
  it('quotes the executable and escapes an embedded quote', () => {
    const entry = desktopEntryFor('/opt/Meeting Assistant/meeting');
    expect(entry).toContain('Exec="/opt/Meeting Assistant/meeting"');
    expect(desktopEntryFor('/tmp/a"b')).toContain('Exec="/tmp/a\\"b"');
    expect(entry).toContain('X-GNOME-Autostart-enabled=true');
    expect(entry).toContain('Hidden=false');
  });

  it('launches the AppImage, not the /tmp mount it is running from', () => {
    expect(autostartExecPath({ APPIMAGE: '/home/u/MeetingAssistant-1.0.2.AppImage' })).toBe(
      '/home/u/MeetingAssistant-1.0.2.AppImage',
    );
    // a .deb has no APPIMAGE: execPath is already the installed binary
    expect(autostartExecPath({})).toBe(process.execPath);
  });

  it('defaults to the user config dir', () => {
    expect(autostartDir('/home/u/.config')).toBe(`/home/u/.config/autostart`);
    expect(autostartDir()).toBe(`${homedir()}/.config/autostart`);
  });

  it('writes the entry when enabled, removing it when not', () => {
    const written: [string, string][] = [];
    const removed: string[] = [];
    const made: string[] = [];
    const target = applyLinuxAutostart(true, {
      execPath: '/usr/bin/meetingassistant',
      configDir: '/tmp/cfg',
      write: (p, c) => written.push([p, c]),
      remove: (p) => removed.push(p),
      mkdir: (p) => made.push(p),
    });
    expect(target).toBe(`/tmp/cfg/autostart/${AUTOSTART_ENTRY_NAME}`);
    expect(made).toEqual(['/tmp/cfg/autostart']);
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe(target);
    expect(written[0][1]).toContain('Exec="/usr/bin/meetingassistant"');
    expect(removed).toEqual([]);

    applyLinuxAutostart(false, {
      configDir: '/tmp/cfg',
      write: (p, c) => written.push([p, c]),
      remove: (p) => removed.push(p),
      mkdir: (p) => made.push(p),
    });
    expect(removed).toEqual([target]);
    expect(written).toHaveLength(1);
  });

  it('treats removing an entry that is not there as success', () => {
    expect(() =>
      applyLinuxAutostart(false, {
        configDir: '/tmp/cfg',
        remove: () => {
          throw new Error('ENOENT');
        },
      }),
    ).not.toThrow();
  });
});
