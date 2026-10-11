/**
 * Task 7's wire layer, driven through `CompanionBridge.publishExam` itself.
 *
 * `test/examProtocol.spec.ts` can only prove the event types compile — vitest
 * strips the annotations, so nothing in it can fail at runtime. What this task
 * actually ships is a *routing* decision: check tokens get their own buffer and
 * their own frames, each re-check round stays in its own lane, `subMode` stays
 * off the wire, and a shutdown forgets a buffer it never got to send. Those are
 * only observable by calling the real method and reading what a phone would be
 * handed.
 *
 * So the socket here is a stub whose one job is to record, and the clock is fake
 * whose one job is to tick. No port, no handshake, no sleeping test: the 80 ms
 * merge window is behaviour under test, not something to wait out.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CompanionMessage } from '../electron/companion/protocol';

/**
 * Every server the bridge built, oldest first. A restart is its own instance,
 * which is what lets a test ask "did the old bridge's pending tick reach the
 * *new* phone?" — the failure Finding 1 is about.
 */
const stub = vi.hoisted(() => {
  const servers: { frames: CompanionMessage[]; stopped: boolean }[] = [];
  return {
    servers,
    latest(): { frames: CompanionMessage[]; stopped: boolean } {
      const last = servers[servers.length - 1];
      if (!last) throw new Error('the bridge never built a server');
      return last;
    },
  };
});

vi.mock('../electron/companion/server', () => {
  /**
   * Only the members the bridge actually touches are implemented; the real
   * class would throw on anything else, so an accidental dependency on the
   * transport shows up as a failure here instead of a silent pass.
   */
  class StubCompanionServer {
    frames: CompanionMessage[] = [];
    stopped = false;

    constructor() {
      stub.servers.push(this);
    }

    get authenticatedCount(): number {
      // one paired phone: enough for push() to broadcast rather than drop
      return 1;
    }
    get port(): number {
      return 18904;
    }
    get https(): boolean {
      return false;
    }

    async start(): Promise<void> {}

    async stop(): Promise<void> {
      this.stopped = true;
    }

    broadcastJson(msg: CompanionMessage): number {
      this.frames.push(msg);
      return 1;
    }

    broadcastLossy(msg: CompanionMessage): number {
      // lossy = drop when the phone lags. This phone never lags: what is
      // broadcast is exactly what the bridge decided to send.
      this.frames.push(msg);
      return 1;
    }
  }
  return { CompanionServer: StubCompanionServer };
});

