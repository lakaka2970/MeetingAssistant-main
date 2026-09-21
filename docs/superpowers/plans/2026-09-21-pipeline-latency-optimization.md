# 处理流程延迟优化（方案 B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把持续模式「对方说完→首个可见字符」的最坏固定等待从 ≈2.3s 压到 ≤1.1s + 毫秒级检索，慢网检索不再挡首字。

**Architecture:** 防抖窗口内并行化：门控改用两端同码的免费 `heuristic` 三支分发（answer 支免掉 gate 往返，ambiguous 支与防抖并行）；ASR partial 经新 fire-and-forget IPC 预热投机检索缓存；webSearch 改「先答后补」——主回答立即开流，检索结果由第二次小调用生成补充块挂到同一 turn。

**Tech Stack:** Electron + electron-vite，React 渲染进程，shared/ 纯函数两端同码，vitest。

**Spec:** `docs/superpowers/specs/2026-09-21-pipeline-latency-optimization-design.md`（②节已修订：投机触发必须经渲染进程新 IPC，因为主进程不知道 continuous/sessionId 状态）

## Global Constraints

- 不新增 npm 依赖。
- `npm run verify`（typecheck×2 + vitest 全量 + 三端构建）每任务结束时必须全绿；当前基线 50 文件 / 717 测试。
- `shared/**` 文件保持无 electron/node 运行时依赖（纯函数，两端可 import，测试可直接跑）。
- i18n：`src/i18n.tsx` 的 en 字典必须逐键镜像 zh（`Dict = typeof zh`，缺键即 typecheck 失败）。
- 不改 `1100`ms 防抖与 `GATE_TIMEOUT_MS=1200` 的取值；不动 speaker 过滤与 `answeredRef` 去重语义。
- 每任务最后一步提交前**先向用户确认**（本仓库会话约定：用户未要求不自动 commit）。
- 渲染进程编排逻辑（React effect）不为其引入组件测试框架，靠任务 2 的计时 + 任务 5 实机验收。

---

### Task 1: 门控并行化（①）

**Files:**
- Modify: `src/App.tsx:17`（import 行）、`src/App.tsx:470-511`（continuous 效应整体替换）

**Interfaces:**
- Consumes: `heuristic(text): { verdict?: 'answer'|'skip'; why; kind }`（`shared/questionGate.ts:59`，纯函数）；`window.mc.gate(p): Promise<LlmGateResult>`（已有，不改）；`askLlm('continuous')`（已有）。
- Produces: 无新接口；后续任务只依赖「segment 到达→askLlm 发起」时差缩小这一事实。

- [ ] **Step 1: 替换 import**

`src/App.tsx:17` 现为：

```ts
import { isLikelyQuestion } from '../shared/textHeuristics';
```

改为（`isLikelyQuestion` 全仓库仅此一处使用，可直接删）：

```ts
import { heuristic } from '../shared/questionGate';
```

- [ ] **Step 2: 整体替换 continuous 效应**

把 `src/App.tsx:470-511`（从注释 `// Continuous mode: only the OTHER party's lines...` 到该 `useEffect` 结尾）替换为：

```tsx
  // Continuous mode: only the OTHER party's lines trigger it (never my own
  // mic). The debounce window still exists — it waits for a follow-up half
  // sentence — but nothing inside it is idle now: the free two-ended
  // `heuristic` decides the obvious cases up front (an obvious ask never
  // costs a gate round-trip at all), and a genuinely ambiguous line runs its
  // model gate IN PARALLEL with the debounce, collapsing the worst-case
  // serial wait (1100ms + gate) into max(1100ms, gate).
  const lastSeg = segments.length ? segments[segments.length - 1] : null;
  const answeredRef = useRef<number>(-1);
  useEffect(() => {
    if (!continuous || !lastSeg) return;
    if ((lastSeg.speaker ?? 'them') !== 'them') return; // ignore my own voice
    if (answeredRef.current === lastSeg.id) return; // this line is already handled
    const h = heuristic(lastSeg.text);
    if (h.verdict === 'skip') return; // greeting / fragment / logistics ask
    let cancelled = false;
    const fire = (): void => {
      if (cancelled || answeredRef.current === lastSeg.id) return;
      answeredRef.current = lastSeg.id;
      askLlm('continuous');
    };
    // obvious ask → answer at debounce expiry straight away; ambiguous → the
    // gate call is already in flight (started with the debounce), and a gate
    // that somehow failed falls back to answering, exactly as before
    const gateP: Promise<{ verdict: 'answer' | 'skip' }> | undefined = h.verdict
      ? undefined
      : window.mc
          .gate({
            requestId: `gate-${lastSeg.id}`,
            line: lastSeg.text,
            recent: segments.slice(-6).map((s) => s.text),
          })
          .catch(() => ({ verdict: 'answer' as const }));
    const timer = setTimeout(() => {
      if (!gateP) fire();
      else void gateP.then((g) => { if (g.verdict === 'answer') fire(); });
    }, 1100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuous, lastSeg?.id, lastSeg?.endTs]);
```

