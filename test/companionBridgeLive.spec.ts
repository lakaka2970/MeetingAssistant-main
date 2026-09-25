/**
 * ⑦ The control loop end to end: a real CompanionBridge on a real port with a
 * paired phone. The unit specs prove the payload builders and the admission
 * rules; this proves the three things the phone actually depends on — the `st`
 * echo that colours its switches arrives, it stops the moment the user revokes
 * remote control, and a desktop-side failure never takes the connection down.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

// The bridge module pulls in the desktop APIs its screenshot path uses. Nothing
// here reaches that code; the import just has to resolve.
vi.mock('electron', () => ({
  desktopCapturer: { getSources: async () => [] },
  screen: { getAllDisplays: () => [] },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import { CompanionBridge, type CompanionSettings } from '../electron/companion/bridge';
import type { ControlCommand } from '../electron/companion/control';
import { COMPANION_CONTROL_GRANTS } from '../shared/protocol';

const PORT = 18903;

const STATES = {
  off: {
    capturing: false,
    continuous: false,
    richness: 'standard' as const,
    expertise: 'professional' as const,
    session: { id: 's1', name: '某厂二面', answers: 3 },
  },
  on: {
    capturing: true,
    continuous: false,
    richness: 'detailed' as const,
    expertise: 'professional' as const,
    session: { id: 's1', name: '某厂二面', answers: 3 },
  },
};

let dir: string;
let bridge: CompanionBridge;
let settings: CompanionSettings;
const applied: ControlCommand[] = [];

/** point the bridge's state getter at one of the two fixtures above */
function useState(
  state: (typeof STATES)[keyof typeof STATES],
  run: (cmd: ControlCommand) => void = (cmd) => void applied.push(cmd),
): void {
  bridge.attachControl({ state: () => state, turns: () => [], run });
}

const makeSettings = (over: Partial<CompanionSettings> = {}): CompanionSettings => ({
  enabled: true,
  port: PORT,
  pushExam: true,
  pushInterview: true,
  pushTranscript: true,
  pushScreenshot: true,
  useHttps: false,
  jpegQuality: 80,
  maxDim: 1920,
  allowControl: true,
  allowItems: { ...COMPANION_CONTROL_GRANTS },
  ...over,
});

/**
 * A phone-side client that queues frames. ws emits every frame contained in one
 * TCP read back-to-back, so a per-message listener would silently drop the
 * second frame — which is exactly the `st` echo under test here.
 */
class Phone {
  private queue: Record<string, unknown>[] = [];
  private waiters: ((v: Record<string, unknown> | null) => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        parsed = { type: 'bad_json' };
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.queue.push(parsed);
    });
  }

  /** the next frame, or null if none arrives within `ms` */
  next(ms = 1500): Promise<Record<string, unknown> | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const settle = (v: Record<string, unknown> | null): void => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== settle);
        resolve(v);
      };
      const timer = setTimeout(() => settle(null), ms);
      this.waiters.push(settle);
    });
  }

  async close(): Promise<void> {
    this.ws.close();
    await new Promise<void>((r) => this.ws.once('close', r));
  }
}

/** pair over the wire, exactly like the phone does, and leave the client connected */
async function paired(): Promise<Phone> {
  const code = bridge.startPairing();
  expect(code).toMatch(/^\d{6}$/);
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });
  const phone = new Phone(ws);
  ws.send(JSON.stringify({ type: 'pair_confirm', code }));
  expect((await phone.next())?.type).toBe('pair_ok');
  return phone;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mc-bridge-live-'));
  settings = makeSettings();
  bridge = new CompanionBridge(
    () => settings,
    dir,
    () => {},
    () => {},
  );
  bridge.attachControl({
    state: () => STATES.off,
    turns: () => [],
    run: (cmd) => applied.push(cmd),
  });
  await bridge.apply();
});

afterAll(async () => {
  await bridge.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('companion control loop over a live bridge', () => {
  it('pushes the desktop state on connect and on every real change only', async () => {
    useState(STATES.off);
    const phone = await paired();
    // the connect echo: a fresh phone has no idea what the desktop looks like
    expect(await phone.next()).toMatchObject({ type: 'st', capturing: false, richness: 'standard' });

    // an unchanged poll costs nothing
    bridge.publishState();
    expect(await phone.next(200)).toBeNull();

    // and a changed one is not swallowed by that dedupe
    useState(STATES.on);
    bridge.publishState();
    expect(await phone.next()).toMatchObject({ type: 'st', capturing: true, richness: 'detailed' });
    await phone.close();
  });

  it('stops echoing the desktop state once remote control is revoked', async () => {
    // Every other publisher is gated at its call site; `st` carries the session
    // name and the ladder, so it must not reach a phone whose panel is off.
    useState(STATES.off);
    const phone = await paired();
    expect((await phone.next())?.type).toBe('st');

    settings = makeSettings({ allowControl: false });
    await bridge.apply();
    useState(STATES.on); // a real change: only the gate can keep this off the wire
    const pending = phone.next(300);
    bridge.publishState();
    expect(await pending).toBeNull();

    // toggling the grant back is enough — the phone never re-pairs, and the
    // state the gate swallowed is still owed to it
    settings = makeSettings();
    await bridge.apply();
    const again = phone.next(1500);
    bridge.publishState();
    expect(await again).toMatchObject({ type: 'st', capturing: true });
    await phone.close();
  });

  it('keeps answering the phone when a command throws on the desktop', async () => {
    // Not hypothetical: `richness` writes settings.json through writeFileSync,
    // and capture/continuous/ask send to a webContents that may be going away.
    // Main has no uncaughtException handler and this call stack is the ws
    // message callback, so an escaping error closes the app under a connected
    // phone — mid-meeting, with the meeting still running on the desktop.
    useState(STATES.off, (cmd) => {
      applied.push(cmd);
      throw new Error('ENOSPC: no space left on device, write');
    });
    const phone = await paired();
    expect((await phone.next())?.type).toBe('st');

    phone.ws.send(JSON.stringify({ type: 'cmd', id: 'c1', op: 'capture', arg: true }));
    expect(await phone.next()).toMatchObject({ type: 'ack', id: 'c1' });
    expect(applied.at(-1)).toMatchObject({ op: 'capture' });

    // the socket must still be a usable one, and the switch the phone tapped
    // settles because the desktop echoes the state it actually ended up in
    phone.ws.send(JSON.stringify({ type: 'ping', t: 1 }));
    expect((await phone.next())?.type).toBe('pong');
    useState(STATES.on);
    bridge.publishState();
    expect(await phone.next()).toMatchObject({ type: 'st', capturing: true });
    await phone.close();
  });
});