// The bridge module pulls in the desktop APIs its screenshot path uses. Nothing
// here reaches that code; the import just has to resolve.
vi.mock('electron', () => ({
  desktopCapturer: { getSources: async () => [] },
  screen: { getAllDisplays: () => [] },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import { CompanionBridge, type CompanionSettings } from '../electron/companion/bridge';
import { COMPANION_CONTROL_GRANTS } from '../shared/protocol';

/** mirrors bridge.ts's FLUSH_MS: a test that ticks by a different amount is not testing the tick */
const FLUSH_MS = 80;

const makeSettings = (over: Partial<CompanionSettings> = {}): CompanionSettings => ({
  enabled: true,
  port: 18904,
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

let dir: string;
let settings: CompanionSettings;
let bridge: CompanionBridge;

/** every frame the current phone was handed, in wire order */
const frames = (): CompanionMessage[] => stub.latest().frames;
/** one `x` frame as the phone sees it: `phase`/`id` exist on every variant */
type XFrame = Extract<CompanionMessage, { type: 'x' }>;
const isX = (f: CompanionMessage): f is XFrame => f.type === 'x';
/** the exam stream only — `x` is the channel this task routes on */
const examFrames = (): XFrame[] => frames().filter(isX);
/** the answer stream of one request: what a phone appends onto its answer card */
const answerDeltas = (id: string): XFrame[] =>
  examFrames().filter((f) => f.phase === 'delta' && f.id === id);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-exam-stream-'));
});

beforeEach(async () => {
  vi.useFakeTimers();
  stub.servers.length = 0;
  settings = makeSettings();
  bridge = new CompanionBridge(() => settings, dir, () => {}, () => {});
  await bridge.apply();
  expect(stub.servers).toHaveLength(1);
});

afterEach(async () => {
  await bridge.dispose();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('exam check stream over a stubbed phone socket', () => {
  it('routes check tokens to their own frames, never onto the settled answer', () => {
    bridge.publishExam({ requestId: 'r1', kind: 'question', text: '两数之和', via: 'typed' });
    bridge.publishExam({ requestId: 'r1', kind: 'delta', text: 'ans' });
    vi.advanceTimersByTime(FLUSH_MS);
    bridge.publishExam({ requestId: 'r1', kind: 'done', text: 'ans', origin: 'model', ms: { total: 900 } });

    // the checker streams onto the *same* requestId the answer just closed
    bridge.publishExam({ requestId: 'r1', kind: 'checkDelta', turn: 1, text: 'tok' });
    vi.advanceTimersByTime(FLUSH_MS);

    // Shared-buffer corruption would read `anstok` here — the answer growing on
    // its own, which is the one thing the phone must never be able to see.
    expect(answerDeltas('r1')).toMatchObject([{ id: 'r1', text: 'ans' }]);
    expect(examFrames()).toMatchObject([
      { phase: 'question', id: 'r1', text: '两数之和' },
      { phase: 'delta', id: 'r1', text: 'ans' },
      { phase: 'done', id: 'r1', text: 'ans', origin: 'model' },
      { phase: 'checkDelta', id: 'r1', turn: 1, text: 'tok' },
    ]);
  });

  it('keeps two re-check rounds of one answer from interleaving', () => {
    bridge.publishExam({ requestId: 'r1', kind: 'checkDelta', turn: 1, text: 'a1' });
    bridge.publishExam({ requestId: 'r1', kind: 'checkDelta', turn: 2, text: 'b1' });
    bridge.publishExam({ requestId: 'r1', kind: 'checkDelta', turn: 1, text: 'a2' });
    vi.advanceTimersByTime(FLUSH_MS);

    // one frame per round, each carrying its own turn: a phone keys its cards
    // off `turn`, so a mixed frame would paint round 2's text on round 1's card
    expect(examFrames()).toMatchObject([
      { phase: 'checkDelta', id: 'r1', turn: 1, text: 'a1a2' },
      { phase: 'checkDelta', id: 'r1', turn: 2, text: 'b1' },
    ]);

    // a verdict is terminal for its own round only — round 1 stays buffered
    bridge.publishExam({ requestId: 'r1', kind: 'checkDelta', turn: 2, text: 'b2' });
    bridge.publishExam({ requestId: 'r1', kind: 'check', turn: 2, verdict: 'fix', note: '越界', ms: 812 });
    expect(examFrames().slice(2)).toMatchObject([
      // the round's tokens go out before the event that closes it
      { phase: 'checkDelta', turn: 2, text: 'b2' },
      { phase: 'check', turn: 2, verdict: 'fix', note: '越界', ms: 812 },
    ]);
    bridge.publishExam({ requestId: 'r1', kind: 'checkDone', turn: 1, text: 'done1' });
    expect(examFrames().slice(4)).toMatchObject([{ phase: 'checkDone', turn: 1, text: 'done1' }]);
    expect(answerDeltas('r1')).toEqual([]);
  });

  it('sends nothing for a sub-mode move, and everything for the rounds that close', () => {
    const before = frames().length;
    bridge.publishExam({ requestId: '', kind: 'subMode', subMode: 'technical' });
    vi.advanceTimersByTime(FLUSH_MS * 2);
    // an `x` frame for a bare mode change would invent a blank answer card
    expect(frames()).toHaveLength(before);

    bridge.publishExam({ requestId: 'r2', kind: 'checkDone', turn: 1, text: '改：B' });
    bridge.publishExam({ requestId: 'r2', kind: 'check', turn: 1, verdict: 'ok', note: '', ms: 640 });
    expect(examFrames()).toMatchObject([
      { phase: 'checkDone', id: 'r2', turn: 1, text: '改：B' },
      { phase: 'check', id: 'r2', turn: 1, verdict: 'ok' },
    ]);
  });

  it('forgets a buffered check token when the bridge shuts down before its tick', async () => {
    bridge.publishExam({ requestId: 'r9', kind: 'checkDelta', turn: 1, text: 'stale' });

    // the user turns companion off and back on: shutdown, then a fresh bind
    settings = makeSettings({ enabled: false });
    await bridge.apply();
    settings = makeSettings();
    await bridge.apply();
    expect(stub.servers).toHaveLength(2);
    const phone = stub.servers[1]!;
    expect(phone.frames).toEqual([]);

    // the pending tick belongs to the *old* bridge. Left armed, it fires at the
    // new phone and replays a token from before the shutdown.
    vi.advanceTimersByTime(FLUSH_MS);
    expect(phone.frames).toEqual([]);

    // and the buffer itself must be gone, not just its timer: a new round for
    // the same id+turn would otherwise resume the dead one's sentence
    bridge.publishExam({ requestId: 'r9', kind: 'checkDelta', turn: 1, text: 'fresh' });
    vi.advanceTimersByTime(FLUSH_MS);
    expect(phone.frames).toMatchObject([{ type: 'x', phase: 'checkDelta', id: 'r9', turn: 1, text: 'fresh' }]);
  });
});