- [ ] **Step 3: 验证**

Run: `npm run verify`
Expected: typecheck 绿、717 测试绿、三构建绿。

- [ ] **Step 4: 提交（先向用户确认）**

```bash
git add src/App.tsx
git commit -m "Gate continuous mode in parallel with the debounce window"
```

---

### Task 2: 端到端计时（④）

**Files:**
- Modify: `shared/protocol.ts:926-938`（done 事件加 timings）
- Modify: `electron/main.ts:2104-2330`（llmAsk 内 askT0 / retrieveMs / ttftMs / done 事件）
- Modify: `src/App.tsx`（HudStats 46-52、refs、askLlm 209-246、onLlmEvent 361-377）
- Modify: `src/components/StatusBar.tsx:87-105`、`src/i18n.tsx`（status 组两个语言各 3 键）

**Interfaces:**
- Consumes: `percentile(arr, p)`（App.tsx 已有 import）、`HudStats`（App.tsx:46）、`setHud`。
- Produces: `LlmEvent done` 携带 `timings?: { retrieveMs?: number; ttftMs?: number }`；`HudStats.lastFtMs/ftP50/ftP95`；Task 3/4 的日志与验收都读这些。

- [ ] **Step 1: protocol — done 事件加 timings**

`shared/protocol.ts` 的 done 分支（926-938）在 `usage?: {...}` 之后加一个字段：

```ts
      /** pipeline-latency ④: per-stage ms of this answer (main-side clocks).
       * retrieveMs = rag.retrieve wall time, ttftMs = ask received → 1st delta */
      timings?: { retrieveMs?: number; ttftMs?: number };
```

- [ ] **Step 2: main — 计三段**

`electron/main.ts` llmAsk handler 内：

`const ac = new AbortController();`（2112 行）之后加：

```ts
      // pipeline-latency ④: the whole ask is timed against this; ttft is the
      // number the user actually feels (question received → first token out)
      const askT0 = Date.now();
```

路由变量组（`let ragContext ...` 2151 附近）加：

```ts
      let retrieveMs: number | undefined;
      let ttftMs: number | undefined;
```

`const r = await rag.retrieve(q, payload.sessionId);` 之后（Task 3 会改写这行，届时 `retrieveMs = r.ms;` 跟着挪）加：

```ts
        retrieveMs = r.ms;
```

`streamWithFallback({...})`（2279）的 `onDelta` 改为：

```ts
            onDelta: (text) => {
              if (ttftMs === undefined) ttftMs = Date.now() - askT0;
              sendEv({ requestId: payload.requestId, kind: 'delta', text });
            },
```

`work.then` 里 `sendEv({ ... kind: 'done', ... })`（2310）的对象加：

```ts
            timings: { retrieveMs, ttftMs },
```

并在其前加一行日志：

```ts
          console.log(`[timings] mode=${payload.mode} retrieve=${retrieveMs ?? '-'}ms ttft=${ttftMs ?? '-'}ms`);
```

- [ ] **Step 3: renderer — 首字延迟**

`src/App.tsx`：`HudStats`（46）加三字段：

```ts
export interface HudStats {
  lastE2eMs?: number;
  lastInferMs?: number;
  p50?: number;
  p95?: number;
  count: number;
  /** pipeline-latency ④: speech end → first answer delta, continuous mode */
  lastFtMs?: number;
  ftP50?: number;
  ftP95?: number;
}
```

`e2eSamples` ref 声明处（组件顶部 ref 区）旁加：

```ts
  /** pipeline-latency ④: requestId → the speechEndTs of the question line */
  const speechEndRef = useRef(new Map<string, number>());
  const ftSamples = useRef<number[]>([]);
```

`askLlm`（209）的 continuous 分支改为多抓一个 endTs（同作用域内 `let question` 已有，补一行 let 与一次 set）：

