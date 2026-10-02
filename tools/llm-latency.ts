/**
 * Live LLM latency measurement through the production adapter — the number the
 * debounce/gate budgets should be tuned against, rather than the guess they were
 * picked from.
 *
 * Required: MC_LLM_KEY
 * Optional: MC_LLM_URL (DeepSeek default), MC_LLM_MODEL (deepseek-flash default),
 *           --runs=N (default 5), --budgetMs=N (fail if any TTFT p95 exceeds it)
 *
 * Prints latencies and lengths only: never the key, never a response body.
 */
import { chatStream, type ChatMessage } from '../electron/llm/adapter';
import { gateMessages } from '../shared/questionGate';

const apiKey = process.env.MC_LLM_KEY;
const baseUrl = process.env.MC_LLM_URL ?? 'https://api.deepseek.com/v1';
const model = process.env.MC_LLM_MODEL ?? 'deepseek-flash';
const runsArg = process.argv.find((a) => a.startsWith('--runs='));
const runs = Math.max(1, Number(runsArg?.split('=')[1] ?? 5));
const budgetArg = process.argv.find((a) => a.startsWith('--budgetMs='));
const budgetMs = budgetArg ? Number(budgetArg.split('=')[1]) : 0;

if (!apiKey) {
  console.error('LATENCY_FAIL: missing MC_LLM_KEY (pass it in your own shell; never commit it)');
  process.exit(1);
}

const config = { apiKey, baseUrl, model };

/** production-shaped transcript context: prompt size moves TTFT, so measure it */
const RECENT = [
  '好的，那我们开始吧，先简单聊聊你上一份工作的内容。',
  '我主要负责的是后端的实时音视频传输部分，用的是自研的协议。',
  '那套协议后来遇到了什么问题吗？',
  '弱网环境下丢包恢复做得不好，我们把 FEC 从固定码率改成了自适应。',
  '改完之后指标上有什么变化？',
  '首帧时间降了大概三成，卡顿率从百分之四降到一点五左右。',
].join('\n');

const CONTEXT_BLOCK = [
  '【简历摘要】',
  '张伟，后端工程师，7 年经验。主导实时音视频传输协议自研，负责弱网对抗模块。',
  '2021—2025 某云通讯公司，服务端负责人，团队 6 人。设计并落地自适应 FEC，' +
    '首帧时间下降 30%，卡顿率由 4% 降至 1.5%。此前在电商做订单履约系统，日均峰值 2000 万单。',
  '【知识笔记】',
  '公司正在建设自研会议引擎，重点解决跨运营商链路的抖动与首帧问题；' +
    '面试官关注候选人在协议设计、拥塞控制与团队管理上的取舍能力。',
].join('\n');

interface Scenario {
  name: string;
  /** what the app is actually doing at this point in the pipeline */
  note: string;
  messages: ChatMessage[];
}

const scenarios: Scenario[] = [
  {
    name: 'gate',
    note: '提图判断（与 1100ms 防抖并行，预算 GATE_TIMEOUT_MS=1200）',
    messages: gateMessages('那你们这个季度的交付节奏是怎么安排的？', [RECENT]) as ChatMessage[],
  },
  {
    name: 'answer-short',
    note: '无检索命中的短上下文回答',
    messages: [
      { role: 'system', content: '你是面试者的第一人称答题助手，回答口语化、可直接念出来，不超过 60 字。' },
      { role: 'user', content: '他们问：这套自适应 FEC 上线时你们怎么灰度的？' },
    ],
  },
  {
    name: 'answer-context',
    note: '生产形态长上下文（简历 + 笔记 + 转录）',
    messages: [
      { role: 'system', content: '你是面试者的第一人称答题助手。只用给定材料作答，口语化，不超过 80 字。' },
      {
        role: 'user',
        content: `${CONTEXT_BLOCK}\n【最近对话】\n${RECENT}\n\n对方刚问：首帧时间下降三成，具体是怎么测出来的？`,
      },
    ],
  },
];

const pct = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))] : 0;

interface Run {
  ttftMs: number;
  totalMs: number;
  deltas: number;
  outChars: number;
  promptChars: number;
}

