# 做题模式 · 算法题提示词契约、复核订正与代码块显示 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让算法题的模型答案带上可解析的输出契约、生成后自动复核订正，并在手机（双屏显示面）与桌面做题窗口里以等宽、横向滚动、可换行的代码块正确显示。

**Architecture:** 三个无 DOM 的纯逻辑模块（`shared/codeFences.ts` 切段、`shared/highlight.ts` 分词着色、`shared/answerCheck.ts` 解析复核输出）承担全部可测逻辑；渲染层各自消费它们（桌面 React `CodeBlock` + `MathText`，手机 vanilla `markdown.js` + `app.js`）；复核作为 `runExamAsk` 之后的第二个流式回合，走同一 `requestId` 的新 `check*` 事件族，并由手机控制区两个新 op 驱动。

**Tech Stack:** Electron 41 + electron-vite 3、TypeScript 5.8、React 19、vitest 3（node 环境）、vanilla JS 手机页。

**Spec:** `docs/superpowers/specs/2026-10-11-exam-algo-code-display-design.md`（本计划逐条对应它的 §3-§11）

## Global Constraints

每个任务都隐含遵守以下条款，值一律从 spec 与仓库现状逐字抄来：

- **不新增任何 npm 依赖。** `package.json:47-73` 是全部依赖与 devDependencies，本计划不往里面加一项（不引 highlight.js、不引 jsdom、不引 @testing-library）。
- **测试只有 node 环境。** `npm test` = `vitest run`，仓库没有 DOM/React 测试框架。因此组件层（`CodeBlock.tsx`、`ExamApp.tsx`、`app.js`）的验收靠 `npm run typecheck` + `npm run build` + 明确写出的真机/真浏览器步骤，**不要为组件临时发明测试框架**。可断言的逻辑一律先下沉到 `shared/*.ts` 纯函数再测。
- **验证命令：** `npm run typecheck`（= `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json`）、`npm test`、`npm run verify`（三者串起来）。每个任务收尾必须 `typecheck` + `test` 全绿。
- **安全模型不变：先转义，再生成标记。** 任何新渲染路径都必须逐段转义后才包标签，与 `shared/markdownLite.ts:24-26`、`resources/companion/markdown.js:4-7` 一致。禁止 `innerHTML` 未转义内容。
- **中文文案必须同时进两套字典。** `src/exam/i18n.ts`（zh 块 ~`:29-46`、en 块 ~`:104-121`）与 `src/i18n.tsx`（zh ~`:687`、en ~`:1472`）都要改，只改一边算未完成。
- **`chatStream` 的参数顺序：** `chatStream(config, messages, callbacks, signal?, opts?)`（`electron/llm/adapter.ts:172-178`）。`temperature` 在第 5 个参数 `opts` 里，**不是** callbacks。
- **不许碰的东西：** `PROVIDER_PRESETS` 的 `recommended` 标记、面试侧 byte-stable prefix（`test/llm.spec.ts:266-420` 有契约）、`shared/lexicalIndex.ts` 的任何阈值、题库直答分支（`electron/main.ts:2076`）。
- **不做本地执行/编译校验模型生成的代码**（spec §2 非目标：截屏内容 → 执行是 prompt-injection 到 RCE 的直路）。
- 每个任务结束时单独 `git commit`，一次一个可交付物。

---

### Task 1: `shared/codeFences.ts` — 把答案切成散文段与代码段

**Files:**
- Create: `shared/codeFences.ts`
- Test: `test/codeFences.spec.ts`

**Interfaces:**
- Consumes: 无（纯新增）
- Produces:
  - `type AnswerSeg = { kind: 'prose'; text: string } | { kind: 'code'; lang?: string; body: string }`
  - `splitCodeFences(text: string): AnswerSeg[]`
  - `codeFileExt(lang: string | undefined, fallback?: string): string`（`'cpp'` → `'cpp'`；未知 → `'txt'`）

- [ ] **Step 1: 写失败的测试**

创建 `test/codeFences.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { codeFileExt, splitCodeFences } from '../shared/codeFences';

describe('splitCodeFences', () => {
  it('returns nothing for empty text', () => {
    expect(splitCodeFences('')).toEqual([]);
  });

  it('leaves fence-free text as one prose segment, byte for byte', () => {
    const text = '先给结论：B\n\n依据有两点\n- 一\n- 二';
    expect(splitCodeFences(text)).toEqual([{ kind: 'prose', text }]);
  });

  it('splits prose around a fenced block and keeps the language tag', () => {
    const segs = splitCodeFences('思路一句话\n```cpp\nint main(){}\n```\n复杂度 O(n)');
    expect(segs).toEqual([
      { kind: 'prose', text: '思路一句话' },
      { kind: 'code', lang: 'cpp', body: 'int main(){}' },
      { kind: 'prose', text: '复杂度 O(n)' },
    ]);
  });

  it('preserves indentation and blank lines inside the block, trimming block edges', () => {
    const segs = splitCodeFences('```python\n\ndef f(x):\n    return x\n\n```');
    expect(segs[0]).toEqual({ kind: 'code', lang: 'python', body: 'def f(x):\n    return x' });
  });

  it('treats an unterminated fence as code all the way to the end', () => {
    const segs = splitCodeFences('```java\nclass A {\n  int x;');
    expect(segs).toEqual([{ kind: 'code', lang: 'java', body: 'class A {\n  int x;' }]);
  });

  it('accepts tilde fences and requires the same marker to close', () => {
    expect(splitCodeFences('~~~go\npackage main\n~~~')).toEqual([
      { kind: 'code', lang: 'go', body: 'package main' },
    ]);
    // a backtick fence is not closed by tildes: the tildes are part of the code
    expect(splitCodeFences('```\n~~~\n```')).toEqual([{ kind: 'code', lang: undefined, body: '~~~' }]);
  });

  it('keeps a fence marker and dollar signs inside the block out of the prose passes', () => {
    const segs = splitCodeFences('```\necho $((a+b))\n```` not a close\n```');
    expect(segs[0]).toEqual({ kind: 'code', lang: undefined, body: 'echo $((a+b))\n```` not a close' });
  });

  it('handles CRLF and multiple blocks', () => {
    const segs = splitCodeFences('a\r\n```py\r\nx=1\r\n```\r\nb\r\n```py\r\ny=2\r\n```');
    expect(segs.map((s) => s.kind)).toEqual(['prose', 'code', 'prose', 'code']);
    expect((segs[1] as { body: string }).body).toBe('x=1');
  });
});

describe('codeFileExt', () => {
  it('maps the languages the answer contract allows', () => {
    expect(codeFileExt('cpp')).toBe('cpp');
    expect(codeFileExt('C++')).toBe('cpp');
    expect(codeFileExt('typescript')).toBe('ts');
    expect(codeFileExt('python3')).toBe('py');
  });

  it('falls back to txt for an unknown or missing tag', () => {
    expect(codeFileExt('brainfuck')).toBe('txt');
    expect(codeFileExt(undefined)).toBe('txt');
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run test/codeFences.spec.ts`
Expected: FAIL — `Failed to load ../shared/codeFences`（文件还不存在）

- [ ] **Step 3: 写最小实现**

创建 `shared/codeFences.ts`：

```ts
/**
 * Answer text → prose segments + code segments.
 *
 * The answer pane used to be one pre-wrap blob, so a model-emitted ``` fence
 * showed its own backticks and the code inside lost every monospace property
 * (shared/markdownLite.ts:8-11 declares block structure out of scope). This
 * splits the block out BEFORE any inline markup runs, which also keeps a shell
 * `$((a+b))` from reaching the math splitter (shared/mathSplit.ts:23).
 *
 * Deliberately generates no HTML: escaping stays the job of each renderer, so
 * nothing here can be double-escaped. Pure, no DOM.
 */

export type AnswerSeg =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; lang?: string; body: string };

/** ` ```lang ` / `~~~lang` at line start, up to 3 leading spaces like CommonMark */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]*)[ \t]*$/;

const LANG_EXT: Record<string, string> = {
  cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'hpp',
  c: 'c', h: 'h',
  java: 'java',
  python: 'py', python3: 'py', py: 'py',
  javascript: 'js', js: 'js', jsx: 'jsx',
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  go: 'go', golang: 'go',
  rust: 'rs', rs: 'rs',
  sql: 'sql', sh: 'sh', bash: 'sh', shell: 'sh',
};

/** the file extension a downloaded snippet should get; unknown tags are not an error */
export function codeFileExt(lang: string | undefined, fallback = 'txt'): string {
  const key = (lang ?? '').trim().toLowerCase();
  return LANG_EXT[key] ?? fallback;
}

function trimBlankEdges(lines: string[]): string {
  let from = 0;
  let to = lines.length;
  while (from < to && !lines[from].trim()) from++;
  while (to > from && !lines[to - 1].trim()) to--;
  return lines.slice(from, to).join('\n');
}

export function splitCodeFences(text: string): AnswerSeg[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const segs: AnswerSeg[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    // whitespace-only runs between two blocks carry no information; a real
    // paragraph keeps its blank lines untouched so pre-wrap still lays it out
    if (prose.some((l) => l.trim())) segs.push({ kind: 'prose', text: prose.join('\n') });
    prose = [];
  };

  // one cursor, advanced by both loops: a `for` whose body also moves `i` is how
  // an unterminated fence turns into an infinite loop
  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      i++;
      continue;
    }
    flushProse();
    const marker = open[1];
    const lang = open[2] ? open[2].toLowerCase() : undefined;
    const body: string[] = [];
    for (i++; i < lines.length; i++) {
      const close = FENCE.exec(lines[i]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length && close[2] === '') {
        i++;
        break;
      }
      body.push(lines[i]);
    }
    segs.push({ kind: 'code', lang, body: trimBlankEdges(body) });
  }
  flushProse();
  return segs;
}
```

注意 `codeFileExt` 与 `LANG_EXT` 用同一套小写键；`'C++'` 能命中是因为 `LANG_EXT` 里有 `'c++'` 这个键。

- [ ] **Step 4: 再跑测试确认通过**

Run: `npx vitest run test/codeFences.spec.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: 全量校验并提交**

```bash
npm run typecheck && npm test
git add shared/codeFences.ts test/codeFences.spec.ts
git commit -m "feat(exam): split answer text into prose and fenced code segments

代码块此前会被 markdownLite 当散文渲染（连围栏反引号一起显示），切段先于
任何行内标记，顺带让 shell 的 $((a+b)) 不再进入公式分割器。"
```

---

### Task 2: `shared/highlight.ts` — 六语言分词着色

**Files:**
- Create: `shared/highlight.ts`
- Test: `test/highlight.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type TokenKind = 'kw' | 'str' | 'num' | 'cmt' | 'pre' | 'plain'`
  - `interface Token { kind: TokenKind; text: string }`
  - `tokenizeCode(code: string, lang: string | undefined): Token[]`
  - `SUPPORTED_LANGS: readonly string[]`（`CodeBlock` 与 `markdown.js` 都靠它决定标签显示）

- [ ] **Step 1: 写失败的测试**