```ts
      let question = text;
      let questionEndTs: number | undefined;
      if (mode === 'continuous') {
        for (let i = segs.length - 1; i >= 0; i--) {
          if ((segs[i].speaker ?? 'them') === 'them') {
            question = segs[i].text;
            questionEndTs = segs[i].endTs;
            break;
          }
        }
      }
```

`appendTurn(...)` 之后加：

```ts
      if (questionEndTs) speechEndRef.current.set(requestId, questionEndTs);
```

`onLlmEvent` 回调（361）的第一行（在 `setSessions(...)` 之前）插入：

```ts
      // ④: the very first delta of a continuous answer is the number that
      // matters — everything before it (ASR, debounce, gate, retrieve) was silence
      if (ev.kind === 'delta') {
        const start = speechEndRef.current.get(ev.requestId);
        if (start !== undefined) {
          speechEndRef.current.delete(ev.requestId);
          const ftMs = Date.now() - start;
          const arr = ftSamples.current;
          arr.push(ftMs);
          if (arr.length > 200) arr.shift();
          setHud((s) => ({ ...s, lastFtMs: ftMs, ftP50: percentile(arr, 50), ftP95: percentile(arr, 95) }));
        }
      }
```

- [ ] **Step 4: StatusBar + i18n**

`src/components/StatusBar.tsx` HUD 块（87-105）内、推理 chip 那个 `<span className="dim">{t.status.infer} ...` 之后加：

```tsx
          {hud.lastFtMs !== undefined && (
            <span className="dim" title={t.status.ftTitle}>
              {t.status.ftLabel} {(hud.lastFtMs / 1000).toFixed(2)}s · p50{' '}
              {hud.ftP50 !== undefined ? (hud.ftP50 / 1000).toFixed(2) : '–'} · p95{' '}
              {hud.ftP95 !== undefined ? (hud.ftP95 / 1000).toFixed(2) : '–'}
            </span>
          )}
```

`src/i18n.tsx` status 组：zh 加（`hudTitle` 附近）：

```ts
    ftLabel: '首字',
    ftTitle: '语音结束→回答首字符（持续模式，含防抖/门控/检索）',
```

en 镜像同键：

```ts
    ftLabel: 'first',
    ftTitle: 'speech end → first answer char (continuous mode, incl. debounce/gate/retrieve)',
```

- [ ] **Step 5: 验证**

Run: `npm run verify`
Expected: 全绿（此任务无新单测；纯测量）。

- [ ] **Step 6: 提交（先向用户确认）**

```bash
git add shared/protocol.ts electron/main.ts src/App.tsx src/components/StatusBar.tsx src/i18n.tsx
git commit -m "Time the answer pipeline end to end (speech-end to first token)"
```

---

### Task 3: 投机预检索（②）

**Files:**
- Create: `electron/rag/speculative.ts`
- Create: `test/speculative.spec.ts`
- Modify: `shared/protocol.ts`（IPC 常量区 ~1267）
- Modify: `electron/preload.ts`（McApi ~150、api ~249）
- Modify: `electron/main.ts`（门控 handler 后新增投机块；llmAsk 路由 retrieve 调用点）
- Modify: `src/App.tsx`（continuousRef + partial 分支）

**Interfaces:**
- Consumes: `RagService.retrieve(query, sessionId?, topK?): Promise<RetrieveResult>`（`electron/rag/service.ts:328`）、`rag.status().state`（同文件 ~586，值含 `'ready'`）、`MIN_QUERY_CHARS`（service.ts 导出，main 已 import）。
- Produces: `SpeculativeCache<T>`（`electron/rag/speculative.ts`：`set(text: string, p: Promise<T>): void`、`get(text: string): Promise<T> | undefined`、`after(ms): Promise<null>`）；IPC 通道 `llm:speculate`；`window.mc.speculate({text, sessionId?}): void`。

- [ ] **Step 1: 写失败测试**

