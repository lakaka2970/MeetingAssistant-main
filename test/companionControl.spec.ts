import { describe, expect, it } from 'vitest';
import type { CompanionControlItems, StoredTurn } from '../shared/protocol';
import { COMPANION_CONTROL_GRANTS } from '../shared/protocol';
import { isControlMessage, type CompanionCaps } from '../electron/companion/protocol';
import {
  ASK_MAX_CHARS,
  CmdRateLimiter,
  HISTORY_ITEMS,
  HISTORY_TEXT_CHARS,
  authorizeControl,
  buildHistoryPayload,
  buildStatePayload,
  parseControlArg,
  sameState,
  type ControlGrants,
} from '../electron/companion/control';

const OPS = ['richness', 'expertise', 'capture', 'continuous', 'ask', 'history'] as const;

const grants = (over: Partial<ControlGrants> = {}): ControlGrants => ({
  allowControl: true,
  allowItems: { ...COMPANION_CONTROL_GRANTS },
  ...over,
});

const off = (item: keyof CompanionControlItems): CompanionControlItems => ({
  ...COMPANION_CONTROL_GRANTS,
  [item]: false,
});

/** a clock the test moves by hand: no sleeping, no flakes */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const turn = (over: Partial<StoredTurn> = {}): StoredTurn => ({
  id: 'r1',
  kind: 'free',
  label: '自我介绍下',
  text: '我在做实时转录。',
  status: 'done',
  ...over,
});

describe('authorizeControl (master switch, then per-item grant)', () => {
  it('lets a fresh profile use all six', () => {
    for (const op of OPS) expect(authorizeControl(op, grants())).toBe('ok');
  });

  it('treats a settings file that never mentions the grants as allowed', () => {
    // getPublic() expands both, but the bridge must not be stricter than the
    // screen the user checked the boxes on
    expect(authorizeControl('ask', {})).toBe('ok');
    expect(authorizeControl('ask', { allowItems: undefined })).toBe('ok');
  });

  it('a closed master switch outranks every per-item grant', () => {
    const cfg = grants({ allowControl: false });
    for (const op of OPS) expect(authorizeControl(op, cfg)).toBe('control_disabled');
  });

  it('one closed item blocks that item only', () => {
    const cfg = grants({ allowItems: off('ask') });
    expect(authorizeControl('ask', cfg)).toBe('item_disabled');
    expect(authorizeControl('richness', cfg)).toBe('ok');
  });

  it('refuses an op the phone has no business naming', () => {
    // pushExam is a real settings key the renderer patches — it must stay
    // unaddressable from the wire
    expect(authorizeControl('pushExam', grants())).toBe('unknown_op');
    expect(authorizeControl('', grants())).toBe('unknown_op');
    expect(authorizeControl(undefined as unknown as string, grants())).toBe('unknown_op');
  });
});

describe('cmd is not a handshake credential', () => {
  it('does not count as a control message', () => {
    expect(isControlMessage({ type: 'cmd', id: 'x', op: 'ask', arg: 'hi' })).toBe(false);
    expect(isControlMessage({ type: 'history' })).toBe(false);
    // the types that do prove the peer speaks the protocol
    expect(isControlMessage({ type: 'hello', token: 't' })).toBe(true);
  });

  it('caps gained a control channel that an old phone can ignore', () => {
    const caps: CompanionCaps = {
      transcript: true,
      interview: true,
      exam: true,
      screenshot: true,
      control: false,
      controlItems: { ...COMPANION_CONTROL_GRANTS },
    };
    expect(caps.control).toBe(false);
  });
});

describe('parseControlArg (nothing but the named values reaches settings)', () => {
  it('accepts only the two style ladders', () => {
    expect(parseControlArg('richness', 'detailed')).toEqual({ ok: true, value: 'detailed' });
    expect(parseControlArg('expertise', 'technical')).toEqual({ ok: true, value: 'technical' });
    expect(parseControlArg('richness', 'verbose')).toEqual({ ok: false });
    expect(parseControlArg('richness', true)).toEqual({ ok: false });
    expect(parseControlArg('richness', undefined)).toEqual({ ok: false });
  });

  it('wants a real boolean for the two switches', () => {
    expect(parseControlArg('capture', true)).toEqual({ ok: true, value: true });
    expect(parseControlArg('continuous', false)).toEqual({ ok: true, value: false });
    expect(parseControlArg('capture', 'true')).toEqual({ ok: false });
    expect(parseControlArg('capture', 1)).toEqual({ ok: false });
  });

  it('trims a question and refuses one that is empty or oversized', () => {
    expect(parseControlArg('ask', '  缓存怎么处理  ')).toEqual({ ok: true, value: '缓存怎么处理' });
    expect(parseControlArg('ask', '   ')).toEqual({ ok: false });
    expect(parseControlArg('ask', 'x'.repeat(ASK_MAX_CHARS))).toEqual({
      ok: true,
      value: 'x'.repeat(ASK_MAX_CHARS),
    });
    expect(parseControlArg('ask', 'x'.repeat(ASK_MAX_CHARS + 1))).toEqual({ ok: false });
  });

  it('history takes no argument at all', () => {
    expect(parseControlArg('history', undefined)).toEqual({ ok: true, value: undefined });
    expect(parseControlArg('history', 'junk')).toEqual({ ok: false });
  });
});