创建 `test/highlight.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGS, tokenizeCode, type TokenKind } from '../shared/highlight';

const joined = (src: string, lang: string | undefined): string =>
  tokenizeCode(src, lang).map((t) => t.text).join('');
const kindOf = (src: string, lang: string | undefined, word: string): TokenKind | undefined =>
  tokenizeCode(src, lang).find((t) => t.text === word)?.kind;

describe('tokenizeCode', () => {
  it('classifies keywords, numbers and strings in a cpp line', () => {
    const src = 'int x = 123;';
    expect(joined(src, 'cpp')).toBe(src);
    expect(kindOf(src, 'cpp', 'int')).toBe('kw');
    expect(kindOf(src, 'cpp', '123')).toBe('num');
    expect(kindOf(src, 'cpp', 'x')).toBe('plain');
  });

  it('keeps a whole line comment as one token, keywords inside it included', () => {
    const src = '// return the int\nx';
    expect(joined(src, 'cpp')).toBe(src);
    expect(kindOf(src, 'cpp', '// return the int')).toBe('cmt');
    // `return` inside the comment must not surface as its own keyword token
    expect(tokenizeCode(src, 'cpp').some((t) => t.kind === 'kw' && t.text === 'return')).toBe(false);
  });

  it('does not treat a keyword substring as a keyword', () => {
    expect(joined('printf', 'cpp')).toBe('printf');
    expect(tokenizeCode('printf', 'cpp').some((t) => t.kind === 'kw')).toBe(false);
  });

  it('keeps an escaped quote and a brace inside one string token', () => {
    const src = 'const s = "a\\"b{"';
    expect(joined(src, 'javascript')).toBe(src);
    expect(kindOf(src, 'javascript', '"a\\"b{"')).toBe('str');
  });

  it('marks python triple-quoted strings and cpp preprocessor lines', () => {
    const py = '"""doc\nline"""\nreturn 1';
    expect(joined(py, 'python')).toBe(py);
    expect(kindOf(py, 'python', '"""doc\nline"""')).toBe('str');
    expect(kindOf('#include <cstring>', 'cpp', '#include')).toBe('pre');
  });

  it('emits only generic tokens for an unknown language, never guesses keywords', () => {
    const src = 'def x = "s" // c';
    expect(joined(src, 'brainfuck')).toBe(src);
    expect(tokenizeCode(src, 'brainfuck').some((t) => t.kind === 'kw')).toBe(false);
    expect(kindOf(src, 'brainfuck', '"s"')).toBe('str');
    expect(kindOf(src, 'brainfuck', '// c')).toBe('cmt');
  });

  it('never produces an empty token', () => {
    const src = 'func main() {\n  a := 1 // one\n}\n';
    expect(tokenizeCode(src, 'go').every((t) => t.text.length > 0)).toBe(true);
    expect(joined(src, 'go')).toBe(src);
  });

  it('survives CRLF and a lone dollar sign', () => {
    const src = 'if ($x -gt 0) {\r\n  echo $((a+b))\r\n}';
    expect(joined(src, 'sh')).toBe(src);
  });
});

describe('SUPPORTED_LANGS', () => {
  it('covers every language the answer contract allows', () => {
    for (const lang of ['cpp', 'java', 'python', 'javascript', 'typescript', 'go']) {
      expect(SUPPORTED_LANGS).toContain(lang);
    }
  });
});
```

断言的写法是有意的：**只钉"文本能无损拼回 + 四类语义正确"，不钉 token 的切分方式**。把 `plain:  | plain:x = | num:123` 这种切法写进断言，等于把实现细节变成契约，之后任何一次合并相邻 plain 都会误报失败。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run test/highlight.spec.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

创建 `shared/highlight.ts`。这是本任务的全部逻辑，一次写完整：

```ts
/**
 * A ~100-line tokenizer for the handful of languages a live-coding answer
 * actually arrives in. Chosen over highlight.js because that would mean
 * vendoring third-party code into the phone page (which is served as a plain
 * script), a size cost this branch has been actively shaving, and a library
 * that emits its own HTML. Every token here is handed to the renderer as raw
 * text — the caller escapes it (spec §7.2).
 *
 * Accuracy is capped on purpose: nested template angle brackets or an f-string
 * may colour slightly wrong, which is a cosmetic miss, not a broken answer.
 */

export type TokenKind = 'kw' | 'str' | 'num' | 'cmt' | 'pre' | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
}

export const SUPPORTED_LANGS = ['cpp', 'c', 'java', 'python', 'javascript', 'typescript', 'go', 'rust'] as const;

const KW = {
  cpp: 'alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while true false null',
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while yield with True False None self',
  javascript: 'async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield true false null undefined',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota make new len cap append copy delete panic recover',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct trait true type unsafe use where while async await dyn let mod pub ref self',
};
KW.c = KW.cpp;
KW.typescript = `${KW.javascript} type interface enum namespace declare readonly public private protected abstract implements any string number boolean never unknown`;

interface LangSpec {
  keywords: Set<string>;
  line: string[];
  block?: [string, string];
  hashBang: boolean;
  preproc: boolean;
  triple: boolean;
}

const SPECS: Record<string, LangSpec> = {};
for (const lang of SUPPORTED_LANGS) {
  SPECS[lang] = {
    keywords: new Set((KW as Record<string, string>)[lang].split(' ')),
    line: lang === 'python' ? ['#'] : ['//'],
    block: lang === 'python' ? undefined : ['/*', '*/'],
    hashBang: lang === 'python',
    preproc: lang === 'cpp' || lang === 'c',
    triple: lang === 'python',
  };
}

/** the generic spec used when the fence tag is not one of ours: no keyword guessing */
const GENERIC: LangSpec = { keywords: new Set(), line: ['//', '#'], block: ['/*', '*/'], hashBang: false, preproc: false, triple: false };

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

function matchAt(src: string, i: number, needle: string): boolean {
  return src.startsWith(needle, i);
}

function scanLineComment(src: string, i: number, marker: string): number {
  const nl = src.indexOf('\n', i);
  return nl === -1 ? src.length : nl;
}

function scanBlockComment(src: string, i: number, open: string, close: string): number {
  const end = src.indexOf(close, i + open.length);
  return end === -1 ? src.length : end + close.length;
}

/** returns the index just past the string literal, or -1 if this quote does not open one */
function scanString(src: string, i: number, spec: LangSpec): number {
  const ch = src[i];
  if (spec.triple && (ch === '"' || ch === "'") && src[i + 1] === ch && src[i + 2] === ch) {
    const fence = ch.repeat(3);
    const end = src.indexOf(fence, i + 3);
    return end === -1 ? src.length : end + 3;
  }
  if (ch !== '"' && ch !== "'" && ch !== '`') return -1;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === ch) return j + 1;
    // an unterminated single-quote run ends at the newline: treating it as a
    // string to the end of file would colour the rest of the answer
    if (src[j] === '\n' && ch !== '`') return -1;
    j++;
  }
  return ch === '`' ? src.length : -1;
}

function scanNumber(src: string, i: number): number {
  let j = i;
  while (j < src.length && /[0-9a-fA-FxXoObB._]/.test(src[j])) j++;
  return j;
}

export function tokenizeCode(code: string, lang: string | undefined): Token[] {
  const spec = (lang && SPECS[lang]) || GENERIC;
  const out: Token[] = [];
  let plain = '';
  const pushPlain = (): void => {
    if (plain) {
      out.push({ kind: 'plain', text: plain });
      plain = '';
    }
  };
  const emit = (kind: TokenKind, text: string): void => {
    pushPlain();
    out.push({ kind, text });
  };

  let i = 0;
  if (spec.hashBang && code.startsWith('#!')) {
    const end = scanLineComment(code, 0, '#');
    emit('cmt', code.slice(0, end));
    i = end;
  }
  while (i < code.length) {
    const ch = code[i];

    if (spec.preproc && ch === '#' && (i === 0 || code[i - 1] === '\n')) {
      const end = scanLineComment(code, i, '#');
      emit('pre', code.slice(i, end));
      i = end;
      continue;
    }
    const lineHit = spec.line.find((m) => matchAt(code, i, m));
    if (lineHit) {
      const end = scanLineComment(code, i, lineHit);
      emit('cmt', code.slice(i, end));
      i = end;
      continue;
    }
    if (spec.block && matchAt(code, i, spec.block[0])) {
      const end = scanBlockComment(code, i, spec.block[0], spec.block[1]);
      emit('cmt', code.slice(i, end));
      i = end;
      continue;
    }
    const strEnd = scanString(code, i, spec);
    if (strEnd > i) {
      emit('str', code.slice(i, strEnd));
      i = strEnd;
      continue;
    }
    if (isDigit(ch)) {
      const end = scanNumber(code, i);
      emit('num', code.slice(i, end));
      i = end;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < code.length && isIdentPart(code[j])) j++;
      const word = code.slice(i, j);
      if (spec.keywords.has(word)) emit('kw', word);
      else plain += word;
      i = j;
      continue;
    }
    plain += ch;
    i++;
  }
  pushPlain();
  return out;
}
```

`emit()` 内部先 `pushPlain()`，所以关键字/字符串/注释前后的普通文本会自动断开；非关键字标识符直接并进 `plain` 缓冲，不产生额外 token。分支顺序按现在这样即可：`isDigit` 只在字符本身是数字时进入，`int64` 从 `i` 起走的是 identifier 分支，会被完整吃掉。`scanNumber` 的字符类偏贪（`1.2.3`、`0xFFu` 都会并成一个 `num`），这是外观层面的取舍，不影响无损拼回。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/highlight.spec.ts`
Expected: PASS

- [ ] **Step 5: 全量校验并提交**

```bash
npm run typecheck && npm test
git add shared/highlight.ts test/highlight.spec.ts
git commit -m "feat(exam): tiny in-house tokenizer for answer code blocks

不引 highlight.js：手机页是纯静态脚本，第三方库要 vendor、体积要实测、
且它自己生成 HTML 得再审计一遍转义行为。未知语言只出通用 token，不猜关键字。"
```

---

### Task 3: 桌面代码块渲染 — `CodeBlock` + `MathText` 接线 + `exam.css`

**Files:**
- Create: `src/components/CodeBlock.tsx`
- Create: `src/components/codeblock.css`
- Modify: `src/components/MathText.tsx:33-48`
- Test: 无新增单测（逻辑已在 Task 1/2）；靠 `typecheck` + `build` + Step 5 真机

**Interfaces:**
- Consumes: `splitCodeFences` / `codeFileExt`（Task 1）、`tokenizeCode`（Task 2）
- Produces: `CodeBlock({ lang, code, labels })`；`interface CodeBlockLabels { wrap: string; copy: string; copied: string; download: string }`（默认中文，由调用方按界面语言覆盖）；DOM 契约（Task 4 手机端与验收脚本按它选择器）：
  - `.code-block[data-lang]` > `.code-bar` > `.code-lang` + `button.code-ctrl.code-wrap[aria-pressed]` + `button.code-ctrl.code-copy` + `button.code-ctrl.code-dl`
  - `.code-block > pre.code-pre > code > span.tok-kw|.tok-str|.tok-num|.tok-cmt|.tok-pre`
  - 换行态：`.code-block.wrap`