Create `test/speculative.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SpeculativeCache, after } from '../electron/rag/speculative';

const settled = (v: number) => Promise.resolve(v);

describe('SpeculativeCache', () => {
  it('returns the stored promise for an exactly equal text', async () => {
    const c = new SpeculativeCache<number>();
    c.set('q', settled(1));
    await expect(c.get('q')).resolves.toBe(1);
  });

  it('misses on a different text', () => {
    const c = new SpeculativeCache<number>();
    c.set('q', settled(1));
    expect(c.get('q2')).toBeUndefined();
  });

  it('expires entries past the TTL', async () => {
    const c = new SpeculativeCache<number>(50);
    c.set('q', settled(1));
    await after(80);
    expect(c.get('q')).toBeUndefined();
  });

  it('evicts the oldest entry beyond the capacity', async () => {
    const c = new SpeculativeCache<number>(10_000, 2);
    c.set('a', settled(1));
    c.set('b', settled(2));
    c.set('c', settled(3));
    expect(c.get('a')).toBeUndefined();
    await expect(c.get('b')).resolves.toBe(2);
    await expect(c.get('c')).resolves.toBe(3);
  });

  it('replacing the same text refreshes the entry', async () => {
    const c = new SpeculativeCache<number>();
    c.set('q', settled(1));
    c.set('q', settled(2));
    await expect(c.get('q')).resolves.toBe(2);
  });

  it('drops blank keys without touching the cache', () => {
    const c = new SpeculativeCache<number>();
    c.set('  ', settled(1));
    expect(c.get('')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx vitest run test/speculative.spec.ts`
Expected: FAIL —「Failed to load ... electron/rag/speculative」（模块不存在）。

- [ ] **Step 3: 最小实现**

Create `electron/rag/speculative.ts`:

```ts
/**
 * Speculative-retrieval cache (pipeline-latency ②): the ASR partial stream
 * prefetches `retrieve` results keyed by the partial's EXACT text, so the
 * final question — which usually settles on a string already spoken as a
 * partial — hits a Map lookup instead of paying embed + search before the
 * first token. Deliberately tiny and boring: short TTL (a partial's useful
 * life is seconds), one-digit capacity, exact match only — a fuzzy prefix
 * match could serve a half-sentence's retrieval result as if it were whole.
 *
 * Values are held as promises: a prefetch still in flight is awaited (bounded
 * by `after`) by the real question; if it has not landed in time, a live
 * retrieve wins and the guess is simply dropped.
 *
 * Pure — no electron, no fs.
 */
export class SpeculativeCache<T> {
  private entries = new Map<string, { p: Promise<T>; at: number }>();

  constructor(
    private readonly ttlMs = 15_000,
    private readonly max = 8,
  ) {}

  set(text: string, p: Promise<T>): void {
    const key = text.trim();
    if (!key) {
      void p.catch(() => undefined); // still a dropped promise if nobody owns it
      return;
    }
    this.entries.set(key, { p, at: Date.now() });
    // Map iterates in insertion order → the first key is the oldest write
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get(text: string): Promise<T> | undefined {
    const key = text.trim();
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.p;
  }
}

/** resolve with null after ms — the bounded wait a speculative hit is allowed */
export const after = (ms: number): Promise<null> =>
  new Promise((res) => setTimeout(() => res(null), ms));
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx vitest run test/speculative.spec.ts`
Expected: 6 passed。

- [ ] **Step 5: IPC 通道 + preload**

`shared/protocol.ts` IPC 常量 `llmGate: 'llm:gate',`（1267）之后加：

```ts
  /** send: ({text, sessionId}) — fire-and-forget: prefetch retrieval for a
   * live ASR partial so the final question hits the cache (pipeline-latency ②) */
  llmSpeculate: 'llm:speculate',
```

`electron/preload.ts` McApi 接口 `gate(...)`（150）之后加：

```ts
  /** continuous mode only: warm the speculative retrieval cache with a partial */
  speculate(p: { text: string; sessionId?: string }): void;
```

api 对象 `gate: (p) => ipcRenderer.invoke(IPC.llmGate, p),`（249）之后加：

```ts
  speculate: (p) => ipcRenderer.send(IPC.llmSpeculate, p),
```

- [ ] **Step 6: main — 投机块 + 复用**

`electron/main.ts` 门控 handler 的 `});`（1979）之后加：

```ts
    // ---- speculative retrieval (pipeline-latency ②) ----
    // The renderer only reports partials while continuous mode is ON, so this
    // side never needs to know about the mode. SPECULATIVE_RETRIEVAL is the
    // one-line kill switch: the whole benefit rests on "the final sentence
    // equals a spoken partial", which is engine behaviour — the hit counter
    // below is what decides whether this stays on.
    const SPECULATIVE_RETRIEVAL = true;
    const SPEC_DEBOUNCE_MS = 300;
    const SPEC_REUSE_WAIT_MS = 400;
    const specCache = new SpeculativeCache<RetrieveResult | null>();
    let specTimer: NodeJS.Timeout | undefined;
    let specHits = 0;
    let specMisses = 0;
    ipcMain.on(IPC.llmSpeculate, (_e, p: { text?: string; sessionId?: string }) => {
      if (!SPECULATIVE_RETRIEVAL) return;
      const text = String(p?.text ?? '').trim();
      if (!text) return;
      if (specTimer) clearTimeout(specTimer);
      specTimer = setTimeout(() => {
        // speculation never spawns the worker or waits for a download
        if (rag.status().state !== 'ready') return;
        if (text.length < MIN_QUERY_CHARS) return;
        specCache.set(text, rag.retrieve(text, p?.sessionId).catch(() => null));
      }, SPEC_DEBOUNCE_MS);
    });
```

