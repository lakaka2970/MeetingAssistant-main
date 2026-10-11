import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { splitCodeFences } from '../shared/codeFences';

/**
 * The phone page loads markdown.js as a plain script that hangs renderMarkdown
 * (and the codeTextFromLines joiner the copy/download read path uses) off
 * `window`, so the only honest way to test it is to run it the way the browser
 * does.
 */
function loadWindow(): Record<string, unknown> {
  const source = readFileSync(new URL('../resources/companion/markdown.js', import.meta.url), 'utf8');
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  runInContext(source, createContext(sandbox) as never);
  return sandbox.window;
}

function loadRenderer(): (src: string) => string {
  return (loadWindow() as { renderMarkdown: (s: string) => string }).renderMarkdown;
}

/**
 * app.js is a browser page: past its pure helpers it touches document/WebSocket
 * at the top level, so the whole file cannot run in a vm. The check-card state
 * machine is fenced in CHECK_MARK_BEGIN/CHECK_MARK_END comments — exactly the
 * part that must be pinned, because it is a runtime-ORDER problem (the main
 * process streams every checkDelta before the verdict header) that a type check
 * cannot see. If the markers ever disappear, this throws instead of silently
 * testing nothing.
 */
type PhoneCheck = { turn: number; verdict: string; note: string; text: string; ms: number; streaming: boolean };
type PhoneMsg = { phase: string; turn: number; text?: string; verdict?: string; note?: string; ms?: number };

function loadCheckMachine(): {
  applyCheckEvent: (check: PhoneCheck | null, msg: PhoneMsg) => PhoneCheck | null;
  region: string;
} {
  const src = readFileSync(new URL('../resources/companion/app.js', import.meta.url), 'utf8');
  const region = extractRegion(src, 'CHECK_MARK');
  const box: Record<string, unknown> = {};
  runInContext(region, createContext(box) as never);
  return { applyCheckEvent: box.applyCheckEvent as never, region };
}

/** app.js fences its DOM-free decision functions in `X_MARK_BEGIN`/`X_MARK_END`
 *  comment blocks so the node:vm harness can run them; a missing fence throws
 *  instead of silently testing nothing. */
function extractRegion(src: string, mark: string): string {
  const start = src.indexOf(`/* ${mark}_BEGIN`);
  const end = src.indexOf(`/* ${mark}_END`);
  if (start < 0 || end < 0 || end <= start) throw new Error(`app.js lost its ${mark}_BEGIN/${mark}_END fence`);
  return src.slice(start, end);
}

function loadNoteRouter(): (msg: { id?: string; text?: string }) => string {
  const src = readFileSync(new URL('../resources/companion/app.js', import.meta.url), 'utf8');
  const box: Record<string, unknown> = {};
  runInContext(extractRegion(src, 'NOTE_MARK'), createContext(box) as never);
  return box.examNoteRoute as never;
}