- [ ] **Step 1: 写组件**

创建 `src/components/CodeBlock.tsx`：

```tsx
import { useMemo, useState } from 'react';
import { codeFileExt } from '../../shared/codeFences';
import { tokenizeCode } from '../../shared/highlight';
import './codeblock.css';

/**
 * One fenced block from an exam answer, laid out like the DeepSeek web client's
 * code block: language tag top-left, actions top-right, no line numbers,
 * indentation untouched.
 *
 * Wide lines scroll sideways by default — the previous behaviour was a
 * word-break in the middle of an identifier. The 换行 toggle switches to soft
 * wrapping with a hanging indent, which is the option that has to win when the
 * window is 380px wide and the reader would rather see the whole line.
 */

const TOK_CLASS: Record<string, string> = {
  kw: 'tok-kw',
  str: 'tok-str',
  num: 'tok-num',
  cmt: 'tok-cmt',
  pre: 'tok-pre',
  plain: '',
};

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface CodeBlockLabels {
  wrap: string;
  copy: string;
  copied: string;
  download: string;
}

const ZH: CodeBlockLabels = { wrap: '换行', copy: '复制', copied: '已复制', download: '下载' };

export function CodeBlock({ lang, code, labels = ZH }: { lang?: string; code: string; labels?: CodeBlockLabels }) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const tokens = useMemo(() => tokenizeCode(code, lang), [code, lang]);

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={`code-block${wrap ? ' wrap' : ''}`} data-lang={lang ?? ''}>
      <div className="code-bar">
        <span className="code-lang">{lang || 'code'}</span>
        <button
          type="button"
          className="code-ctrl code-wrap"
          aria-pressed={wrap}
          onClick={() => setWrap((v) => !v)}
        >
          {labels.wrap}
        </button>
        <button type="button" className="code-ctrl code-copy" onClick={copy}>
          {copied ? labels.copied : labels.copy}
        </button>
        <button
          type="button"
          className="code-ctrl code-dl"
          onClick={() => downloadText(`answer.${codeFileExt(lang)}`, code)}
        >
          {labels.download}
        </button>
      </div>
      <pre className="code-pre">
        <code>
          {tokens.map((t, i) =>
            TOK_CLASS[t.kind] ? <span key={i} className={TOK_CLASS[t.kind]}>{t.text}</span> : <span key={i}>{t.text}</span>,
          )}
        </code>
      </pre>
    </div>
  );
}
```

React 对 `<pre>` 里的文本子节点会原样保留空白，`tokenizeCode` 保证拼接等于原文（Task 2 有断言），所以不配 `dangerouslySetInnerHTML`。

- [ ] **Step 2: 接进 MathText**

把 `src/components/MathText.tsx:33-48` 的 `MathText` 改为（多一个可选的 `codeLabels`，转发给 `CodeBlock`）：

```tsx
export function MathText({ text, codeLabels }: { text: string; codeLabels?: CodeBlockLabels }) {
  const segs = useMemo(() => splitCodeFences(text), [text]);
  return (
    <>
      {segs.map((seg, i) =>
        seg.kind === 'code' ? (
          <CodeBlock key={i} lang={seg.lang} code={seg.body} labels={codeLabels} />
        ) : (
          <ProseText key={i} text={seg.text} />
        ),
      )}
    </>
  );
}
```

并把原来 `segs.map(...)` 里那段（`splitMath` + 两个 `dangerouslySetInnerHTML` 分支）原样搬进同文件的 `function ProseText({ text }: { text: string })`。`ProseText` 的渲染逻辑与 key 规则一字不改——这是"没有围栏的存量答案输出不变"的落点。

- [ ] **Step 3: 加样式（组件自带表，不放进 exam.css）**

`.code-*` 规则**必须**住在 `src/components/codeblock.css` 里，由 `CodeBlock.tsx` 顶部 `import './codeblock.css';` 引入。理由：`MathText` 同时被做题窗口（`src/exam/ExamApp.tsx`）和面试窗口（`src/components/prompt/PromptFocus.tsx`）使用，而 `exam.css` 只在做题窗口加载——写在 exam.css 里的话面试窗口的代码块会**没有 `overflow-x`、没有条、没有配色**，等于把这次的显示修复做成只对一半界面生效。

创建 `src/components/codeblock.css`：

```css
/* Component-owned sheet: MathText serves both the exam window and the
   interview window, so the code-block styles cannot live in exam.css —
   the interview window never loads that file. */

:root {
  --mono: ui-monospace, Menlo, Consolas, 'Cascadia Mono', 'Noto Sans Mono CJK SC', monospace;
  --code-bg: #0d1117;
  --code-bar: rgba(255, 255, 255, 0.06);
  --code-line: rgba(255, 255, 255, 0.1);
  --code-kw: #c586c0;
  --code-str: #ce9178;
  --code-num: #b5cea8;
  --code-cmt: #7d8794;
  --code-pre: #d69d85;
  --code-accent: #9dc0ff;
}

html[data-theme='light'] {
  --code-bg: #f4f6fa;
  --code-bar: rgba(20, 30, 50, 0.04);
  --code-line: rgba(20, 30, 50, 0.14);
  --code-kw: #8a2be2;
  --code-str: #a31515;
  --code-num: #098658;
  --code-cmt: #6a737d;
  --code-pre: #8b3a00;
  --code-accent: #1b4fc0;
}

.code-block {
  margin: 6px 0;
  background: var(--code-bg);
  border: 1px solid var(--code-line);
  border-radius: 8px;
  overflow: hidden;
}

.code-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--code-bar);
  border-bottom: 1px solid var(--code-line);
}

.code-lang {
  margin-right: auto;
  font: 11px/1.4 var(--mono);
  color: var(--code-cmt);
}

.code-ctrl {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid var(--code-line);
  background: transparent;
  color: var(--code-accent);
  cursor: pointer;
}

.code-ctrl[aria-pressed='true'] {
  background: #2563eb;
  color: #fff;
}

.code-pre {
  padding: 10px 12px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.code-pre code {
  display: block;
  font: 0.92em/1.6 var(--mono);
  white-space: pre;
  tab-size: 4;
}

.code-block.wrap .code-pre code {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  padding-left: 1.4em;
  text-indent: -1.4em;
}

.code-block.wrap .code-pre code > span:first-child {
  text-indent: 0;
}

.tok-kw { color: var(--code-kw); }
.tok-str { color: var(--code-str); }
.tok-num { color: var(--code-num); }
.tok-cmt { color: var(--code-cmt); font-style: italic; }
.tok-pre { color: var(--code-pre); }
```

`src/exam/exam.css` 本次**不需要**加代码块规则（只保留既有的 `.exam-a`）。`.exam-a`（`:158-166`）保持 `white-space: pre-wrap` 不动——它现在只管散文段，`user-select: text` 已有（`:164`），代码可选中复制。

- [ ] **Step 4: 类型与构建**

```bash
npm run typecheck && npm run build
```
Expected: 全绿。`npm test` 也必须仍全绿（`test/markdownLite.spec.ts` 一行没改仍要过——它就是存量显示的回归护栏）。

- [ ] **Step 5: 真机看一屏**

```bash
npm run dev
```
在打开的做题窗口里按 `Ctrl+Alt+B`，粘一段含 120 列长行的 C++ 答案（用「自己输入」路径：`ExamApp` 的 typed-ask 按钮，题目写 `请给出两数之和的 C++ 解法`），确认：横向滚动条出现、缩进没塌、`换行` 切换后续行悬挂对齐、复制与下载可用。

- [ ] **Step 6: 提交**

```bash
git add src/components/CodeBlock.tsx src/components/codeblock.css src/components/MathText.tsx
git commit -m "feat(exam): render answer code blocks with horizontal scroll and wrap toggle

对齐 DeepSeek 网页端的代码块形态：语言标签在左上、操作在右上、无行号、
缩进原样。默认横向滚动而不是把 identifier 从中间折断。"
```

---

### Task 4: 手机端代码块显示 — `markdown.js` + CSS + 事件委托

**Files:**
- Modify: `resources/companion/markdown.js:72-117`
- Modify: `resources/companion/index.html:47,55-57,84-89`
- Modify: `resources/companion/app.js:254-260,331,334-337`
- Test: `test/companionMarkdown.spec.ts`（新增，用 `node:vm` 求值那个纯脚本）

**Interfaces:**
- Consumes: Task 1/2 的语义（同一套 DOM class 名，手机端自己实现，不 import TS）
- Produces: 与桌面一致的 DOM 契约：`<div class="code-block" data-lang><div class="code-bar">…<button class="code-ctrl code-wrap|code-copy|code-dl">…</div><pre class="code-pre"><code>…</code></pre></div>`；着色 span 用同一批 `.tok-*` class

- [ ] **Step 1: 写失败的测试**

创建 `test/companionMarkdown.spec.ts`：

```ts
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The phone page loads markdown.js as a plain script that hangs
 * renderMarkdown off `window`, so the only honest way to test it is to run it
 * the way the browser does.
 */
function loadRenderer(): (src: string) => string {
  const source = readFileSync(new URL('../resources/companion/markdown.js', import.meta.url), 'utf8');
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  runInContext(source, createContext(sandbox) as never);
  return (sandbox.window as { renderMarkdown: (s: string) => string }).renderMarkdown;
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
    expect(html).toContain('def f(x):\n    return x');
    expect(html).not.toContain('<pre class="code-pre"><code>\n\n');
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
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run test/companionMarkdown.spec.ts`
Expected: FAIL — 现有实现产出的是 `<pre><code>`，没有 `code-block` / `data-lang`

- [ ] **Step 3: 改 markdown.js**

把 `resources/companion/markdown.js:72-117` 的循环里三处围栏处理换成块级输出，并在文件内加两个本地 helper（放在 `renderInline` 之后）：

```js
const CODE_EXT = { cpp: 'cpp', c: 'c', java: 'java', python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', go: 'go', rust: 'rs' };

/** 语言标签 + 三个按钮；按钮不带 data 内容，代码文本从 <code> 里读，省一份转义 */
function codeBlockHtml(lang, bodyLines) {
  const code = trimBlankEdges(bodyLines);
  const ext = CODE_EXT[(lang || '').toLowerCase()] || 'txt';
  return (
    `<div class="code-block" data-lang="${escapeHtml(lang || '')}" data-ext="${ext}">` +
    '<div class="code-bar">' +
    `<span class="code-lang">${escapeHtml(lang || 'code')}</span>` +
    '<button type="button" class="code-ctrl code-wrap" aria-pressed="false">换行</button>' +
    '<button type="button" class="code-ctrl code-copy">复制</button>' +
    '<button type="button" class="code-ctrl code-dl">下载</button>' +
    '</div>' +
    `<pre class="code-pre"><code>${code}</code></pre></div>`
  );
}

function trimBlankEdges(lines) {
  let from = 0;
  let to = lines.length;
  while (from < to && !lines[from].trim()) from++;
  while (to > from && !lines[to - 1].trim()) to--;
  return lines.slice(from, to).join('\n');
}
```