main.ts 顶部 import 区：`import { RagService, MIN_QUERY_CHARS } from './rag/service';`（43）扩为：

```ts
import { RagService, MIN_QUERY_CHARS, type RetrieveResult } from './rag/service';
```

并加一行：

```ts
import { SpeculativeCache, after } from './rag/speculative';
```

llmAsk 路由内把 `const r = await rag.retrieve(q, payload.sessionId);`（Task 2 后该行后有 `retrieveMs = r.ms;`）替换为：

```ts
        // speculative reuse: exact text only, and an in-flight guess that has
        // not landed within the wait budget loses to a real retrieve
        let r: RetrieveResult;
        const specP = SPECULATIVE_RETRIEVAL ? specCache.get(q) : undefined;
        const raced = specP ? await Promise.race([specP, after(SPEC_REUSE_WAIT_MS)]) : null;
        if (raced) {
          r = raced;
          specHits++;
          console.log(`[spec] hit ${specHits}/${specHits + specMisses}: "${q.slice(0, 40)}"`);
        } else {
          if (specP) specMisses++;
          r = await rag.retrieve(q, payload.sessionId);
        }
        retrieveMs = r.ms;
```

- [ ] **Step 7: renderer — partial 上报钩子**

`src/App.tsx`：`const [continuous, setContinuous] = useState(false);`（96）附近加 ref 与同步（与 `askLlmRef` 同一区）：

```tsx
  /** pipeline-latency ②: the mount-scoped ASR handler must see the LIVE mode
   * flag, not the one captured at mount */
  const continuousRef = useRef(continuous);
  useEffect(() => {
    continuousRef.current = continuous;
  }, [continuous]);
```

`handleAsrEvent` 的 partial 分支（314-315）改为：

```ts
      } else if (ev.kind === 'partial') {
        setPartials((p) => ({ ...p, [ev.speaker]: ev.text }));
        // ②: warm the RAG cache while the line is still being spoken
        if (continuousRef.current && ev.speaker === 'them') {
          window.mc.speculate({ text: ev.text, sessionId: currentIdRef.current ?? undefined });
        }
      } else if (ev.kind === 'segment') {
```

- [ ] **Step 8: 验证**

Run: `npm run verify`
Expected: 全绿（717+6 测试）。

- [ ] **Step 9: 提交（先向用户确认）**

```bash
git add electron/rag/speculative.ts test/speculative.spec.ts shared/protocol.ts electron/preload.ts electron/main.ts src/App.tsx
git commit -m "Prefetch RAG retrieval from live ASR partials (exact-text cache)"
```

---

### Task 4: webSearch 先答后补（③，方案 3a）

**Files:**
- Create: `shared/webSupplement.ts`
- Create: `test/webSupplement.spec.ts`
- Modify: `shared/protocol.ts`（LlmEvent 916-939、StoredTurn 737-754）
- Modify: `src/components/prompt/focusTurn.ts`（AnswerTurn 加两字段）
- Modify: `electron/main.ts`（路由 web 分支、runSupplement、import）
- Modify: `src/App.tsx`（onLlmEvent 三 case、boot 清 webPending）
- Modify: `src/components/prompt/PromptFocus.tsx`（body() 增补充块）
- Modify: `src/i18n.tsx`（answer 组各语言 2 键）、`src/styles.css`（.turn-web-sup*）

**Interfaces:**
- Consumes: `webSearch(req): Promise<WebSearchOutcome>`（`electron/websearch.ts:111`，**never throws**，`{hits, ms, error?}`）、`formatWebLines(hits)`、`webSources(hits)`（同文件 177/187）、`chatOnce(cfg, msgs, opts): Promise<{text,...}>`（main.ts:76 已 import）、`primary = resolvePrimaryEndpoint()`（handler 内已有）。
- Produces: `supplementMessages(question, mainAnswer, webLines): {role, content}[]`、`NO_SUPPLEMENT`、`isNoSupplement(text): boolean`（`shared/webSupplement.ts`）；LlmEvent 新 kind `web-pending` / `web-sup`（一次性全文）/ `web-done`；`StoredTurn.webSup?: string`、`AnswerTurn.webPending?/webSup?`。