describe('CmdRateLimiter (5 commands per second per connection)', () => {
  it('refuses the sixth command inside the window', () => {
    const clock = fakeClock();
    const rl = new CmdRateLimiter({ now: clock.now });
    for (let i = 0; i < 5; i++) expect(rl.allow()).toBe(true);
    expect(rl.allow()).toBe(false);
  });

  it('lets commands through again once the window rolls past', () => {
    const clock = fakeClock();
    const rl = new CmdRateLimiter({ now: clock.now });
    for (let i = 0; i < 5; i++) rl.allow();
    expect(rl.allow()).toBe(false);
    clock.advance(1_001);
    expect(rl.allow()).toBe(true);
  });

  it('does not bank refusals into a burst later', () => {
    const clock = fakeClock();
    const rl = new CmdRateLimiter({ now: clock.now });
    for (let i = 0; i < 30; i++) rl.allow();
    clock.advance(1_001);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (rl.allow()) allowed += 1;
    expect(allowed).toBe(5);
  });
});

describe('buildStatePayload (the phone colours controls from this, never from its own click)', () => {
  const base = {
    capturing: true,
    continuous: false,
    richness: 'standard' as const,
    expertise: 'professional' as const,
    session: { id: 's1', name: '某厂二面', answers: 3 },
  };

  it('is a plain st message', () => {
    expect(buildStatePayload(base)).toEqual({ type: 'st', ...base });
  });

  it('reports no session as null, not as a half-filled row', () => {
    expect(buildStatePayload({ ...base, session: null }).session).toBeNull();
  });

  it('recognises its own payload so a repeat change costs no send', () => {
    const a = buildStatePayload(base);
    expect(sameState(a, buildStatePayload(base))).toBe(true);
    expect(sameState(a, buildStatePayload({ ...base, capturing: false }))).toBe(false);
    expect(sameState(a, buildStatePayload({ ...base, continuous: true }))).toBe(false);
    expect(sameState(a, buildStatePayload({ ...base, richness: 'detailed' }))).toBe(false);
    expect(sameState(a, buildStatePayload({ ...base, expertise: 'casual' }))).toBe(false);
    expect(sameState(a, buildStatePayload({ ...base, session: null }))).toBe(false);
    // another interview that happens to answer the same number of questions
    expect(
      sameState(a, buildStatePayload({ ...base, session: { id: 's2', name: '某厂二面', answers: 3 } })),
    ).toBe(false);
  });
});

describe('buildHistoryPayload (whole-session replay, capped)', () => {
  const many = (n: number): StoredTurn[] =>
    Array.from({ length: n }, (_, i) => turn({ id: `r${i}`, label: `Q${i}` }));

  it('sends the newest items first and reports how many there really were', () => {
    const hx = buildHistoryPayload(many(HISTORY_ITEMS + 5));
    expect(hx.type).toBe('hx');
    expect(hx.total).toBe(HISTORY_ITEMS + 5);
    expect(hx.items).toHaveLength(HISTORY_ITEMS);
    expect(hx.truncated).toBe(true);
    expect(hx.items[0].id).toBe(`r${HISTORY_ITEMS + 4}`);
    expect(hx.items[HISTORY_ITEMS - 1].id).toBe('r5');
  });

  it('leaves a short session unmarked', () => {
    const hx = buildHistoryPayload(many(3));
    expect(hx).toMatchObject({ total: 3, truncated: false });
    expect(hx.items.map((i) => i.id)).toEqual(['r2', 'r1', 'r0']);
  });

  it('drops the answer that is still streaming — the phone already has it live', () => {
    const hx = buildHistoryPayload([turn({ id: 'live', status: 'streaming' }), turn({ id: 'old' })]);
    expect(hx.items.map((i) => i.id)).toEqual(['old']);
    expect(hx.total).toBe(1);
  });

  it('clamps a long answer to the wire budget and carries the Q&A hit ref', () => {
    const hx = buildHistoryPayload([
      turn({
        id: 'long',
        text: 'x'.repeat(HISTORY_TEXT_CHARS + 500),
        qa: { question: 'q', answer: 'a', ref: '简历.docx', score: 1, exact: true },
      }),
    ]);
    expect(hx.items[0].text).toHaveLength(HISTORY_TEXT_CHARS);
    expect(hx.items[0].qaRef).toBe('简历.docx');
    expect(hx.truncated).toBe(true);
  });

  it('keeps an error answer visible: a blank card is worse than a failed one', () => {
    const hx = buildHistoryPayload([turn({ id: 'bad', status: 'error', error: '上游 502', text: '' })]);
    expect(hx.items[0]).toMatchObject({ id: 'bad', error: '上游 502' });
  });
});