`code` 变量已经是**整体转义之后**的行内容（`:59` 在 split 前 escapeHtml 了整个文本），所以块内不产生可注入标签——这条安全前提要在文件头注释里补一句，别让它被后人误改。

循环内：开栏时 `closeList(); inCode = true; codeBuffer = []; codeLang = ''` 并记住标记串；闭栏与收尾两处 `out.push(`<pre><code>…`)`) 都换成 `out.push(codeBlockHtml(codeLang, codeBuffer))`。闭栏判定沿用 Task 1 的规则（同种字符、不短于开栏、无语言尾巴）。

- [ ] **Step 4: 改 index.html 的 CSS**

删掉 `:55-57` 三条规则里的 `pre`/`pre code` 两条（`overflow:hidden` 与 `text-indent:-1.1em` 正是断行与错位的来源），换成与桌面同一套（值抄 Task 3 Step 3，颜色改用本页已有的 `#080808`/`#242424` 系）：

```css
  #heroBody .code-block{background:#0b0f14;border:1px solid #1f2a35;border-radius:.5rem;
                        margin:.45rem 0;overflow:hidden}
  #heroBody .code-bar{display:flex;align-items:center;gap:.4rem;padding:.3rem .55rem;
                      border-bottom:1px solid #1f2a35}
  #heroBody .code-lang{margin-right:auto;font:.72rem/1.4 var(--mono);color:#6f7c8c}
  #heroBody .code-ctrl{background:#161c24;color:var(--accent);border:1px solid #263140;
                       border-radius:.3rem;font-size:.7rem;padding:.12rem .45rem}
  #heroBody .code-ctrl[aria-pressed=true]{background:#2563eb;color:#fff}
  #heroBody .code-pre{margin:0;padding:.55rem .7rem;overflow-x:auto;
                      -webkit-overflow-scrolling:touch}
  #heroBody .code-pre code{display:block;background:none;padding:0;
                           font:.86rem/1.6 var(--mono);white-space:pre;tab-size:4}
  #heroBody .code-block.wrap .code-pre code{white-space:pre-wrap;overflow-wrap:break-word;
                                            padding-left:1.4em;text-indent:-1.4em}
  #heroBody .code-block.wrap .code-pre code > span:first-child{text-indent:0}
  #heroBody .tok-kw{color:#c586c0}#heroBody .tok-str{color:#ce9178}
  #heroBody .tok-num{color:#b5cea8}#heroBody .tok-cmt{color:#7d8794;font-style:italic}
  #heroBody .tok-pre{color:#d69d85}
```

并在 `:12-20` 的 `:root` 里加 `--mono:ui-monospace,Menlo,Consolas,'Cascadia Mono','Noto Sans Mono CJK SC',monospace;`。`.ans .body`（`:84-85`）的折叠保留，但加一条让含代码块的历史卡有提示：`.ans .more{display:none}` + `.ans.has-code .more{display:block}`。

- [ ] **Step 5: 改 app.js 的交互**

三处：

1. `:254-260` `appendDelta` 不动（流式期仍只写 `textContent`）。
2. `:331` 与 `:334-337` 的折叠豁免——两处 `if (e.target.tagName === 'A') return;` / 卡片 click 回调，统一改成先问一句：

```js
function onCodeCtrl(e) {
  const btn = e.target.closest && e.target.closest('.code-ctrl');
  if (!btn) return false;
  e.stopPropagation();
  const block = btn.closest('.code-block');
  const pre = block.querySelector('.code-pre code');
  if (btn.classList.contains('code-wrap')) {
    const on = block.classList.toggle('wrap');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  } else if (btn.classList.contains('code-copy')) {
    navigator.clipboard.writeText(pre.textContent).then(() => {
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    });
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([pre.textContent], { type: 'text/plain' }));
    a.download = `answer.${block.dataset.ext || 'txt'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return true;
}
```

在 `hero` 与列表容器上各挂一个委托 listener（`if (onCodeCtrl(e)) return;` 放在现有折叠逻辑之前），不给每个块绑 handler。

3. `renderHero`/`archiveCurrent` 里渲染完 `answerHtml(a)` 之后加一行：`el.classList.toggle('has-code', /class="code-block"/.test(html))`（hero 同理），并在 `archiveCurrent` 的 `innerHTML` 模板里补 `<div class="more">含代码，点按展开</div>`。

- [ ] **Step 6: 跑测试与构建**

```bash
npx vitest run test/companionMarkdown.spec.ts && npm run typecheck && npm test
```
Expected: 全绿

- [ ] **Step 7: 真浏览器验收（量像素，别只看 CSS 声明）**

```bash
npm run smoke:companion
```
拿到端口后用 browser-use 打开 `http://127.0.0.1:<port>/?token=…`。页内函数不在 window 上，所以临时在 `app.js` 末尾加一行调试钩子喂假答案，**这行不进提交**：

```js
window.__feed = (t) => { const a = newAnswer('probe', 'x'); a.text = t; finish('probe', 'x', t, 'model', 0); };
```

然后 `mcp__browser-use__evaluate_script` 里调 `window.__feed(...)` 喂一条含 120 列长行的 C++ 答案，再断言：

```js
const pre = document.querySelector('#heroBody .code-pre');
JSON.stringify({
  scrollW: pre.scrollWidth, clientW: pre.clientWidth,
  lineHeight: getComputedStyle(pre.querySelector('code')).lineHeight,
  whiteSpace: getComputedStyle(pre.querySelector('code')).whiteSpace,
});
```

Expected: `scrollW > clientW`（真的横向溢出可滚）、`whiteSpace === 'pre'`。再点一次 `.code-wrap`，断言 `whiteSpace === 'pre-wrap'` 且 `#hero` 没有多出 `collapsed` class（点按钮不折叠答案）。

- [ ] **Step 8: 提交**

```bash
git add resources/companion/markdown.js resources/companion/index.html resources/companion/app.js test/companionMarkdown.spec.ts
git commit -m "fix(companion): give phone code blocks real layout, controls and scroll

pre 的 overflow:hidden 加 pre-wrap/overflow-wrap:anywhere 会在标识符中间断行，
text-indent:-1.1em 让首行有缩进的代码整体错位；折叠按钮还会吃掉代码块上的点击。"
```

---

### Task 5: 提示词契约 — 算法题输出格式、复核提示、转录补强

**Files:**
- Modify: `electron/llm/examPrompts.ts:84-93`（追加契约）、`:35-63`（转录）、`:157-194`（新增导出）
- Test: `test/examPrompts.spec.ts`（新增）

**Interfaces:**
- Consumes: `ChatMessage`（`electron/llm/adapter.ts`）、`ExamSubMode`
- Produces:
  - `buildExamCheckMessages(input: ExamCheckInput): ChatMessage[]`
  - `interface ExamCheckInput { question: string; answer: string; hint?: string; priorNotes?: string[] }`
  - `export const CHECK_ANSWER_MAX_CHARS = 6000`

- [ ] **Step 1: 写失败的测试**

创建 `test/examPrompts.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildExamAskMessages, buildExamCheckMessages, CHECK_ANSWER_MAX_CHARS } from '../electron/llm/examPrompts';

const system = (mode: 'technical' | 'aptitude' | 'open' | 'personality'): string =>
  buildExamAskMessages({ subMode: mode, question: 'q' })[0].content as string;

describe('algorithm answer contract', () => {
  it('tells the model to fence its code and name the language', () => {
    const s = system('technical');
    expect(s).toContain('带语言标签的围栏块');
    expect(s).toContain('cpp / java / python / javascript / typescript / go');
  });

  it('demands the given signature be kept, so the snippet pastes into the judge', () => {
    expect(system('technical')).toContain('保留题目给定的函数签名');
  });

  it('caps what may sit outside the fence', () => {
    const s = system('technical');
    expect(s).toContain('块外只允许两行');
  });

  it('keeps the existing style rules untouched', () => {
    const s = system('technical');
    expect(s).toContain('第一行用一句话讲思路');
    expect(s).toContain('复杂度写在代码后面一行说明');
  });

  it('does not leak the contract into the other sub-modes', () => {
    for (const mode of ['aptitude', 'open', 'personality'] as const) {
      expect(system(mode)).not.toContain('围栏块');
    }
  });
});

describe('buildExamCheckMessages', () => {
  it('asks for a verdict line and nothing else when the answer is fine', () => {
    const [sys] = buildExamCheckMessages({ question: 'q', answer: 'a' });
    const content = sys.content as string;
    expect(content).toContain('VERDICT: OK');
    expect(content).toContain('VERDICT: FIX');
    expect(content).toContain('不要把能跑的代码改写成');
  });

  it('lists the five checks in order', () => {
    const content = buildExamCheckMessages({ question: 'q', answer: 'a' })[0].content as string;
    for (const probe of ['n=0/n=1', '能否编译', '复杂度与实现', '题目给定的签名', '第三方库']) {
      expect(content).toContain(probe);
    }
  });

  it('carries the question, the answer and the user hint into the user turn', () => {
    const [, user] = buildExamCheckMessages({ question: '两数之和', answer: 'int main(){}', hint: '越界了' });
    expect(user.content).toContain('【题目】\n两数之和');
    expect(user.content).toContain('【我的答案】\nint main(){}');
    expect(user.content).toContain('【用户指出的问题】\n越界了');
  });

  it('feeds earlier verdicts back so round 3 does not repeat round 2', () => {
    const [, user] = buildExamCheckMessages({ question: 'q', answer: 'a', priorNotes: ['第 1 轮：少了空数组判断'] });
    expect(user.content).toContain('【此前几轮复核的结论】');
    expect(user.content).toContain('第 1 轮：少了空数组判断');
  });

  it('truncates a long answer instead of sending the world', () => {
    const [, user] = buildExamCheckMessages({ question: 'q', answer: 'x'.repeat(CHECK_ANSWER_MAX_CHARS + 500) });
    expect(user.content).not.toContain('x'.repeat(CHECK_ANSWER_MAX_CHARS + 1));
  });

  it('omits the hint and history blocks when there are none', () => {
    const [, user] = buildExamCheckMessages({ question: 'q', answer: 'a' });
    expect(user.content).not.toContain('【用户指出的问题】');
    expect(user.content).not.toContain('【此前几轮复核的结论】');
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run test/examPrompts.spec.ts`
Expected: FAIL — `buildExamCheckMessages` 未导出、契约文案不存在

- [ ] **Step 3: 写实现**

`electron/llm/examPrompts.ts` 三处改动。

(1) 在 `CODE_STYLE_RULES`（`:84-93`）之后新增，并把它接进 `systemFor('technical')`：