- [ ] **Step 1: 写失败测试**

Create `test/webSupplement.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { supplementMessages, isNoSupplement, NO_SUPPLEMENT } from '../shared/webSupplement';

describe('supplementMessages', () => {
  it('builds a system+user exchange carrying question, answer and web lines', () => {
    const msgs = supplementMessages('Q?', 'A main answer.', ['[t1|u1] s1', '[t2|u2] s2']);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    const all = msgs.map((m) => m.content).join('\n');
    expect(all).toContain('Q?');
    expect(all).toContain('A main answer.');
    expect(all).toContain('[t1|u1] s1');
    expect(all).toContain('[t2|u2] s2');
  });

  it('documents the sentinel contract in the system prompt', () => {
    const msgs = supplementMessages('Q', 'A', ['x']);
    expect(msgs[0].content).toContain(NO_SUPPLEMENT);
  });
});

describe('isNoSupplement', () => {
  it('accepts only the bare sentinel (trimmed)', () => {
    expect(isNoSupplement(NO_SUPPLEMENT)).toBe(true);
    expect(isNoSupplement(` ${NO_SUPPLEMENT} \n`)).toBe(true);
    expect(isNoSupplement('')).toBe(false);
    expect(isNoSupplement(`${NO_SUPPLEMENT}：无补充`)).toBe(false); // prose wins: show it
    expect(isNoSupplement('补充要点：X')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx vitest run test/webSupplement.spec.ts`
Expected: FAIL — 模块 `../shared/webSupplement` 不存在。

- [ ] **Step 3: 实现纯函数**

Create `shared/webSupplement.ts`:

```ts
/**
 * The 先答后补 supplement call (pipeline-latency ③): the main answer has
 * already streamed WITHOUT web context (the search must never hold back the
 * first token), so this second small call contributes only what the results
 * add on top of the answer the user already sees.
 *
 * The supplement is delivered as ONE block, not a live stream — that is what
 * lets the sentinel work: a "nothing to add" reply never touches the screen.
 *
 * Pure — no electron, no network.
 */
export const NO_SUPPLEMENT = 'NO_SUPPLEMENT';

export function supplementMessages(
  question: string,
  mainAnswer: string,
  webLines: string[],
): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: [
        '你是补充检索助手。给定【问题】【已有回答】与【搜索结果】，只输出搜索结果里【已有回答没提到】的实质补充要点。',
        '要求：直接列要点（每行一条，最多 4 条）；不复述已有回答；不写开场语、不写总结；用与问题相同的语言。',
        `若搜索结果没有可补充的信息，只输出 ${NO_SUPPLEMENT} 一个词，不要任何其它字符。`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `【问题】\n${question}\n\n【已有回答】\n${mainAnswer}\n\n【搜索结果】\n${webLines.join('\n')}\n\n补充要点（或 ${NO_SUPPLEMENT}）：`,
    },
  ];
}

/** the sentinel is only the sentinel when it is the whole reply */
export function isNoSupplement(text: string): boolean {
  return text.trim() === NO_SUPPLEMENT;
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx vitest run test/webSupplement.spec.ts` → 3 passed。

- [ ] **Step 5: protocol — 事件与 turn 字段**

`shared/protocol.ts` LlmEvent 联合里 `| { requestId: string; kind: 'web'; sources: WebSourceView[] }` 之后加：

```ts
  /** ③ 先答后补: the KB missed and a web search is running behind the main
   * answer — the renderer may show a waiting hint */
  | { requestId: string; kind: 'web-pending' }
  /** the finished supplement block, delivered whole (sentinel already filtered) */
  | { requestId: string; kind: 'web-sup'; text: string }
  /** the supplement path is over: appended, silent (no hits), failed or cancelled */
  | { requestId: string; kind: 'web-done' }
```

`StoredTurn`（`web?: WebSourceView[]` 之后）加：

```ts
  /** ③ model-written web supplement block (persisted; webPending never is —
   * a stale 'searching' after a restart would be a lie) */
  webSup?: string;
```

`src/components/prompt/focusTurn.ts` 的 `AnswerTurn` 加：

```ts
  /** ③ web search still running after the main answer ended (runtime-only) */
  webPending?: boolean;
  /** ③ model-written supplement block from the late web search */
  webSup?: string;
```