describe('companion renderMarkdown', () => {
  const md = loadRenderer();

  it('renders a fenced block as a code-block with a language tag and controls', () => {
    const html = md('```cpp\nint main(){}\n```');
    expect(html).toContain('class="code-block"');
    expect(html).toContain('data-lang="cpp"');
    expect(html).toContain('class="code-pre"');
    expect(html).toContain('code-wrap');
    expect(html).toContain('int main(){}');
  });

  it('trims blank lines at the block edges but keeps indentation', () => {
    const html = md('```python\n\n\ndef f(x):\n    return x\n\n```');
    // One span.code-line per source line, joined without a separator: the
    // wrap mode's hanging indent only works because text-indent acts on each
    // block's first line — a merged text node would break it.
    expect(html).toContain('<span class="code-line">def f(x):</span><span class="code-line">    return x</span>');
    // Both leading blank lines and the trailing one are trimmed away.
    expect((html.match(/class="code-line"/g) || []).length).toBe(2);
  });

  it('closes an unterminated fence at end of input', () => {
    expect(md('```java\nclass A {')).toContain('class A {');
  });

  it('escapes HTML inside code instead of emitting it', () => {
    const html = md('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('still renders prose, lists and inline code', () => {
    const html = md('# 标题\n\n- 一\n- 二\n\n`x` 与 **粗**');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code>x</code>');
    expect(html).toContain('<strong>粗</strong>');
  });

  it('does not turn markdown inside a code block into markup', () => {
    const html = md('```\n# not a heading\n1. not a list\n```');
    expect(html).toContain('# not a heading');
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('<ol>');
  });

  it('falls back to txt for an exotic fence tag instead of walking the prototype chain', () => {
    // CODE_EXT is a plain object literal; CODE_EXT['constructor'] would hit
    // Object.prototype and stringify a native function into data-ext.
    const html = md('```constructor\nx\n```');
    expect(html).toContain('data-ext="txt"');
    expect(html).not.toMatch(/native code|function Object/);
  });
});

describe('companion code-block read path', () => {
  const md = loadRenderer();
  const { codeTextFromLines } = loadWindow() as unknown as {
    codeTextFromLines: (lines: string[]) => string;
  };
  const lineSpans = (html: string) =>
    [...html.matchAll(/<span class="code-line">([^<]*)<\/span>/g)].map((m) => m[1]);

  it('round-trips a two-line block: spans carry the exact lines, the joiner restores newlines', () => {
    const html = md('```c\nline1\n  line2\n```');
    expect(lineSpans(html)).toEqual(['line1', '  line2']);
    expect(codeTextFromLines(lineSpans(html))).toBe('line1\n  line2');
  });

  it('keeps an interior blank line through the round trip', () => {
    const html = md('```c\na\n\nb\n```');
    expect(lineSpans(html)).toEqual(['a', '', 'b']);
    expect(codeTextFromLines(lineSpans(html))).toBe('a\n\nb');
  });

  it('joins the spans with the empty string in markup — newlines live only in the read path', () => {
    // white-space:pre would render a literal \n between spans as a phantom
    // blank line, so the DOM contract is join(''); copy/download must read
    // per-line and rejoin, never glue textContent (which has no separator).
    const html = md('```c\nline1\nline2\n```');
    expect(html).toContain('<span class="code-line">line1</span><span class="code-line">line2</span>');
    expect(html).not.toContain('<code>\n');
  });

  it('app.js reconstructs copy/download text from .code-line via the shared joiner, not raw textContent', () => {
    const src = readFileSync(new URL('../resources/companion/app.js', import.meta.url), 'utf8');
    expect(src).toMatch(/querySelectorAll\('\.code-line'\)/);
    expect(src).toMatch(/codeTextFromLines/);
    expect(src).not.toMatch(/writeText\([^)]*textContent/);
    expect(src).not.toMatch(/new Blob\(\[[^\]]*textContent/);
  });
});

/**
 * The phone's half of the check card. The order under test is the one main
 * really produces: `checkDelta` ×N, then the `check` verdict header, then
 * `checkDone` — the verdict is parsed from the finished text, so the header can
 * not precede the stream it describes. A renderer that waited for a card before
 * accepting tokens dropped the whole revision (review finding #3).
 */
describe('companion check-card state machine (app.js, fenced pure region)', () => {
  const { applyCheckEvent } = loadCheckMachine();
  const D = (text: string, turn = 1): PhoneMsg => ({ phase: 'checkDelta', turn, text });
  const H = (over: Partial<PhoneMsg> = {}): PhoneMsg => ({ phase: 'check', turn: 1, verdict: 'fix', note: '', ms: 900, ...over });
  const F = (text: string, turn = 1): PhoneMsg => ({ phase: 'checkDone', turn, text });
  const run = (msgs: PhoneMsg[]): PhoneCheck | null =>
    msgs.reduce<PhoneCheck | null>((c, m) => applyCheckEvent(c, m), null);

  it('the first token with no card opens a provisional card instead of vanishing', () => {
    expect(applyCheckEvent(null, D('思路：'))).toEqual({
      turn: 1, verdict: 'unknown', note: '', text: '思路：', ms: 0, streaming: true,
    });
  });

  it('tokens grow the card, and the later header merges without erasing them', () => {
    const c = run([D('O(n '), D('log n)'), H({ note: '少了空数组判断', ms: 1500 })]);
    expect(c).toEqual({ turn: 1, verdict: 'fix', note: '少了空数组判断', text: 'O(n log n)', ms: 1500, streaming: true });
  });

  it('checkDone retells the round in full and closes the spinner', () => {
    const c = run([D('半截'), H(), F('完整修订正文')]);
    expect(c).toMatchObject({ text: '完整修订正文', streaming: false, verdict: 'fix' });
  });

  it('an empty checkDone never blanks what already streamed', () => {
    const c = run([D('streamed'), H(), F('')]);
    expect(c?.text).toBe('streamed');
    expect(c?.streaming).toBe(false);
  });

  it('ok / unknown close the card — they are the round’s last word', () => {
    for (const verdict of ['ok', 'unknown']) {
      const c = run([D('x'), H({ verdict })]);
      expect(c).toMatchObject({ verdict, streaming: false });
    }
  });

  it('a token arriving after the round settled is dropped, not appended', () => {
    const settled = run([D('a'), H({ verdict: 'ok' }), F('a')]);
    expect(settled?.streaming).toBe(false);
    expect(applyCheckEvent(settled, D('a'))).toBe(settled);
  });

  it('a checkDone for a turn with no card invents nothing', () => {
    expect(applyCheckEvent(null, F('全文'))).toBe(null);
  });

  it('the first token of round 2 supersedes round 1’s card', () => {
    const c = run([D('r1', 1), H({ turn: 1 }), F('r1', 1), D('r2 ', 2)]);
    expect(c).toMatchObject({ turn: 2, verdict: 'unknown', text: 'r2 ', streaming: true });
  });

  it('a late header from another turn does not merge into this turn’s card', () => {
    const c = run([D('本轮', 2), H({ turn: 1, verdict: 'ok' })]);
    expect(c).toMatchObject({ turn: 1, verdict: 'ok', text: '', streaming: false });
  });

  it('the pure region stays pure: no DOM, no timers, no touch()', () => {
    const { region } = loadCheckMachine();
    expect(region).not.toMatch(/document|heroBody|innerHTML|setTimeout|touch\(/);
  });
});

/**
 * The two findings that live in app.js's wiring rather than in its reducer:
 * a late header must not invent a hero (review finding #1, Critical), and the
 * revision must never call the vendor renderer unguarded (review finding #2).
 */
describe('companion check-card wiring guards', () => {
  const src = readFileSync(new URL('../resources/companion/app.js', import.meta.url), 'utf8');

  it('all three check phases share one branch that requires the current hero id', () => {
    const at = src.indexOf("msg.phase === 'check' || msg.phase === 'checkDelta' || msg.phase === 'checkDone'");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, src.indexOf("msg.phase === 'error'", at));
    expect(branch).toMatch(/current && current\.id === msg\.id/);
    // the orphan rule: touch() would archive the live answer to re-render a
    // card that has already left the hero — which this code cannot do
    expect(branch).not.toMatch(/touch\(msg\.id/);
  });

  it('window.renderMarkdown has exactly one call site, behind the typeof fallback', () => {
    expect(src).toMatch(/typeof window\.renderMarkdown === 'function'/);
    expect((src.match(/window\.renderMarkdown\(/g) || []).length).toBe(1);
  });

  it('the revision body goes through mdHtml, the note through escapeHtml', () => {
    expect(src).toMatch(/<div class="x-check-body">\$\{mdHtml\(c\.text\)\}/);
    expect(src).toMatch(/<div class="x-check-note">\$\{escapeHtml\(c\.note\)\}/);
  });

  it('token growth paints plain text — the settled answer above is not re-typeset every flush', () => {
    const at = src.indexOf('function paintCheck');
    const body = src.slice(at, src.indexOf('function typeset'));
    expect(at).toBeGreaterThan(-1);
    expect(body).toContain("body.textContent = a.check.text");
    expect(src).toMatch(/<div class="x-check-body x-check-plain">/);
  });

  it('a provisional card cannot spin forever: idle watchdog, new ask, archive all close it', () => {
    expect(src).toMatch(/function armCheckIdle\(id, turn\)/);
    // the timer only touches the card it was armed for
    expect(src).toMatch(/current\.id === id && current\.check && current\.check\.turn === turn/);
    // the start of a new ask drops it with the old hero object
    const ask = src.slice(src.indexOf('function newAnswer'), src.indexOf('function touch('));
    expect(ask).toMatch(/clearCheckIdle\(\)/);
  });

  it('archiving closes a still-streaming check card — no frozen spinner in the feed', () => {
    const at = src.indexOf('function archiveCurrent');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toMatch(/a\.check && a\.check\.streaming/);
    expect(body).toMatch(/streaming: false/);
  });

  it('the phone names a friendly line for every refusal code the desktop can send', () => {
    // a code the table misses still shows as 电脑拒绝：<code> (visible, not
    // swallowed), but the stale-answer refusal is the one that explains a
    // press that deliberately spent nothing — pin every ExamCheckRefusal code
    expect(src).toMatch(/exam_check_no_context:/);
    expect(src).toMatch(/exam_check_busy:/);
    expect(src).toMatch(/exam_check_stale:/);
  });

  it('the 错因 input clears after send and answers to Enter, like its sibling askInput', () => {
    // a stale 错因 from question N would silently steer the checker for N+1:
    // it corrupts the round's input, not just the UX. sendAsk set the pattern.
    const at = src.indexOf('function sendCheck');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body).toMatch(/examCheckHint\.value = ''/);
    expect(body).toMatch(/examCheckHint\.blur\(\)/);
    expect(src).toMatch(/examCheckHint[\s\S]{0,120}addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Enter'\) sendCheck\(\); \}\)/);
  });
});

/**
 * Empty-id notes (Important 1): requestExamCheck's no-context refusal is the
 * only exam event the main process emits with `requestId: ''`. It is a
 * panel-level message — routed through the touch()/newAnswer() pipeline it
 * would archive a live streaming answer mid-flight and open its own hero,
 * the exact hijack the check-phase orphan rule was built to prevent.
 */
describe('companion note routing (app.js, fenced pure region)', () => {
  const route = loadNoteRouter();

  it('an empty-id note is panel-level, never an answer mutation', () => {
    expect(route({ id: '', text: '电脑上还没有做完的题可复核' })).toBe('panel');
    expect(route({ text: '缺省 id 同样按面板处理' })).toBe('panel');
  });

  it('a real answer note still attaches to its answer', () => {
    expect(route({ id: 'q42', text: '题干有歧义' })).toBe('answer');
  });

  it('the pure region stays pure: no DOM, no touch()', () => {
    const src = readFileSync(new URL('../resources/companion/app.js', import.meta.url), 'utf8');
    expect(extractRegion(src, 'NOTE_MARK')).not.toMatch(/document|heroBody|innerHTML|setTimeout|touch\(/);
  });

  it('the wiring consults the router before touch can invent a hero', () => {
    const src = readFileSync(new URL('../resources/companion/app.js', import.meta.url), 'utf8');
    const at = src.indexOf("msg.phase === 'note'");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, src.indexOf("msg.phase === 'delta'", at));
    const guard = branch.indexOf("examNoteRoute(msg) === 'panel'");
    expect(guard).toBeGreaterThan(-1);
    expect(branch.indexOf('note(msg.text)')).toBeLessThan(branch.indexOf('touch(msg.id'));
  });
});

/**
 * The one deliberate duplication in the fence feature: shared/codeFences.ts
 * (desktop segmenter) and the fence walk inside resources/companion/markdown.js
 * (phone renderer) implement the same contract by hand — same FENCE regex, same
 * close rule (same char, at least as long, empty info tail), same edge-blank
 * trim, same unterminated-closes-at-EOF. Nothing type-checks them together, so
 * every fixture runs through BOTH and the two must agree on what is code and
 * what is prose. Edit one side into a divergence and this table goes red.
 */
describe('fence fixtures agree across desktop shared/codeFences and phone markdown.js', () => {
  const FIXTURES: Array<[string, string]> = [
    ['prose around a cpp block', '思路一句话\n```cpp\nint main(){}\n```\n复杂度 O(n)'],
    ['edge blank lines trimmed, indentation kept', '```python\n\n\ndef f(x):\n    return x\n\n```'],
    ['unterminated fence eats the rest of the input', '```java\nclass A {'],
    ['tilde fence closes with tildes', '~~~go\npackage main\n~~~'],
    ['backtick fence is not closed by tildes', '```\n~~~\n```'],
    ['longer marker with a prose tail stays inside', '```\necho $((a+b))\n```` not a close\n```'],
    ['a closing marker with an info string is code, not close', '```cpp\nint x;\n```cpp\ny=1\n```'],
    ['CRLF normalises before splitting', 'a\r\n```py\r\nx=1\r\n```\r\nb\r\n```py\r\ny=2\r\n```'],
    ['prototype-named tag is still just a language label', '```constructor\nclass Hack { }\n```'],
    ['four-space indent is beyond the 3-space allowance', '前一行\n    ```\nnot code anywhere\n    ```\n后一行'],
    ['html-ish code is carried as code, not prose', '```ts\nconst a = "<b> & \'x\'";\n```'],
    ['a bare trailing fence opens an empty block', 'a\n```'],
    ['two blocks back to back', '```py\nx=1\n```\n```py\ny=2\n```'],
  ];
  const md = loadRenderer();
  const unescape = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  for (const [name, text] of FIXTURES) {
    it(name, () => {
      const desktop = splitCodeFences(text);
      const desktopCode = desktop
        .filter((s) => s.kind === 'code')
        .map((s) => ({ lang: s.kind === 'code' ? s.lang ?? '' : '', body: s.kind === 'code' ? s.body : '' }));
      const desktopProse = desktop
        .filter((s) => s.kind === 'prose')
        .flatMap((s) => (s.kind === 'prose' ? s.text.split('\n') : []))
        .map((l) => l.trim())
        .filter(Boolean);

      // every phone code block is exactly one html line (codeBlockHtml emits
      // no newlines inside the div) — that is what makes this split honest
      const lines = md(text).split('\n');
      const phoneCode = lines
        .filter((l) => l.startsWith('<div class="code-block"'))
        .map((l) => ({
          lang: /data-lang="([^"]*)"/.exec(l)?.[1] ?? '',
          body: [...l.matchAll(/<span class="code-line">([^<]*)<\/span>/g)]
            .map((m) => unescape(m[1]))
            .join('\n'),
        }));
      const phoneProse = lines
        .filter((l) => !l.startsWith('<div class="code-block"'))
        .map((l) => unescape(l.replace(/<[^>]+>/g, '')).trim())
        .filter(Boolean);

      expect({ code: phoneCode, prose: phoneProse }).toEqual({ code: desktopCode, prose: desktopProse });
    });
  }
});