```ts
/**
 * The shape the renderer parses. CODE_STYLE_RULES says what a human-written
 * answer sounds like; this says what the display layer needs: a fenced block
 * with a language tag, and nothing but the approach line and the complexity
 * line outside it. Without the fence the code arrives as prose and gets
 * re-flowed by the markdown passes (shared/markdownLite.ts:8-11).
 */
const ALGO_FORMAT_RULES = [
  '',
  '算法题输出格式（必须遵守，屏幕那侧按它排版）：',
  '- 代码一律放进带语言标签的围栏块，标签只用 cpp / java / python / javascript / typescript / go；',
  '  没有围栏的代码会被排版引擎当普通散文处理；',
  '- 一个功能只放一个块，不要「边讲边写」把同一段实现拆成几块；',
  '- 保留题目给定的函数签名、类名、参数名与返回类型，要能直接粘进作答框运行；',
  '- 块内不写行号，不用 `...` 省略已给定的模板代码；',
  '- 块外只允许两行：开头一句思路，结尾一行复杂度（时间/空间）；',
  '- 取模常量、大数组上限这类预处理写在函数外，与实现放进同一个块。',
];
```

```ts
    case 'technical':
      return ['你在帮用户现场作答技术/代码题。', ...CODE_STYLE_RULES, ...ALGO_FORMAT_RULES].join('\n');
```

(2) 转录提示（`:57-58` 那两行要求之后）插一条：

```ts
        '代码框里的内容按原始缩进逐行转录，题目给定的函数签名与模板代码一行都不要省；',
```

(3) 文件末尾新增复核提示构造器：

```ts
export const CHECK_ANSWER_MAX_CHARS = 6000;

export interface ExamCheckInput {
  question: string;
  answer: string;
  /** the user's own words about what is wrong, typed on the phone or in the window */
  hint?: string;
  /** notes from earlier rounds, so round 3 does not re-report round 2 */
  priorNotes?: string[];
}

/**
 * The adjudication pass. A separate call with an adversarial brief, because the
 * model that wrote the bug is the same model that just defended it — and
 * because the pipeline's one forbidden outcome is a confidently wrong answer
 * (see buildTranscribeMessages' AMBIGUOUS rule for the same shape of worry).
 */
export function buildExamCheckMessages(input: ExamCheckInput): ChatMessage[] {
  const system = [
    '你是挑错的，不是重做的。只判断下面这份现场手写答案能不能通过这道题。',
    '第一行只写 VERDICT: OK 或 VERDICT: FIX',
    '第二行（仅 FIX）：一句话错因，指名到具体一行或具体条件',
    '第三段（仅 FIX）：以【修订】开头，按同样的写法要求给出改完的完整答案',
    '判据按顺序：',
    '① 是否真解了题意，含 n=0/n=1、空输入、下标越界、取模与溢出；',
    '② 能否编译：函数签名、返回类型、括号分号、缩进、缺的头文件与 import；',
    '③ 声称的时间/空间复杂度与实现是否一致；',
    '④ 是否擅自改了题目给定的签名或参数名；',
    '⑤ 是否引入题目环境里不可能有的第三方库。',
    '没有问题就只输出 VERDICT: OK，不要复述答案、不要补充说明、',
    '不要把能跑的代码改写成「更好的写法」。',
  ].join('\n');
  const parts = [`【题目】\n${input.question.slice(0, MAX_SCREEN_TEXT_CHARS)}`, `【我的答案】\n${input.answer.slice(0, CHECK_ANSWER_MAX_CHARS)}`];
  const hint = input.hint?.trim();
  if (hint) parts.push(`【用户指出的问题】\n${hint.slice(0, 500)}`);
  if (input.priorNotes?.length) parts.push(`【此前几轮复核的结论】\n${input.priorNotes.join('\n').slice(0, 1200)}`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/examPrompts.spec.ts && npm test`
Expected: 新用例 PASS，且 `test/llm.spec.ts` 的 byte-stable prefix 契约仍绿（本任务没碰 `electron/llm/prompts.ts`）

- [ ] **Step 5: 提交**

```bash
git add electron/llm/examPrompts.ts test/examPrompts.spec.ts
git commit -m "feat(exam): contract algorithm answers to fenced code and add the check prompt

围栏契约是排版的前提：没有它，代码会以散文形式进 markdown 通道，
`- x` 变列表、`*ptr` 变斜体、缩进全丢。复核提示单独一轮，
最后一句钉死「不要把能跑的代码改写成更好的写法」这个回归模式。"
```

---

### Task 6: `shared/answerCheck.ts` — 复核输出解析

**Files:**
- Create: `shared/answerCheck.ts`
- Test: `test/answerCheck.spec.ts`

**Interfaces:**
- Consumes: Task 5 的 `buildExamCheckMessages` 输出骨架（约定，非 import）
- Produces:
  - `type CheckVerdict = 'ok' | 'fix' | 'unknown'`
  - `interface CheckResult { verdict: CheckVerdict; note: string; revision: string }`
  - `parseCheckOutput(raw: string): CheckResult`

- [ ] **Step 1: 写失败的测试**

创建 `test/answerCheck.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseCheckOutput } from '../shared/answerCheck';

describe('parseCheckOutput', () => {
  it('accepts a clean OK verdict with no revision', () => {
    expect(parseCheckOutput('VERDICT: OK')).toEqual({ verdict: 'ok', note: '', revision: '' });
  });

  it('tolerates the fences and prose a model wraps around the verdict line', () => {
    const r = parseCheckOutput('好的，我看完了。\nVERDICT: ok\n');
    expect(r.verdict).toBe('ok');
  });

  it('extracts the one-line cause and the revision from a FIX', () => {
    const r = parseCheckOutput('VERDICT: FIX\n空数组时 nums[1] 越界\n【修订】\n```cpp\nint x;\n```');
    expect(r.verdict).toBe('fix');
    expect(r.note).toBe('空数组时 nums[1] 越界');
    expect(r.revision).toBe('```cpp\nint x;\n```');
  });

  it('accepts the revision marker on the same line as the text', () => {
    const r = parseCheckOutput('VERDICT: FIX\n越界\n【修订】 复杂度写错了\nreturn 1;');
    expect(r.note).toBe('越界');
    expect(r.revision).toBe('复杂度写错了\nreturn 1;');
  });

  it('downgrades a FIX with no revision to unknown, keeping the cause', () => {
    const r = parseCheckOutput('VERDICT: FIX\n少了取模');
    expect(r).toEqual({ verdict: 'unknown', note: '少了取模', revision: '' });
  });

  it('never guesses a verdict when the first line is not one', () => {
    const r = parseCheckOutput('这段代码看起来是对的，边界也处理了。');
    expect(r.verdict).toBe('unknown');
    expect(r.note).toContain('这段代码看起来是对的');
  });

  it('treats empty output as unknown with no note', () => {
    expect(parseCheckOutput('   ')).toEqual({ verdict: 'unknown', note: '', revision: '' });
  });

  it('clips a runaway note instead of pasting the whole reply into a badge', () => {
    const r = parseCheckOutput(`VERDICT: FIX\n${'错'.repeat(2000)}\n【修订】\nx`);
    expect(r.note.length).toBeLessThanOrEqual(301);
    expect(r.revision).toBe('x');
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run test/answerCheck.spec.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

创建 `shared/answerCheck.ts`：

```ts
/**
 * The one deterministic read of the checker's reply.
 *
 * Everything downstream of this is UI, so the failure mode it has to prevent is
 * a malformed reply being *inferred* into a verdict: an unparseable round shows
 * as 复核未完成 with the raw text, never as OK. That is the same rule the bank
 * lookup follows (shared/bankStore.ts decideBankAnswer) — certainty is earned,
 * not assumed.
 */

export type CheckVerdict = 'ok' | 'fix' | 'unknown';

export interface CheckResult {
  verdict: CheckVerdict;
  /** one line shown on the card: the cause, or the unparseable reply */
  note: string;
  /** full corrected answer, empty unless verdict is fix */
  revision: string;
}

const NOTE_MAX = 300;
/** models like to clear their throat first; three lines is the grace period */
const VERDICT_SCAN_LINES = 3;

const nonEmptyLines = (text: string): string[] =>
  text.split('\n').map((l) => l.trim()).filter(Boolean);