- [ ] **Step 6: main — 路由改「不等待」**

`electron/main.ts` import：`from './websearch'` 的现有语句补上 `type WebSearchOutcome`；新加：

```ts
import { supplementMessages, isNoSupplement } from '../shared/webSupplement';
```

路由变量组（`let qaHit ...` 附近）把 `let webLines: string[] | undefined;` 替换为：

```ts
      /** ③ 先答后补: started unawaited during routing, consumed after done */
      let webPromise: Promise<WebSearchOutcome> | undefined;
      let webQuestion = '';
```

无命中分支（`} else if (q.length >= MIN_QUERY_CHARS) {` 内）整块替换为（去掉 `await`、去掉 `sendEv web`——来源改随补充走）：

```ts
        } else if (q.length >= MIN_QUERY_CHARS) {
          // a real question the knowledge base has nothing on — the web.
          // ③ 先答后补: NEVER awaited here; the answer starts on the model's
          // own knowledge and whatever the search returns is appended after
          // the stream completes. Too-short utterances still never leave.
          const ws = settings.data.webSearch;
          const apiKey = settings.getWebSearchApiKey();
          if (ws?.enabled && apiKey && !isTranslate) {
            webPromise = webSearch({
              provider: ws.providerId ?? DEFAULT_SEARCH_PROVIDER,
              apiKey,
              query: q,
              maxResults: ws.maxResults,
              timeoutMs: ws.timeoutMs,
            });
            webQuestion = q;
            sendEv({ requestId: payload.requestId, kind: 'web-pending' });
          }
        }
```

路由尾日志 `if (ragContext || factsHint || qaHit || webLines) {` 改为 `if (ragContext || factsHint || qaHit || webPromise) {`。`buildAnswerMessages({...})` 调用里删去 `webLines: isTranslate ? undefined : webLines,` 一行（builder 的可选参数保留，无人再传）。

`work` 声明之前加补充流：

```ts
      // ③ the supplement call: small, non-streaming (so the NO_SUPPLEMENT
      // sentinel can be filtered out before it ever reaches the screen), and
      // it always closes the web-pending hint with web-done — success,
      // silence, failure or cancel alike. The main answer stands on its own:
      // a failed supplement stays silent.
      const runSupplement = async (p: Promise<WebSearchOutcome>, mainText: string): Promise<void> => {
        try {
          const w = await p;
          if (ac.signal.aborted) return;
          if (!w.hits.length) {
            console.warn(`[websearch] no hits (${w.error ?? 'empty'}) ${w.ms}ms`);
            return;
          }
          console.log(`[websearch] supplement: ${w.hits.length} hits ${w.ms}ms`);
          sendEv({ requestId: payload.requestId, kind: 'web', sources: webSources(w.hits) });
          const s = await chatOnce(
            {
              baseUrl: settings.data.llm.baseUrl,
              model: settings.data.llm.model,
              apiKey: primary.apiKey ?? '',
            },
            supplementMessages(webQuestion, mainText, formatWebLines(w.hits)),
            { maxTokens: 400, temperature: 0.3, signal: ac.signal },
          );
          const text = s.text.trim();
          if (text && !isNoSupplement(text)) {
            sendEv({ requestId: payload.requestId, kind: 'web-sup', text });
          }
        } catch (e) {
          console.warn('[websearch] supplement failed:', (e as Error).message);
        } finally {
          sendEv({ requestId: payload.requestId, kind: 'web-done' });
        }
      };
```

`work.then((r) => {...})` 里 done `sendEv` 之后加：

```ts
          if (webPromise) void runSupplement(webPromise, r.text);
```

`work.catch((e: Error) => {...})` 的第一行（`if (ac.signal.aborted) return;` 之前）加：

```ts
          if (webPromise) sendEv({ requestId: payload.requestId, kind: 'web-done' });
```

- [ ] **Step 7: renderer — 事件处理 + 启动清理**

`src/App.tsx` onLlmEvent 的 turn-map 内（`if (ev.kind === 'web') ...` 之后）加：

```ts
            if (ev.kind === 'web-pending') return { ...t, webPending: true };
            if (ev.kind === 'web-sup') return { ...t, webSup: ev.text, webPending: false };
            if (ev.kind === 'web-done') return { ...t, webPending: false };
```

boot 的 `loadSessions` 映射里（`reindexSegments(s.segments ?? [])` 所在的 map 对象）turns 一并洗掉运行时旗标：

