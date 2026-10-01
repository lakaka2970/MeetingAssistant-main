import { describe, expect, it } from 'vitest';
import {
  captureKindForPlatform,
  defaultHotkeysForPlatform,
  linuxOzonePlatform,
  themSourceFor,
  whisperExecutionProvidersForPlatform,
} from '../shared/platform';

describe('platform defaults', () => {
  it('uses familiar Command shortcuts on macOS without changing Windows defaults', () => {
    expect(defaultHotkeysForPlatform('darwin')).toEqual({
      toggle: 'Command+B',
      shot: 'Command+Shift+S',
      answer: 'Command+Alt+D',
    });
    expect(defaultHotkeysForPlatform('win32')).toEqual({
      toggle: 'Control+B',
      shot: 'Control+Shift+S',
      answer: 'Control+Alt+A',
    });
  });

  it('uses Electron loopback only on Windows', () => {
    expect(captureKindForPlatform('win32')).toBe('loopback');
    expect(captureKindForPlatform('darwin')).toBe('input');
    expect(captureKindForPlatform('linux')).toBe('input');
  });

  it('never attempts the Windows DirectML provider on macOS', () => {
    expect(whisperExecutionProvidersForPlatform('win32')).toEqual(['dml', 'cpu']);
    expect(whisperExecutionProvidersForPlatform('darwin')).toEqual(['cpu']);
  });

  it('hands the other-party channel to the main process only where one exists', () => {
    // Windows: WASAPI module when chosen and built, else the display-media token
    expect(
      themSourceFor({ platform: 'win32', captureBackend: 'native', mainLoopbackAvailable: true }),
    ).toBe('main-process');
    expect(
      themSourceFor({ platform: 'win32', captureBackend: 'native', mainLoopbackAvailable: false }),
    ).toBe('display-media');
    expect(
      themSourceFor({ platform: 'win32', captureBackend: 'webaudio', mainLoopbackAvailable: true }),
    ).toBe('display-media');
    // Linux: the PipeWire tap, or a chosen input — never display-media, which
    // has no loopback source here
    expect(
      themSourceFor({ platform: 'linux', captureBackend: 'native', mainLoopbackAvailable: true }),
    ).toBe('main-process');
    expect(
      themSourceFor({ platform: 'linux', captureBackend: 'native', mainLoopbackAvailable: false }),
    ).toBe('input-device');
    expect(themSourceFor({ platform: 'darwin', captureBackend: 'native', mainLoopbackAvailable: false })).toBe(
      'input-device',
    );
  });

  it('forces XWayland only when the user asks for a backend', () => {
    expect(linuxOzonePlatform('x11')).toBe('x11');
    expect(linuxOzonePlatform('wayland')).toBe('wayland');
    expect(linuxOzonePlatform('auto')).toBeNull();
    expect(linuxOzonePlatform(undefined)).toBeNull();
  });
});