export function parseCheckOutput(raw: string): CheckResult {
  const text = (raw ?? '').trim();
  if (!text) return { verdict: 'unknown', note: '', revision: '' };

  const lines = nonEmptyLines(text);
  let at = -1;
  let verdict: 'ok' | 'fix' | undefined;
  for (let i = 0; i < Math.min(lines.length, VERDICT_SCAN_LINES); i++) {
    const m = /^VERDICT:\s*(OK|FIX)\b/i.exec(lines[i].replace(/^[>*#\s]+/, ''));
    if (m) {
      at = i;
      verdict = m[1].toUpperCase() === 'OK' ? 'ok' : 'fix';
      break;
    }
  }
  if (!verdict) return { verdict: 'unknown', note: text.slice(0, NOTE_MAX), revision: '' };
  if (verdict === 'ok') return { verdict: 'ok', note: '', revision: '' };

  const note = (lines[at + 1] ?? '').replace(/^[-•*]\s*/, '').slice(0, NOTE_MAX);
  const rest = lines.slice(at + 2).join('\n');
  const marker = /【修订】[ \t]*/.exec(rest);
  const revision = marker ? rest.slice(marker.index + marker[0].length).trim() : '';
  // a FIX that produced no corrected answer is not a fix — say what is wrong and
  // leave the original answer standing alone
  if (!revision) return { verdict: 'unknown', note: note || rest.slice(0, NOTE_MAX), revision: '' };
  return { verdict: 'fix', note, revision };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/answerCheck.spec.ts && npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add shared/answerCheck.ts test/answerCheck.spec.ts
git commit -m "feat(exam): parse the checker reply into a verdict without ever guessing one

解析失败一律 unknown + 原文，绝不推断成 OK：静默的复核失败会被读成
「查过、没问题」，那是这套管线最不能制造的误读。"
```

---

### Task 7: 协议与手机转发 — `check*` / `subMode` 事件

**Files:**
- Modify: `shared/protocol.ts:977-995`（`ExamEvent` 加四个 kind）、`IPC` 表（`:1516` 附近加 `examCheck`）
- Modify: `electron/companion/bridge.ts:330-380`（`publishExam` 加三个 case）
- Modify: `electron/companion/protocol.ts`（`X` 消息 phase 联合类型）
- Test: `test/examProtocol.spec.ts`（新增，只断言类型层能编译 + 事件构造器）

**Interfaces:**
- Consumes: `ExamSubMode`、`CheckVerdict`（Task 6）
- Produces:
  - `{ requestId: string; kind: 'check'; turn: number; verdict: CheckVerdict; note: string; ms: number }`
  - `{ requestId: string; kind: 'checkDelta'; turn: number; text: string }`
  - `{ requestId: string; kind: 'checkDone'; turn: number; text: string }`
  - `{ requestId: string; kind: 'subMode'; subMode: ExamSubMode }`
  - 手机 wire phase：`{type:'x',phase:'check',id,turn,verdict,note}` / `{...,phase:'checkDelta',id,text}` / `{...,phase:'checkDone',id,text}`

- [ ] **Step 1: 加事件类型**

`shared/protocol.ts` 的 `ExamEvent` 联合里，`done` 之后插入（注释按仓库风格说明"为什么"）：

```ts
  /**
   * The adjudication round on the answer already shown. It rides the same
   * requestId as the answer it reviews and never replaces it: a checker that
   * silently rewrote the answer would be indistinguishable from the answerer
   * having been right, which is the one thing the user must be able to tell.
   */
  | { requestId: string; kind: 'check'; turn: number; verdict: CheckVerdict; note: string; ms: number }
  | { requestId: string; kind: 'checkDelta'; turn: number; text: string }
  | { requestId: string; kind: 'checkDone'; turn: number; text: string }
  /** the sub-mode moved somewhere other than this window's own picker (a phone tap) */
  | { requestId: string; kind: 'subMode'; subMode: ExamSubMode }
```

同文件 `import type { CheckVerdict } from './answerCheck';`（放在文件头现有 import 处），并在 `IPC` 表 `examCancel: 'exam:cancel'`（`:1516`）旁加 `examCheck: 'exam:check',`。

- [ ] **Step 2: 加手机转发分支**

`electron/companion/bridge.ts` 的 `publishExam` switch 里，`case 'done'` 之后加：

```ts
      case 'check':
        this.flush(id);
        this.push({ type: 'x', phase: 'check', id, turn: ev.turn, verdict: ev.verdict, note: ev.note, ms: ev.ms });
        break;
      case 'checkDelta':
        this.bufferDelta('x', id, ev.text, `c${ev.turn}`);
        break;
      case 'checkDone':
        this.flush(id, `c${ev.turn}`);
        this.push({ type: 'x', phase: 'checkDone', id, turn: ev.turn, text: ev.text });
        break;
      case 'subMode':
        // no push: the phone's own segment state comes from `st.examSubMode`,
        // and publishing it as an answer event would invent a blank answer card
        break;
```

`bufferDelta`/`flush` 目前按 `(type, id)` 单键缓冲（`bridge.ts:369-373` 的用法）——**先看这两个函数的签名再改**：复核流的缓冲键必须与首答流分开，否则复核 token 会追加进已被 `done` 落定的首答缓冲。若它们不支持第三参数，改为在本类里加一个 `private checkBuffer = new Map<string, string>()` 并自己 `flushCheck(id)`，**不要为了复用把首答的缓冲逻辑改掉**（那是延迟路径上的既有行为，`test/` 里对它有隐含依赖）。

`electron/companion/protocol.ts` 的 `X` 消息类型加对应四个 phase 字面量。

- [ ] **Step 3: 加协议层测试**

创建 `test/examProtocol.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ExamEvent } from '../shared/protocol';

describe('exam check events', () => {
  it('carries the round number so two re-checks cannot overwrite each other', () => {
    const ev: ExamEvent = { requestId: 'r1', kind: 'check', turn: 2, verdict: 'fix', note: '越界', ms: 812 };
    expect(ev.kind === 'check' && ev.turn).toBe(2);
  });

  it('keeps a revision stream separate from the answer stream', () => {
    const d: ExamEvent = { requestId: 'r1', kind: 'checkDelta', turn: 1, text: 'x' };
    const e: ExamEvent = { requestId: 'r1', kind: 'checkDone', turn: 1, text: 'y' };
    expect([d.kind, e.kind]).toEqual(['checkDelta', 'checkDone']);
  });

  it('names the sub-mode without a request of its own', () => {
    const ev: ExamEvent = { requestId: '', kind: 'subMode', subMode: 'technical' };
    expect(ev.kind === 'subMode' && ev.requestId).toBe('');
  });
});
```

- [ ] **Step 4: 校验**

Run: `npm run typecheck && npm test`
Expected: `bridge.ts` 的 switch 若因缺少 case 分支而报穷尽性错误，说明还有分支没补；补到 typecheck 全绿。`npm test` 全绿（此时还没有渲染面消费这些事件，属预期）。

- [ ] **Step 5: 提交**

```bash
git add shared/protocol.ts electron/companion/bridge.ts electron/companion/protocol.ts test/examProtocol.spec.ts
git commit -m "feat(exam): protocol events for the check round and the phone-driven sub-mode

复核流的 delta 缓冲必须与首答分开：共用一个键会把修订 token 追加到
已经落定的首答后面，读起来像模型自己把答案改长了。"
```

---

### Task 8: 主进程复核回合 — `lastExam` 槽位与 `checkExamAnswer`

**Files:**
- Modify: `electron/main.ts`（`runExamAsk` 收尾 `:2166-2192`、`examSetMode` handler `:2352-2356`、新增 `IPC.examCheck` handler、`examControllers` 附近）
- Test: `test/examCheckRound.spec.ts`（新增，测抽出来的纯决策函数，不测 main.ts 本身）

**Interfaces:**
- Consumes: `buildExamCheckMessages`（Task 5）、`parseCheckOutput`（Task 6）、`check*` 事件（Task 7）、`classifyQuestion`（`shared/textHeuristics.ts:54-64`）、`chatStream`（5 参数版）
- Produces:
  - `shouldRunCheck(subMode: ExamSubMode, question: string, answer: string, fromBank: boolean): boolean` —— 放进 `shared/answerCheck.ts`（保持 main.ts 薄，且可测）
  - `lastExam: { requestId: string; question: string; subMode: ExamSubMode; answer: string; at: number } | undefined`（main 进程模块级）

- [ ] **Step 1: 写失败的测试**

创建 `test/examCheckRound.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { shouldRunCheck } from '../shared/answerCheck';

describe('shouldRunCheck', () => {
  const code = '思路\n```cpp\nint main(){}\n```\n复杂度 O(1)';

  it('runs for the technical sub-mode', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: '实现一个 LRU', answer: code, fromBank: false })).toBe(true);
  });

  it('runs when an open-mode question is clearly a coding question', () => {
    expect(shouldRunCheck({ subMode: 'open', question: '用 LeetCode 风格写一道算法题的解：两数之和', answer: code, fromBank: false })).toBe(true);
  });

  it('never runs on a bank-direct answer — the bank is already the certainty here', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: 'q', answer: code, fromBank: true })).toBe(false);
  });

  it('stays out of aptitude and personality items', () => {
    expect(shouldRunCheck({ subMode: 'aptitude', question: '下列说法正确的是 A.甲 B.乙', answer: '选 A', fromBank: false })).toBe(false);
    expect(shouldRunCheck({ subMode: 'personality', question: '我常感到精力充沛', answer: '选「非常符合」', fromBank: false })).toBe(false);
  });

  it('has nothing to check in an empty answer', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: 'q', answer: '  ', fromBank: false })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run test/examCheckRound.spec.ts`
Expected: FAIL — `shouldRunCheck` 未导出

- [ ] **Step 3: 实现门控**

`shared/answerCheck.ts` 末尾追加（`classifyQuestion` 从 `./textHeuristics` import）：

```ts
/**
 * Whether an answered question deserves the extra call. Deliberately narrow:
 * the checker costs one round trip per question, and on an 行测 item or a
 * personality answer that buys nothing while slowing the thing the user is
 * racing against.
 */
export function shouldRunCheck(input: {
  subMode: 'aptitude' | 'technical' | 'personality' | 'open';
  question: string;
  answer: string;
  fromBank: boolean;
}): boolean {
  if (input.fromBank || !input.answer.trim()) return false;
  if (input.subMode === 'technical') return true;
  if (input.subMode !== 'open') return false;
  return classifyQuestion(input.question) === 'coding';
}
```

- [ ] **Step 4: 主进程接线**

`electron/main.ts` 做题区（`:1857` 起）内加模块级状态与一个函数，放在 `runExamAsk` 定义之前：

```ts
    let lastExam: { requestId: string; question: string; subMode: ExamSubMode; answer: string; at: number } | undefined;
    const checkNotes = new Map<string, string[]>();

    const runExamCheck = async (
      requestId: string,
      turn: number,
      hint?: string,
    ): Promise<void> => {
      if (!lastExam || lastExam.requestId !== requestId) {
        examSend({ requestId, kind: 'note', text: T().examCheckNoContext });
        return;
      }
      const llmKey = settings.getLlmApiKey() ?? '';
      if (!llmKey && settings.data.llm.providerId !== 'ollama') {
        examSend({ requestId, kind: 'check', turn, verdict: 'unknown', note: T().noApiKey, ms: 0 });
        return;
      }
      const ac = new AbortController();
      examControllers.set(requestId, ac);
      const t0 = Date.now();
      let raw = '';
      try {
        const messages = buildExamCheckMessages({
          question: lastExam.question,
          answer: lastExam.answer,
          hint,
          priorNotes: checkNotes.get(requestId) ?? [],
        });
        const r = await chatStream(
          { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey: llmKey },
          messages,
          { onDelta: (t) => examSend({ requestId, kind: 'checkDelta', turn, text: t }) },
          ac.signal,
          { temperature: 0.2 },
        );
        raw = r.text;
        const parsed = parseCheckOutput(raw);
        const ms = Date.now() - t0;
        examSend({ requestId, kind: 'check', turn, verdict: parsed.verdict, note: parsed.note, ms });
        if (parsed.verdict === 'fix') {
          examSend({ requestId, kind: 'checkDone', turn, text: parsed.revision });
          if (parsed.note) checkNotes.set(requestId, [...(checkNotes.get(requestId) ?? []), `第 ${turn} 轮：${parsed.note}`]);
        }
        console.log(`[exam] check turn=${turn} verdict=${parsed.verdict} ms=${ms} chars=${raw.length}`);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        examSend({ requestId, kind: 'check', turn, verdict: 'unknown', note: `${T().examCheckFailed}: ${(e as Error).message}`.slice(0, 300), ms: Date.now() - t0 });
      } finally {
        examControllers.delete(requestId);
      }
    };
```

`runExamAsk` 里三处：

1. `subMode` 的取值改为以 settings 为准（spec §4.3）：在函数体取 `subMode` 的那一行改成
   `const subMode: ExamSubMode = settings.data.exam?.subMode ?? payload.subMode;`
2. `send({ requestId, kind:'done', ... })`（`:2181`）之后、`console.log` 之前，记录并自动复核：

```ts
        lastExam = { requestId: payload.requestId, question, subMode, answer: text, at: Date.now() };
        ms.total = Date.now() - t0;
        if (shouldRunCheck({ subMode, question, answer: text, fromBank: false })) {
          // the first answer is already on screen; a failed check must not be
          // able to reach the outer catch and mark the whole ask as errored
          void runExamCheck(payload.requestId, 1).catch((e) =>
            console.warn('[exam] check round failed:', (e as Error).message),
          );
        }
```

3. 题库直答分支（`:2076-2087`）在 `return` 前补 `lastExam = { requestId: payload.requestId, question, subMode, answer: hitView.answer, at: Date.now() };`，让"这题我题库里有"之后仍可手动复核。注意分工：`shouldRunCheck` 只决定**自动**那一轮；手动轮是用户点了就做，不再过这个门。

新增 handler（放在 `IPC.examCancel` 那个 `ipcMain.on` 之后，`:2198`）：

```ts
    // one entry point, two callers: the exam window's button and the phone's op
    const requestExamCheck = (hint?: string): void => {
      const requestId = lastExam?.requestId;
      if (!requestId) {
        // no requestId of its own: the window and the phone both surface this
        // before their request filter, so it reads as a global caveat
        examSend({ requestId: '', kind: 'note', text: T().examCheckNoContext });
        return;
      }
      const turn = (checkTurns.get(requestId) ?? 1) + 1;
      checkTurns.set(requestId, turn);
      void runExamCheck(requestId, turn, hint?.trim().slice(0, 500));
    };
    ipcMain.on(IPC.examCheck, (_e, p: { hint?: string }) => requestExamCheck(p?.hint));
