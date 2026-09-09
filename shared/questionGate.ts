/**
 * Continuous-mode question gate (面试模式「AI 自动识别问题」).
 *
 * 「持续答」must answer when the interviewer actually asks something and stay
 * silent otherwise. One regex either answers late (misses the real ones) or
 * answers everything ("你先自我介绍一下" → answer; "这个链接发我一下" → also
 * answer). So the decision is split by cost:
 *
 *   • obvious skip   — greetings, fragments, an instruction to do something →
 *     never call the model, never answer;
 *   • obvious answer — a marked question, or an explicit request to explain /
 *     introduce / write code → answer immediately (the model call would only
 *     add latency to something we already know);
 *   • ambiguous      — ONE tiny model call with a strict one-word answer.
 *
 * The classifier is advisory: a timeout or an unusable reply falls back to the
 * heuristic, so a slow provider can never stop the copilot from answering.
 *
 * Pure logic — no fs, no electron, no network. Unit-testable.
 */
import { classifyQuestion, isLikelyQuestion, type QuestionKind } from './textHeuristics';

export type Verdict = 'answer' | 'skip';

/**
 * A classifier that takes longer than this is worse than answering on the
 * heuristic, so the caller aborts it and proceeds. Sized to a fast provider's
 * typical one-word completion, with room for a cold connection.
 */
export const GATE_TIMEOUT_MS = 1200;

/**
 * Instructions about the meeting logistics, not a question to answer. The
 * object can sit on either side of the verb (「把这个链接发我一下」 /
 * 「共享一下我的屏幕」), so the interior is loose — and that is safe only
 * because `heuristic` never skips a line ending in a question mark: a request
 * phrased as a question gets answered anyway.
 */
const ACTION_ASK =
  /^(我|我们|你|您|大家)?[^。！？\n]{0,8}(帮忙|麻烦|把|发一下|发我|转发|贴一下|打开|共享|投屏|点开|看一下|看下|等下|稍后)[^。！？\n]{0,14}(链接|文档|屏幕|代码|仓库|权限|会议|表格|附件)[^。！？\n]{0,10}$|^(稍等|等一下|我看看|我看下|收到|好的|OK|ok|行|可以|没问题|谢谢|感谢|辛苦了|开始吧|准备好了)/;

/** a fragment too short to be an ask (「嗯」「然后」「对对对」) */
const TOO_SHORT = /^[\s\p{P}\p{L}]{0,5}$/u;

/** explicit "explain / introduce / write code" asks without a question mark */
const EXPLICIT_ASK =
  /(请|麻烦|帮我|你来|你)?(介绍|说说|讲讲|谈谈|讲一下|说一下|解释|聊(一下|聊)?|write|implement|explain|tell me)(一下)?(下)?(你|您|贵司|这|那|它|此|如何|怎么|什么|一个|段|道)?/i;

export interface HeuristicCall {
  /** what to do without any model round-trip; undefined = ask the model */
  verdict?: Verdict;
  why: 'greeting-or-fragment' | 'action-request' | 'marked-question' | 'explicit-ask' | 'ambiguous';
  kind: QuestionKind;
}

/**
 * Free, instant first pass. Only `why: 'ambiguous'` deserves a paid call.
 */
export function heuristic(text: string): HeuristicCall {
  const t = text.trim();
  const kind = classifyQuestion(t);
  if (!t || TOO_SHORT.test(t) || /^(嗯+|啊+|哦+|噢+|呃+|对对对+|好好好+|是的?|嗯呐)[。！!？?]*$/u.test(t)) {
    return { verdict: 'skip', why: 'greeting-or-fragment', kind };
  }
  if (ACTION_ASK.test(t) && !/[?？]$/.test(t)) return { verdict: 'skip', why: 'action-request', kind };
  if (kind === 'smalltalk' && t.length <= 24) return { verdict: 'skip', why: 'greeting-or-fragment', kind };
  if (/[?？]\s*$/.test(t) || isLikelyQuestion(t)) return { verdict: 'answer', why: 'marked-question', kind };
  if (EXPLICIT_ASK.test(t)) return { verdict: 'answer', why: 'explicit-ask', kind };
  return { why: 'ambiguous', kind };
}

/** the classification prompt: one line, one word, no prose */
export function gateMessages(line: string, recent: string[]): { role: 'system' | 'user'; content: string }[] {
  const ctx = recent.slice(-6).filter(Boolean);
  return [
    {
      role: 'system',
      content: [
        '你是面试转写的触发判定器。判断面试官这句【是否需要我此刻给出可照着念的回答】。',
        '需要（ANSWER）：他在问候选人问题、要求候选人介绍/解释/写代码/表达观点。',
        '不需要（SKIP）：寒暄、自我介绍以外的流程安排（共享屏幕、发链接、稍等、我来讲讲背景）、陈述事实、自言自语、对第三方的指令。',
        '只输出 ANSWER 或 SKIP 一个词，不要标点、不要解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `${ctx.length ? `【最近对话】\n${ctx.join('\n')}\n\n` : ''}【这一句】\n${line.trim()}\n\nANSWER 还是 SKIP？`,
    },
  ];
}

/** strictly parse the model's one-word answer; anything else is unusable */
export function parseVerdict(raw: string): Verdict | undefined {
  const t = raw.trim().toUpperCase();
  if (!t) return undefined;
  if (/^ANSWER/.test(t) || t.startsWith('需要')) return 'answer';
  if (/^SKIP/.test(t) || t.startsWith('不需要') || t.startsWith('SKIP')) return 'skip';
  return undefined;
}

/**
 * Remember decisions by transcript segment id (the same line must not be
 * classified twice when a partial stabilises) and by text, with a small TTL so
 * a long interview cannot grow the map unbounded.
 */
export class GateMemory {
  private seen = new Map<string, { verdict: Verdict | 'pending'; at: number }>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 400,
  ) {}

  private sweep(now: number): void {
    for (const [k, v] of this.seen) if (now - v.at > this.ttlMs) this.seen.delete(k);
  }

  /** keep the newest `max` entries — a long interview must not grow this */
  private trim(): void {
    if (this.seen.size <= this.max) return;
    const oldest = [...this.seen.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of oldest.slice(0, this.seen.size - this.max)) this.seen.delete(k);
  }

  get(key: string): Verdict | 'pending' | undefined {
    const hit = this.seen.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.seen.delete(key);
      return undefined;
    }
    return hit.verdict;
  }

  set(key: string, verdict: Verdict | 'pending'): void {
    this.sweep(Date.now());
    this.seen.set(key, { verdict, at: Date.now() });
    // trim AFTER inserting: doing it before lets the map settle one over the cap
    this.trim();
  }

  get size(): number {
    return this.seen.size;
  }
}