async function measure(s: Scenario): Promise<Run> {
  const t0 = Date.now();
  let firstAt = 0;
  let deltas = 0;
  const controller = new AbortController();
  const result = await chatStream(
    config,
    s.messages,
    {
      onDelta: () => {
        deltas++;
        if (!firstAt) firstAt = Date.now();
      },
    },
    controller.signal,
    { temperature: 0 },
  );
  const total = Date.now() - t0;
  if (!firstAt) throw new Error(`${s.name}: stream produced no deltas`);
  if (!result.text.trim()) throw new Error(`${s.name}: empty response`);
  return {
    ttftMs: firstAt - t0,
    totalMs: total,
    deltas,
    outChars: result.text.length,
    promptChars: s.messages.reduce((n, m) => n + m.content.length, 0),
  };
}

console.log(`model=${model}  baseUrl host=${new URL(baseUrl).host}  runs=${runs}`);
console.log('注：本机链路（CERNET2）到服务商的往返包含在网络数字里；这是"应用到首字"的开销，不含 ASR 与本地检索。\n');

const rows: { name: string; note: string; sample: Run; stats: Record<string, number> }[] = [];
try {
  for (const s of scenarios) {
    const got: Run[] = [];
    for (let i = 0; i < runs; i++) got.push(await measure(s));
    const ttft = got.map((g) => g.ttftMs).sort((a, b) => a - b);
    const total = got.map((g) => g.totalMs).sort((a, b) => a - b);
    const sample = got[0];
    rows.push({
      name: s.name,
      note: s.note,
      sample,
      stats: {
        promptChars: sample.promptChars,
        ttftMin: ttft[0],
        ttftP50: pct(ttft, 50),
        ttftP95: pct(ttft, 95),
        totalMin: total[0],
        totalP50: pct(total, 50),
        totalMax: total[total.length - 1],
        outChars: Math.round(got.reduce((n, g) => n + g.outChars, 0) / got.length),
      },
    });
  }
} catch (e) {
  console.error(`LATENCY_FAIL: ${(e as Error).message}`);
  process.exit(1);
}

for (const r of rows) {
  console.log(`— ${r.name}  (${r.note})`);
  console.log(
    `  TTFT  min ${r.stats.ttftMin}ms / p50 ${r.stats.ttftP50}ms / p95 ${r.stats.ttftP95}ms` +
      `   总耗时 min ${r.stats.totalMin}ms / p50 ${r.stats.totalP50}ms / max ${r.stats.totalMax}ms`,
  );
  console.log(`  prompt ${r.stats.promptChars} 字，输出约 ${r.stats.outChars} 字，${r.sample.deltas} 个 delta`);
}

const gate = rows.find((r) => r.name === 'gate');
const answer = rows.find((r) => r.name === 'answer-context') ?? rows.find((r) => r.name === 'answer-short');
if (gate && answer) {
  console.log('\n对既有预算的含义：');
  console.log(`  gate p95 ${gate.stats.ttftP95}ms（完成总耗时 p50 ${gate.stats.totalP50}ms） vs GATE_TIMEOUT_MS=1200`);
  console.log(`  答案首字 p50 ${answer.stats.ttftP50}ms，而防抖固定等 1100ms`);
  console.log(
    answer.stats.ttftP50 > 400
      ? '  ⇒ 防抖 1100ms 明显大于"提前发起也付得起"的首字成本，自适应提前触发（L4）值得做。'
      : '  ⇒ 首字很快，防抖 1100ms 才是主要延迟来源，提前触发（L4）收益直接。',
  );
}
// A budget makes this usable as a regression gate: pointed at the local mock
// (zero provider latency) any TTFT above a few ms is ours, not the network's.
if (budgetMs > 0) {
  const over = rows.filter((r) => r.stats.ttftP95 > budgetMs);
  if (over.length) {
    console.error(`LATENCY_FAIL: TTFT p95 over ${budgetMs}ms in ${over.map((r) => `${r.name}=${r.stats.ttftP95}ms`).join(', ')}`);
    process.exit(1);
  }
  console.log(`  预算校验：所有场景 TTFT p95 ≤ ${budgetMs}ms ✓`);
}
console.log('\nLATENCY_OK');