```

并加 `const checkTurns = new Map<string, number>();`（与 `checkNotes` 同一处）。`ipcMain.on(IPC.examAsk, ...)` 里 `runExamAsk(payload)` 之前不用动——新一轮自然换 requestId，旧 check 事件按 `requestId !== activeRef.current` 被两个渲染面丢掉。

`electron/uiStrings.ts`（`shotAmbiguous` 在 `:130`）加两条文案键 `examCheckNoContext`、`examCheckFailed`，zh/en 两套都要（该文件的既有结构照它自己的来）。

- [ ] **Step 5: preload 面**

`electron/examPreload.ts`：`CH` 表加 `examCheck: 'exam:check',` 并在 `satisfies Pick<…>` 联合里加 `'examCheck'`；`McExamApi` 加 `/** re-check the last exam answer; the hint is the user's own words about what is wrong */ check(hint?: string): void;`；`api` 加 `check: (hint) => ipcRenderer.send(CH.examCheck, { hint }),`。

- [ ] **Step 6: 校验并提交**

```bash
npx vitest run test/examCheckRound.spec.ts && npm run typecheck && npm test
git add electron/main.ts electron/examPreload.ts electron/uiStrings.ts shared/answerCheck.ts test/examCheckRound.spec.ts
git commit -m "feat(exam): run the check round after the answer and expose it as a re-check call

首答先给完，复核在后台跑；复核失败只影响复核卡，绝不冒泡到外层 catch
把整次作答标成错误。手动那一轮带用户自己写的错因回灌。"
```

---

### Task 9: 复核卡渲染 — 桌面窗口与手机端

**Files:**
- Modify: `src/exam/ExamApp.tsx:29-37,87-163,326-376`
- Modify: `src/exam/i18n.ts`（zh ~`:29-46`、en ~`:104-121`）
- Modify: `src/exam/exam.css`
- Modify: `resources/companion/app.js:229-292,649-666`
- Test: 无新增单测（解析与门控已在 Task 6/8）；靠 typecheck + build + Step 5 真机

**Interfaces:**
- Consumes: `check*` 事件（Task 7）、`CodeBlock`/`MathText`（Task 3）
- Produces: DOM 契约 `.exam-check[data-verdict]`、`.exam-check-note`、`.exam-check-rev`；手机 `.x-check[data-verdict]`

- [ ] **Step 1: 桌面状态与事件**

`ExamApp.tsx` 的 `Answer` 接口（`:29-37`）之后加：

```ts
interface Check {
  turn: number;
  verdict: 'ok' | 'fix' | 'unknown';
  note: string;
  revision: string;
  streaming: boolean;
  ms: number;
}
```

state 加 `const [check, setCheck] = useState<Check | null>(null);`。事件 switch 里：

- **`subMode` 与空 requestId 的 `note` 分支必须放在 `:100` 的 `if (ev.requestId !== activeRef.current) return;` 之前**（手机上改的档位、以及"还没有上一题可复核"这类全局提示，窗口这边都没有对应活动请求）：

```ts
    if (ev.kind === 'subMode') {
      setSubMode(ev.subMode);
      return;
    }
    if (ev.kind === 'note' && !ev.requestId) {
      setNote(ev.text);
      return;
    }
```

- switch 内加三个 case：

```ts
        case 'check':
          setCheck({ turn: ev.turn, verdict: ev.verdict, note: ev.note, revision: '', streaming: ev.verdict === 'fix', ms: ev.ms });
          break;
        case 'checkDelta':
          setCheck((c) => (c && c.turn === ev.turn && c.streaming ? { ...c, revision: c.revision + ev.text } : c));
          break;
        case 'checkDone':
          setCheck((c) => (c && c.turn === ev.turn ? { ...c, revision: ev.text || c.revision, streaming: false } : c));
          break;
```

`ask()`（`:170-198`）开头与 `begin` 分支各加一句 `setCheck(null);`——新一次作答要清掉上一次的复核卡。

- [ ] **Step 2: 桌面渲染与按钮**

在答案卡之后、re-ask 输入行（`:361`）之前插入：

```tsx
        {check ? (
          <div className="exam-card exam-check" data-verdict={check.verdict}>
            <div className="exam-row">
              <span className={`exam-badge ${check.verdict === 'ok' ? 'good' : check.verdict === 'fix' ? 'warn' : ''}`}>
                {t.checkTitle[check.verdict]}
              </span>
              <span className="exam-meta">{t.checkTurn(check.turn)}</span>
              {check.ms ? <span className="exam-meta">{t.msLabel(check.ms)}</span> : null}
            </div>
            {check.note ? <div className="exam-check-note">{check.note}</div> : null}
            {check.revision ? (
              <div className="exam-check-rev">
                <MathText text={check.revision} />
              </div>
            ) : null}
            {check.streaming ? <span className="exam-hint">{t.checkThinking}</span> : null}
          </div>
        ) : null}
```

re-ask 那一行（`:361-376`）的按钮组里追加一个：

```tsx
            <button
              className="btn"
              disabled={!!check?.streaming}
              onClick={() => window.mcExam.check(instruction.trim() || undefined)}
            >
              {t.checkAgain}
            </button>
```

`requestId` 不传：主进程用 `lastExam` 里那一个（Task 8 的 `requestExamCheck`），这样手机与桌面两个入口天然复核的是同一题。

- [ ] **Step 3: 文案与样式**

`src/exam/i18n.ts` 两套字典各加（键名与现有 `reask`/`origins` 同层）：

```ts
  checkTitle: { ok: '复核：没发现问题', fix: '复核：已订正', unknown: '复核未完成' },
  checkTurn: (n: number) => `第 ${n} 轮`,
  checkThinking: '复核中…',
  checkAgain: '再检查一遍',
  codeLabels: { wrap: '换行', copy: '复制', copied: '已复制', download: '下载' },
```

```ts
  checkTitle: { ok: 'Checked — no problem found', fix: 'Checked — corrected', unknown: 'Check did not finish' },
  checkTurn: (n: number) => `round ${n}`,
  checkThinking: 'checking…',
  checkAgain: 'Check again',
  codeLabels: { wrap: 'wrap', copy: 'copy', copied: 'copied', download: 'save' },
```

`codeLabels` 要传给两处 `MathText`：答案正文 `<MathText text={answer.text} codeLabels={t.codeLabels} />`，以及复核卡里的 `<MathText text={check.revision} codeLabels={t.codeLabels} />`。面试窗口（`PromptFocus`）本任务不传，代码块按钮沿用中文默认值——记为 deferred minor（见台账），因为那边的界面语言切换是另一条链路。

`exam.css` 加：

```css
.exam-check { border-left: 3px solid var(--exam-warn); }
.exam-check[data-verdict='ok'] { border-left-color: var(--exam-good); }
.exam-check[data-verdict='unknown'] { border-left-color: var(--exam-bad); }
.exam-check-note { font-size: 12px; color: var(--exam-warn); margin-top: 4px; white-space: pre-wrap; }
.exam-check-rev { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--exam-border); font-size: 14px; }
```

- [ ] **Step 4: 手机端**

`app.js` 的 `newAnswer`（`:229-246`）对象加 `check: null`；`case 'x'`（`:649-666`）加：

```js
      else if (msg.phase === 'check') { const a = touch(msg.id, 'x'); a.check = { turn: msg.turn, verdict: msg.verdict, note: msg.note || '', text: '', ms: msg.ms || 0 }; renderHero(a); }
      else if (msg.phase === 'checkDelta') { const a = touch(msg.id, 'x'); if (a.check) { a.check.text += msg.text; renderHero(a); } }
      else if (msg.phase === 'checkDone') { const a = touch(msg.id, 'x'); if (a.check) { a.check.text = msg.text || a.check.text; a.check.streaming = false; renderHero(a); } }
```

（手机端子模式的回显走 `st.examSubMode`，不是答案事件——见 Task 7 那个不 push 的 `subMode` 分支。）

`answerHtml`（`:284-292`）在正文之后追加复核卡（**`note` 走 escapeHtml，`text` 走 renderMarkdown**，两者不能混）：

```js
  if (a.check) {
    const v = a.check.verdict;
    html += `<div class="x-check" data-verdict="${v}"><div class="x-check-head">${CHECK_TITLE[v]} · ${a.check.turn}</div>`
      + (a.check.note ? `<div class="x-check-note">${escapeHtml(a.check.note)}</div>` : '')
      + (a.check.text ? `<div class="x-check-body">${window.renderMarkdown(a.check.text)}</div>` : '')
      + '</div>';
  }
```

`CHECK_TITLE` 常量与 `index.html` 的 `.x-check` 样式（`border-left` 三色，同桌面语义）一并加上。控制区的「再检查一遍」按钮在 Task 10 接。

- [ ] **Step 5: 校验 + 端到端真机跑一题**

```bash
npm run typecheck && npm test && npm run build
npm run dev
```

配好 DeepSeek Key 后，用手机页（`npm run smoke:companion` 拿端口，browser-use 打开）走一道真算法题：截屏 → 首答流式出现 → 数秒后复核卡出现在答案下方、原答案仍在 → 代码块可横向滚动、点「换行」不折叠 hero。用 `mcp__browser-use__take_screenshot` 存一张，肉眼核对着色与对齐；再用 `evaluate_script` 断言 `document.querySelectorAll('#heroBody .code-block').length > 0` 与 `document.querySelector('.x-check') !== null`。

- [ ] **Step 6: 提交**

```bash
git add src/exam/ExamApp.tsx src/exam/i18n.ts src/exam/exam.css resources/companion/app.js resources/companion/index.html
git commit -m "feat(exam): show the check round as a card under the answer, on both surfaces