```ts
            turns: (s.turns ?? []).map((tu) => ({ ...tu, webPending: undefined })),
```

（若 boot 处 map 返回对象已展开 `...s`，此行为追加项。）

- [ ] **Step 8: PromptFocus 补充块 + i18n + CSS**

`src/components/prompt/PromptFocus.tsx` body() 内 `{turn.status === 'streaming' && <span className="cursor">▍</span>}` 与 `turn.web` 块之间插入：

```tsx
        {(turn.webSup || turn.webPending) && (
          <div className="turn-web-sup">
            <span className="turn-web-sup-badge">🌐 {t.answer.webSupHeading}</span>
            {turn.webSup ? (
              <div className="turn-web-sup-body">
                <MathText text={turn.webSup} />
              </div>
            ) : (
              <div className="turn-web-sup-hint">{t.answer.webSearching}</div>
            )}
          </div>
        )}
```

`src/i18n.tsx` answer 组：zh 加：

```ts
    webSupHeading: '联网补充',
    webSearching: '联网检索中，稍后附上补充…',
```

en 镜像：

```ts
    webSupHeading: 'Web supplement',
    webSearching: 'Searching the web — a supplement follows…',
```

`src/styles.css`（`.turn-web` 现有样式附近）加：

```css
/* ---- ③ web supplement block: appended after the main answer, not mixed into it ---- */
.turn-web-sup {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--border-1);
}

.turn-web-sup-badge {
  font-size: 10px;
  border-radius: 4px;
  padding: 1px 6px;
  background: var(--accent-soft);
  color: var(--accent-text);
}

.turn-web-sup-body {
  margin-top: 4px;
  font-size: 0.95em;
  line-height: 1.6;
}

.turn-web-sup-hint {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-faint);
}
```

- [ ] **Step 9: 验证**

Run: `npm run verify`
Expected: 全绿（717+3+6）。

- [ ] **Step 10: 提交（先向用户确认）**

```bash
git add shared/webSupplement.ts test/webSupplement.spec.ts shared/protocol.ts src/components/prompt/focusTurn.ts electron/main.ts src/App.tsx src/components/prompt/PromptFocus.tsx src/i18n.tsx src/styles.css
git commit -m "Answer first, web search follows as an appended supplement block"
```

---

### Task 5: 全量回归 + 实机验收（交给用户）

**Files:** 无新改（若验收发现问题回到对应任务修）。

- [ ] **Step 1: 全量验证**

Run: `npm run verify` → 全绿。

- [ ] **Step 2: 生成验收清单并如实声明「实机部分未测」**

交给用户的清单（我不能驱动 Electron 窗口）：

1. 持续模式问一句明确问题（如「介绍一下你对 React 的理解？」）：说完 ≈1.2s 内出首字；StatusBar「首字」chip 有值。
2. 说「把这个链接发我一下」：不触发回答（heuristic skip 支）。
3. 说模糊句（无问号、非指令、非寒暄）：仍会被回答（gate 并行支 + 失败回退 answer）。
4. 知识库已备问答中提问：预制答案直达不受影响。
5. 开 webSearch、问库外问题：主回答正常流式，结束后「🌐 联网补充」块出现（或静默无块）；主回答期间提示「联网检索中」。
6. 主回答期间点 ✕ 取消：提示消失、无补充块。
7. 控制台 `[spec] hit x/y` 统计：y 增长且命中率有意义则保留投机；命中率≈0 把 `SPECULATIVE_RETRIEVAL` 改 false 并汇报。
8. `[timings]` 日志对比：`ttft` 应显著低于改动前同等问题的「首字」chip。

- [ ] **Step 3: 汇报 + 用户确认后方按需提交收尾**

---

## Self-Review（writing-plans 要求，已执行）

- **Spec 覆盖**：①→Task 1；④→Task 2；②→Task 3（含 spec 修订：新 IPC）；③→Task 4（含修订：补充块一次性交付而非逐字流式，sentinel 因此可过滤）；验收→Task 5。无遗漏节。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`SpeculativeCache<T>.get/set` 与 Task 3 Step 6 的 `SpeculativeCache<RetrieveResult | null>` 一致；`web-pending/web-sup/web-done` 三 kind 在 protocol（Step 5）、main（Step 6）、App（Step 7）拼写一致；`supplementMessages/isNoSupplement/NO_SUPPLEMENT` 三导出名一致；`retrieveMs` 在 Task 2 声明、Task 3 改写处保留。
