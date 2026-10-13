import { describe, expect, it } from 'vitest';
import { createUpdater, type Updater } from '../electron/updateInstall';
import type { UpdaterState } from '../shared/updateInstall';

/**
 * The glue against a stand-in electron-updater.
 *
 * What is being defended is one sentence from the spec: the app never downloads
 * on its own and never restarts on its own. Three library defaults decide
 * whether that is true — `autoDownload` and `autoInstallOnAppQuit` both ship as
 * `true` in 6.8.10 — and no test of a pure reducer can see them, because the
 * library is what acts on them. So the library is replaced here and the
 * assertions are about what this module sets and calls.
 *
 * The real network, the real `latest.yml` and a real install are a different
 * test, and they are on the machine that has an installed app.
 */
type Handler = (payload?: unknown) => void;

function fakeLib() {
  const handlers = new Map<string, Handler[]>();
  const calls: string[] = [];
  let installResult = true;
  let finishDownload: (() => void) | null = null;
  const autoUpdater = {
    // the library's own defaults, deliberately left at their real values: the
    // test below fails if this module stops overwriting them
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableWebInstaller: false,
    logger: null as unknown,
    checkForUpdates: async () => {
      calls.push('checkForUpdates');
      emit('update-available', { version: '1.9.0' });
      return { updateInfo: { version: '1.9.0' } };
    },
    downloadUpdate: (token?: unknown) => {
      calls.push('downloadUpdate');
      emit('download-progress', { percent: 40 });
      // a real download of ~118 MiB is still in flight when the user can change
      // their mind, so the promise only settles when the test says so — a fake
      // that resolves immediately makes any cancellation assertion racy by
      // construction (the finally block has already cleared the token)
      return new Promise((resolve) => {
        finishDownload = () => {
          emit('update-downloaded', { version: '1.9.0' });
          resolve([]);
        };
        if ((token as { cancelled?: boolean } | undefined)?.cancelled) finishDownload();
      });
    },
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => {
      calls.push(`quitAndInstall:${String(isSilent)}:${String(isForceRunAfter)}`);
      return installResult;
    },
    on: (ev: string, cb: Handler) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), cb]);
    },
  };
  function emit(ev: string, payload?: unknown): void {
    for (const cb of handlers.get(ev) ?? []) cb(payload);
  }
  return {
    lib: () => ({ autoUpdater }),
    autoUpdater,
    calls,
    emit,
    // settable so a test can make the handover fail the way BaseUpdater does
    // when the cached installer is gone
    setInstallResult(v: boolean) {
      installResult = v;
    },
    tokens: [] as { cancel(): void; cancelled: boolean }[],
    finishDownload: () => {
      const f = finishDownload;
      finishDownload = null;
      f?.();
    },
  };
}