原答案保留、修订另起一卡：判 OK 与复核没跑成必须一眼能分出来，
否则用户会把「没查」读成「查过没问题」。"
```

---

### Task 10: 手机控制区两项做题控制 — `examSubMode` 段选与 `examCheck` 按钮

**Files:**
- Modify: `shared/protocol.ts:205-228`（`CompanionControlItems` + `COMPANION_CONTROL_GRANTS`）
- Modify: `electron/settings.ts:887-894`（`getPublic` 手写枚举）
- Modify: `electron/companion/control.ts:17-23,72-93`
- Modify: `electron/companion/protocol.ts`（`StateMessage`）+ `electron/companion/control.ts:161-169`（`sameState`）
- Modify: `electron/main.ts:2231-2273`（`runControl` 前置分支）+ `:2352-2356`（`examSetMode` 广播）
- Modify: `resources/companion/index.html:36-40,195-215` + `app.js:375-389,453-460,482-490,578-590`
- Modify: `src/components/settings/GeneralTab.tsx:319-366`、`src/i18n.tsx:687,1472`
- Test: `test/companionControl.spec.ts`（改）

**Interfaces:**
- Consumes: `ExamSubMode`、Task 8 的 `runExamCheck`、Task 7 的 `subMode` 事件
- Produces: `ControlOp` 八项；`StateMessage.examSubMode?: ExamSubMode`

- [ ] **Step 1: 改测试到失败**

`test/companionControl.spec.ts:20` 的 `OPS` 改为：

```ts
const OPS = ['richness', 'expertise', 'capture', 'continuous', 'ask', 'history', 'examSubMode', 'examCheck'] as const;
```

并加三条用例：

```ts
  it('refuses a sub-mode the ladder does not have', () => {
    expect(parseControlArg('examSubMode', 'math')).toEqual({ ok: false });
    expect(parseControlArg('examSubMode', 'technical')).toEqual({ ok: true, value: 'technical' });
  });

  it('accepts a re-check with no hint, and with one, but not an empty string', () => {
    expect(parseControlArg('examCheck', undefined)).toEqual({ ok: true, value: undefined });
    expect(parseControlArg('examCheck', '越界了')).toEqual({ ok: true, value: '越界了' });
    expect(parseControlArg('examCheck', '   ')).toEqual({ ok: false });
    expect(parseControlArg('examCheck', 'x'.repeat(ASK_MAX_CHARS + 1)).ok).toBe(false);
  });

  it('treats the two exam ops as grantable items like the other six', () => {
    expect(authorizeControl('examCheck', grants({ allowItems: off('examCheck') }))).toBe('item_disabled');
    expect(authorizeControl('examSubMode', grants({ allowItems: off('examSubMode') }))).toBe('item_disabled');
  });
```

Run: `npx vitest run test/companionControl.spec.ts`
Expected: FAIL（`unknown_op` / 类型不匹配）

- [ ] **Step 2: 扩 op 与授权**

`electron/companion/control.ts`：

```ts
export type ControlOp =
  | 'richness' | 'expertise' | 'capture' | 'continuous' | 'ask' | 'history'
  | 'examSubMode' | 'examCheck';
```

`CONTROL_OPS` 数组同步；`:127` 那句注释「one of the six」改成「one of the eight」。`parseControlArg` 加两个 case：

```ts
    case 'examSubMode':
      return typeof arg === 'string' && EXAM_SUB_MODES.includes(arg) ? { ok: true, value: arg } : { ok: false };
    case 'examCheck': {
      if (arg === undefined) return { ok: true, value: undefined };
      if (typeof arg !== 'string') return { ok: false };
      const hint = arg.trim();
      if (!hint || hint.length > ASK_MAX_CHARS) return { ok: false };
      return { ok: true, value: hint };
    }
```

`const EXAM_SUB_MODES = ['aptitude', 'technical', 'personality', 'open'];`（文件内本地常量，不 import `shared/bankStore`——这个模块的契约是"无 Electron、无 fs"，多一条运行时依赖就多一份风险；测试里断言它与 `ExamSubMode` 一致）。

`shared/protocol.ts`：`CompanionControlItems` 加 `examSubMode: boolean; examCheck: boolean;`（各带一行注释说明手机上能做什么），`COMPANION_CONTROL_GRANTS` 加两项 `true`。`electron/settings.ts:887-894` 的枚举里加两行 `examSubMode: d.companion?.allowItems?.examSubMode !== false,` 同构。

- [ ] **Step 3: 状态回显**

`electron/companion/protocol.ts` 的 `StateMessage` 加 `examSubMode?: ExamSubMode;`；`control.ts:161-169` 的 `sameState` 加 `&& a.examSubMode === b.examSubMode`（漏了这一条，手机上切档位永远不会确认落地——`st` 只在变化时发）。`main.ts` 里 `companion.attachControl({ state: ... })`（`:2276`）的返回值补 `examSubMode: settings.data.exam?.subMode`。

- [ ] **Step 4: 主进程路由**

`main.ts` 的 control 处理里，**在 `if (!win || win.isDestroyed())` 那个守卫之前**（`:2265`）加分支——这两项都是主进程自己的事，不该因为主窗口没开就被丢掉：

```ts
      if (cmd.op === 'examSubMode') {
        settings.applyPatch({ exam: { subMode: value as ExamSubMode } });
        examSend({ requestId: '', kind: 'subMode', subMode: value as ExamSubMode });
        console.log(`[companion-ctl] exam sub-mode -> ${String(value)}`);
        return;
      }
      if (cmd.op === 'examCheck') {
        requestExamCheck(typeof value === 'string' ? value : undefined);
        return;
      }
```

`requestExamCheck` 是 Task 8 Step 4 里定义的那个函数（`IPC.examCheck` handler 也调它）——把它和 `runExamCheck` 定义在同一个作用域内，control 分支才拿得到；若 `attachControl` 的回调定义在它之前，就把这两个函数上移到 `attachControl` 调用之前。`ipcMain.handle(IPC.examSetMode, ...)`（`:2352`）在 `applyPatch` 之后补两下：`examSend({ requestId: '', kind: 'subMode', subMode })` 让开着的桌面窗口跟上，`companion.publishState()` 让手机的段选从 `st` 里拿到新值（少了后者，桌面切档、手机还显示旧档）。

- [ ] **Step 5: 手机 UI**

`index.html` 控制区（`:195-215` 那带）加一行段选 + 一行按钮：

```html
      <div id="rowExamMode" class="ctl-row"><span class="ctl-label">做题模式</span>
        <div class="seg">
          <button data-v="aptitude">行测</button><button data-v="technical">技术</button>
          <button data-v="personality">性格</button><button data-v="open">开放</button>
        </div></div>
      <div id="rowExamCheck" class="ctl-row"><button id="examCheckBtn">再检查一遍</button>
        <input id="examCheckHint" maxlength="500" placeholder="错在哪（可留空）"></div>
```

`app.js`：`ROWS` 加 `examSubMode: document.getElementById('rowExamMode'), examCheck: document.getElementById('rowExamCheck')`；`SEGS.examSubMode` 用与 `#rowRichness` 同样的 `querySelectorAll` 写法；按钮：

```js
document.getElementById('examCheckBtn').addEventListener('click', () => {
  const hint = document.getElementById('examCheckHint').value.trim();
  sendCmd('examCheck', hint || undefined);
  note(hint ? '已让模型带着这句话重查' : '已让模型重查一遍');
});
```

`sendCmd` 的 `if (!PAIRS[op] && !SEGS[op]) return;`（`:457`）对 `examCheck` 正好合适（没有 st 可等，不进待确认态），不用改。`paintCtl` 的 `for (const op of Object.keys(ROWS)) ROWS[op].hidden = !ctlGranted(op)` 自动覆盖两行。

- [ ] **Step 6: 设置页与中英文案**

`GeneralTab.tsx:319-366` 那组复选框里加两项（`d.cCtlItems.examSubMode` / `setCtlItem('examSubMode', …)` 同构两项）；`src/i18n.tsx` zh（`:687` 一带）与 en（`:1472` 一带）各加 `companionCtlExamSubMode`、`companionCtlExamCheck` 两条标签：

```ts
    companionCtlExamSubMode: '做题模式子模式（行测/技术/性格/开放）',
    companionCtlExamCheck: '让模型重新检查上一道算法题',
```
```ts
    companionCtlExamSubMode: 'Exam sub-mode (aptitude / technical / personality / open)',
    companionCtlExamCheck: 'Re-check the last algorithm answer',
```

- [ ] **Step 7: 校验并提交**

```bash
npx vitest run test/companionControl.spec.ts && npm run typecheck && npm test && npm run build
```
Expected: 全绿（`test/settings.spec.ts`、`test/healthState.spec.ts:36` 若因 `allowItems` 形状变化报错，按报错补齐 fixture 的新键，不要放宽断言）

真机：`npm run dev` + 手机页，确认段选切换后 chip 变确认态、桌面做题窗口（若开着）的子模式徽章同步变了、按「再检查一遍」后复核卡轮次 +1。

```bash
git add shared/protocol.ts electron/settings.ts electron/companion/control.ts electron/companion/protocol.ts electron/main.ts resources/companion/index.html resources/companion/app.js src/components/settings/GeneralTab.tsx src/i18n.tsx test/companionControl.spec.ts
git commit -m "feat(companion): expose the exam sub-mode and a re-check button in the phone panel

双屏做题时电脑不开窗，子模式没有别的入口可切；不把它放进控制区，
新的算法题契约与自动复核在手机上根本开不起来。sameState 必须跟着加字段，
否则 st 不发、段选永远停在待确认。"
```

---

### Task 11: 延迟记录与文档

**Files:**
- Modify: `docs/dev/OPTIMIZATION_PLAN.zh-CN.md`（§5 答题链路实测，`:90` 起）
- Modify: `docs/user/QUICK_START.zh-CN.md`（双屏一节，`:110` 附近）与 `docs/user/QUICK_START.en.md`
- Test: 无

- [ ] **Step 1: 量一次数**

用 §5 已有的本地 mock provider 办法跑 5 题，记录三列：首答 `ms.total`、复核 `ms`（`[exam] check turn=… ms=…` 日志）、端到端可见时间。命令与既有做法一致：

```bash
npm run latency:llm
npm run dev   # 另一终端；做题窗口跑五道算法题，从日志里抄 [exam] 行
```

把数字写进文档，**并写清它是在什么条件下量的**（本机、mock 还是真 provider、哪个模型）。参照 `docs/dev/OPTIMIZATION_PLAN.zh-CN.md` 里"record what the 1.85 s local ASR number actually was"（commit `ff827de`）的写法：不写条件的数字没有意义。

- [ ] **Step 2: 写用户文档**

`QUICK_START.zh-CN.md` 双屏一节补三点：代码块现在能横向滚动/可切换换行/可复制下载；算法题答完会自动复核，复核卡三种颜色各是什么意思；手机上能切子模式与按「再检查一遍」。英文版同步。

- [ ] **Step 3: 提交**

```bash
git add docs/dev/OPTIMIZATION_PLAN.zh-CN.md docs/user/QUICK_START.zh-CN.md docs/user/QUICK_START.en.md
git commit -m "docs(exam): record the check-round latency and document the new code display"
```

---

## 完成判据

全部满足才算这份计划做完：

1. `npm run verify` 全绿（typecheck + vitest + build）。
2. `test/markdownLite.spec.ts` 未被修改且通过——存量答案显示不变。
3. 真机：手机页上一条 120 列 C++ 答案，`pre.scrollWidth > pre.clientWidth` 且 `white-space: pre`；点「换行」后变 `pre-wrap` 且 `#hero` 不带 `collapsed`。
4. 真机：一道真算法题，首答先出现，复核卡随后出现；把 LLM Key 清空时复核卡显示「复核未完成」而不是消失。
5. 题库直答的题不产生任何 `check*` 事件（日志里应看不到 `[exam] check`）。
6. 手机上切子模式，桌面做题窗口的子模式徽章同步变化；按「再检查一遍」轮次递增且原答案仍在。