function make(o: { lib?: ReturnType<typeof fakeLib>; installFails?: boolean } = {}): {
  updater: Updater | null;
  fake: ReturnType<typeof fakeLib>;
} {
  const fake = o.lib ?? fakeLib();
  if (o.installFails) fake.setInstallResult(false);
  const updater = createUpdater({
    lib: fake.lib,
    capability: 'nsis',
    currentVersion: '1.0.4',
    token: () => {
      const t = {
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      fake.tokens.push(t);
      return t;
    },
  });
  return { updater, fake };
}

describe('the three library defaults', () => {
  it('turns off automatic download, install-on-quit and web installers', () => {
    const { fake } = make();
    expect(fake.autoUpdater.autoDownload).toBe(false);
    expect(fake.autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(fake.autoUpdater.disableWebInstaller).toBe(true);
  });

  /**
   * The single most important line in this feature: checking must not start a
   * 118 MiB download. Both guards matter — the flag, and the fact that nothing
   * here calls downloadUpdate() from a check.
   */
  it('does not download anything when it only asked whether there is an update', async () => {
    const { updater, fake } = make();
    await updater!.check();
    expect(fake.calls).toEqual(['checkForUpdates']);
    expect(updater!.state.kind).toBe('available');
  });

  it('refuses to build a machine that cannot install', () => {
    const reasons: string[] = [];
    expect(createUpdater({ capability: 'dev', onReason: (r) => reasons.push(r) })).toBeNull();
    expect(createUpdater({ capability: 'portable' })).toBeNull();
    expect(reasons).toEqual(['dev']);
    // the portable branch must not even require the library
    expect(() => createUpdater({ capability: 'appimage' })).not.toThrow();
  });
});

describe('the install handshake', () => {
  it('downloads only after the user asked, then waits for a second ask', async () => {
    const { updater, fake } = make();
    await updater!.check();
    const inflight = updater!.download();
    fake.finishDownload();
    await inflight;
    expect(fake.calls).toContain('downloadUpdate');
    expect(updater!.state).toEqual({ kind: 'ready', version: '1.9.0' });
    // ready is not consent: nothing may be installed until the confirm lands
    expect(fake.calls).not.toContain('quitAndInstall:true:true');
  });

  it('hands over silently and relaunches, once the user has confirmed', async () => {
    const { updater, fake } = make();
    await updater!.check();
    const inflight = updater!.download();
    fake.finishDownload();
    await inflight;
    expect(updater!.confirmInstall()).toBe(true);
    expect(fake.calls).toContain('quitAndInstall:true:true');
    expect(updater!.state.kind).toBe('installing');
  });

  it('refuses the install from every state that has nothing downloaded', async () => {
    const { updater, fake } = make();
    // idle, then checking, then available — none of them may install
    expect(updater!.confirmInstall()).toBe(false);
    await updater!.check();
    expect(updater!.confirmInstall()).toBe(false);
    expect(fake.calls).not.toContain('quitAndInstall:true:true');
  });

  it('reports a library error instead of pretending it did not happen', async () => {
    const { updater, fake } = make();
    await updater!.check();
    fake.emit('error', { message: 'Cannot find channel "latest.yml" update info' });
    const s = updater!.state as UpdaterState;
    expect(s.kind).toBe('failed');
    expect(s).toMatchObject({ reason: 'Cannot find channel "latest.yml" update info' });
    expect(updater!.confirmInstall()).toBe(false);
  });

  it('will not download before it knows a version exists', async () => {
    const { updater, fake } = make();
    await updater!.download();
    expect(fake.calls).not.toContain('downloadUpdate');
    expect(updater!.state.kind).toBe('failed');
  });

  /**
   * The three things the review found missing from this file: a download asked
   * for from a state that has nothing to fetch, a handover the library refuses,
   * and a user who turns the switch off while 118 MB is still arriving.
   */
  it('refuses a download from a state with nothing to fetch, and says so by code', async () => {
    const { updater, fake } = make();
    // upToDate: the check ran, there is nothing newer
    await updater!.check();
    fake.emit('update-not-available', { version: '9.9.9' });
    expect(updater!.state).toEqual({ kind: 'upToDate', version: '1.0.4' });
    await updater!.download();
    expect(fake.calls).not.toContain('downloadUpdate');
    expect(updater!.state).toMatchObject({ kind: 'failed', reason: 'no-version' });
  });

  it('gives up when the library refuses the handover instead of pretending', async () => {
    const { updater, fake } = make({ installFails: true });
    await updater!.check();
    const inflight = updater!.download();
    fake.finishDownload();
    await inflight;
    expect(updater!.confirmInstall()).toBe(false);
    // BaseUpdater also dispatches its own error; either way the strip must not
    // sit on 正在交给安装程序… over an app that is still running
    expect(updater!.state.kind).toBe('failed');
  });

  it('cancels an in-flight download when the user turns the switch off', async () => {
    const { updater, fake } = make();
    await updater!.check();
    let resolved = false;
    const inflight = updater!.download().then(() => (resolved = true));
    await Promise.resolve();
    updater!.cancel();
    expect(fake.tokens.length).toBe(1);
    expect(fake.tokens[0].cancelled).toBe(true);
    expect(updater!.state).toMatchObject({ kind: 'failed', reason: 'cancelled' });
    // the bytes keep arriving until the library settles; late events must not
    // resurrect the cancelled download as `ready`
    fake.finishDownload();
    await inflight;
    expect(resolved).toBe(true);
    expect(updater!.state.kind).toBe('failed');
  });

  it('ignores cancel() when nothing is downloading', () => {
    const { updater, fake } = make();
    updater!.cancel();
    expect(fake.tokens.length).toBe(0);
  });

  it('publishes every state change so the tray and the overlay can follow', async () => {
    const { updater, fake } = make();
    // percent is part of what is recorded because a progress frame IS a state
    // change the banner has to paint; the sequence below is the whole promise
    // spoken once: no download before the ask, no install before the confirm
    const seen: string[] = [];
    updater!.onChange((s) => seen.push('percent' in s ? `${s.kind}:${s.percent}` : s.kind));
    await updater!.check();
    const inflight = updater!.download();
    fake.finishDownload();
    await inflight;
    updater!.confirmInstall();
    expect(seen).toEqual([
      'checking',
      'available',
      'downloading:0',
      'downloading:40',
      'ready',
      'installing',
    ]);
  });
});
