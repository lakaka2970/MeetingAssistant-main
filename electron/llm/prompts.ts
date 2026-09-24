/**
 * Prompt construction for meeting/interview answering (pure logic, TDD).
 * R4: (a) manual — answer THIS sentence; (b) continuous — advise on recent
 * speech; (c) free — ask over the conversation; (d) translate — translate a
 * line to Chinese. Answer language (zh/en) is a runtime prompt hook.
 *
 * v2 (2026-07-10): cache-friendly three-layer layout —
 *   stable prefix  = persona + style directives + 【应答人设】 + 【简历】
 *                    + 【岗位JD】 + 【个人背景】 + 【自定义指令】 + lang directive
 *                    (BYTE-STABLE across requests → DeepSeek prefix cache)
 *   slow state     = 【面试备忘】memo (updated every few turns)
 *   fast context   = history turns + recent transcript + this question + hint
 * v1.0.1 (2026-09-24): the prefix's editable layers — see {@link PromptLayers}.
 */
import type { ChatMessage } from './adapter';
import { classifyQuestion, isLikelyQuestion, type QuestionKind } from '../../shared/textHeuristics';
import { buildStyleDirectives, DEFAULT_EXPERTISE, DEFAULT_RICHNESS } from '../../shared/answerStyle';
import { PERSONA_TEXT_MAX, PROMPT_OVERRIDE_MAX_CHARS } from '../../shared/personas';

export { isLikelyQuestion, classifyQuestion };

export const MAX_CONTEXT_CHARS = 2400;

export type AnswerLang = 'chinese' | 'english';

/** The prompt hook that steers DeepSeek's reply language (R: 模式选择). */
export function langDirective(lang: AnswerLang): string {
  return lang === 'english'
    ? '- 用【英文】输出我要念的话；必要时在最后附一句极简中文备注。'
    : '- 用【中文】输出。';
}

/**
 * teleprompter persona: the output IS what the user reads aloud, verbatim.
 * Split around the two directive lines so the v1.0.1 style ladder can slot in
 * at the exact byte offset v1.0.0 used (prefix-cache compatibility).
 */
const DEFAULT_PERSONA_HEAD = [
  '你是我的实时面试提词器。我正在参加面试，屏幕上是面试官说话的实时转录。',
  '你输出的内容就是我接下来要照着念的话，必须遵守：',
  '- 全程用第一人称「我」，口语自然，让我可以一字不改地念出来；',
];
const DEFAULT_PERSONA_TAIL = [
  '- 不用 Markdown 标题、编号、加粗等书面格式，分点直接换行；',
  '- 行为/经历类问题按 STAR 展开：情境→任务→行动→结果；',
  '- 技术类问题先一句话讲思路，再给关键点，必要时给复杂度或对比结论；',
  '- 只能使用【简历】里的真实经历，绝不编造简历之外的公司、项目、数字；',
  '- 没把握的问题，给出稳妥的通用说法，或一句得体的争取思考时间的话术。',
];

/**
 * What 高级设置 · 基础人设模板 edits: the persona WITHOUT the directive lines,
 * because those belong to the 回答风格 ladder. Rebuild the v1.0.0 block with
 * `[head, ...styleDirectives, ...tail]` — see {@link DEFAULT_STYLE_DIRECTIVES}.
 */
export const DEFAULT_PERSONA_TEMPLATE = [...DEFAULT_PERSONA_HEAD, ...DEFAULT_PERSONA_TAIL].join('\n');

/** the ladder's default rung == the v1.0.0 directive lines, byte for byte */
export const DEFAULT_STYLE_DIRECTIVES = buildStyleDirectives(DEFAULT_RICHNESS, DEFAULT_EXPERTISE);

/** one override layer as prompt lines; '' / whitespace-only → no lines */
function layerLines(text: string | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** total injected background budget; keeps prompts bounded regardless of size */
export const MAX_BACKGROUND_CHARS = 8000;
/** when both slots are present the resume gets the bigger share */
export const RESUME_BUDGET = 5000;
export const JD_BUDGET = MAX_BACKGROUND_CHARS - RESUME_BUDGET;

/** resume: keep project/work-experience sections when over budget */
export const RESUME_PRIORITY =
  /(项目|经历|经验|工作|实习|成果|职责|Project|Experience|Work|Achievement)/i;
/** JD: keep responsibilities/requirements sections when over budget */
export const JD_PRIORITY =
  /(职责|要求|责任|任职|资格|技能|优先|加分|Responsibilit|Requirement|Qualification|Skill)/i;

/**
 * Deterministic budget clip that prefers paragraphs matching `priority`
 * (e.g. a resume's project experience, a JD's requirements) instead of a
 * blind head-truncation. Output order stays the original document order.
 */
export function smartClip(text: string, budget: number, priority: RegExp): string {
  const t = text.trim();
  if (t.length <= budget) return t;
  const paras = t.split(/\n{2,}/);
  const picked = new Set<number>();
  let used = 0;
  const tryTake = (i: number) => {
    if (picked.has(i)) return;
    const cost = paras[i].length + 2; // + join separator
    if (used + cost > budget) return;
    picked.add(i);
    used += cost;
  };
  for (let i = 0; i < paras.length; i++) if (priority.test(paras[i])) tryTake(i);
  for (let i = 0; i < paras.length; i++) tryTake(i);
  if (picked.size === 0) return t.slice(0, budget); // one giant paragraph
  return paras
    .map((p, i) => (picked.has(i) ? p : null))
    .filter((p): p is string => p !== null)
    .join('\n\n');
}

/**
 * The settings-derived layers folded into the stable prefix (v1.0.1). Every
 * layer changes only when the user changes a setting, so it may ride the
 * byte-stable prefix; per-question content (RAG / prepared answer / web / memo)
 * must stay in the fast context.
 */
export interface PromptLayers {
  /** 高级设置·基础人设模板 override; '' = the built-in teleprompter persona */
  persona?: string;
  /** 高级设置·风格指令 override; '' = the generated {@link PromptLayers.styleDirectives} */
  styleOverride?: string;
  /** {@link buildStyleDirectives} of the chosen richness / expertise */
  styleDirectives?: string[];
  /** 【应答人设】 — text of the selected persona-library entry */
  answerPersona?: string;
  /** 【自定义指令】 — free-form user instruction, wins over the layers above */
  extra?: string;
}

export interface StablePrefixInput {
  resume?: string;
  jd?: string;
  lang: AnswerLang;
  notes?: string;
  layers?: PromptLayers;
}

/**
 * The BYTE-STABLE system prompt: persona + style directives + 应答人设 +
 * 【简历】 + 【岗位JD】 + 【个人背景】 + 自定义指令 + language directive. Same
 * inputs MUST yield the identical string (no timestamps / randomness) — the LLM
 * prewarm request and every real request share this prefix so the provider's
 * prefix cache (DeepSeek 0.1x pricing + faster prefill) hits. Notes sit here
 * (they change rarely) while RAG recall is per-question and therefore belongs
 * to the FAST context below — injecting it here would invalidate the cache on
 * every question.
 */
export function buildStablePrefix(input: StablePrefixInput): string {
  const layers = input.layers ?? {};
  const override = layerLines(layers.styleOverride);
  const style = override.length ? override : (layers.styleDirectives ?? DEFAULT_STYLE_DIRECTIVES);
  const persona = layerLines(layers.persona);
  const parts = persona.length
    ? [...persona, ...style]
    : [...DEFAULT_PERSONA_HEAD, ...style, ...DEFAULT_PERSONA_TAIL];

  const ap = (layers.answerPersona ?? '').trim();
  if (ap) {
    parts.push(
      '',
      '【应答人设】（本场面试我要扮演的设定，口吻、立场与详略以它为准，但不编造经历）',
      ap.slice(0, PERSONA_TEXT_MAX),
      '【应答人设结束】',
    );
  }

  const r = (input.resume ?? '').trim();
  const j = (input.jd ?? '').trim();
  if (r) {
    parts.push(
      '',
      '【简历】（我的真实资料，回答只能基于此）',
      smartClip(r, j ? RESUME_BUDGET : MAX_BACKGROUND_CHARS, RESUME_PRIORITY),
      '【简历结束】',
    );
  }
  if (j) {
    parts.push(
      '',
      '【岗位JD】（本场面试针对的职位，回答向它贴合）',
      smartClip(j, r ? JD_BUDGET : MAX_BACKGROUND_CHARS, JD_PRIORITY),
      '【岗位JD结束】',
    );
  }
  const n = (input.notes ?? '').trim();
  if (n) {
    parts.push(
      '',
      '【个人背景】（我补充的个性化信息，与简历冲突时以这里为准）',
      n.slice(0, MAX_NOTES_PROMPT_CHARS),
      '【个人背景结束】',
    );
  }
  const extra = (layers.extra ?? '').trim();
  if (extra) {
    parts.push(
      '',
      '【自定义指令】（我追加的要求，与其它指令冲突时以这里为准）',
      extra.slice(0, PROMPT_OVERRIDE_MAX_CHARS),
      '【自定义指令结束】',
    );
  }
  parts.push('', langDirective(input.lang));
  return parts.join('\n');
}

/** custom notes ride the stable prefix; bounded so they cannot blow context */
export const MAX_NOTES_PROMPT_CHARS = 4000;
/** RAG recall block budget in the fast context (chars) */
export const MAX_RAG_CONTEXT_CHARS = 2000;
/** a prepared answer is quoted in full up to this size (it is the payload) */
export const MAX_QA_ANSWER_CHARS = 4000;

/**
 * The prepared-answer block (knowledge-base Q&A direct hit). The user wrote
 * this answer themselves, so it is authoritative: the model keeps every fact
 * and only enriches the wording. It rides the FAST context (per-question) —
 * putting it in the stable prefix would break the provider's prefix cache on
 * every different question.
 */
export function formatQaBlock(question: string, answer: string): string {
  return [
    `【我的标准答案】（知识库命中「${question.trim().slice(0, 120)}」，这是我提前准备的答案）`,
    answer.trim().slice(0, MAX_QA_ANSWER_CHARS),
    '—— 要求：其中的人物、数字、项目、结论必须原样保留、不得改写或质疑；',
    '   在此基础上把它充实成我可以照着念的完整回答：补足一两个支撑细节、让前后衔接自然；',
    '   不要新增我没准备的事实，也不要把原文另抄一遍后再接一段。',
  ].join('\n');
}

/**
 * The web-search block (knowledge-base miss fallback). Only used when nothing
 * in the KB answered, so the model has no local basis: it must stay inside the
 * retrieved material and name where it came from.
 */
export function formatWebBlock(lines: string[]): string {
  const body = lines.map((l) => l.trim()).filter(Boolean);
  if (!body.length) return '';
  return [
    '【网络检索】（我的知识库里没有相关内容，以下是刚检索到的网页摘要，回答必须以它们为准）',
    ...body,
    '—— 要求：只讲检索材料支持的内容，没把握的地方直接说没把握；',
    '   最后用一行「来源：」列出最关键的 1-3 个链接。',
  ].join('\n');
}

/** one advisory line appended to the user message; '' when unknown */
export function questionHint(kind: QuestionKind): string {
  switch (kind) {
    case 'behavioral':
      return '（题型：行为/经历题——用 STAR 结构，讲简历里的真实经历）';
    case 'coding':
      return '（题型：编码题——先一句思路，再直接给代码或伪代码，简洁高效，不需要 STAR）';
    case 'technical':
      return '（题型：技术题——先一句话思路，再关键点，必要时给复杂度）';
    case 'smalltalk':
      return '（题型：寒暄/暖场——一两句自然简短的回应即可，不用展开）';
    default:
      return '';
  }
}

// ---------- P1-5: rolling interview memo (consistency > compression) ----------

/** hard bound on the stored memo (prompt asks for ≤800, clamp defends) */
export const MAX_MEMO_CHARS = 1000;

export function clampMemo(text: string): string {
  const t = text.trim();
  return t.length > MAX_MEMO_CHARS ? t.slice(0, MAX_MEMO_CHARS) : t;
}

/**
 * Fold one finished Q&A into the rolling memo (async, off the critical path).
 * The memo keeps the interview self-consistent: what was asked, what I have
 * claimed as fact, what the interviewer cares about.
 */
export function buildMemoUpdateMessages(oldMemo: string, question: string, answer: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是面试会话的备忘维护器。把新一轮问答合并进备忘，输出更新后的完整备忘。',
        '备忘不超过 800 字，固定四节（无内容的节保留标题写「无」）：',
        '【已问问题】每题一行，最新在最后',
        '【我已声称的事实】数字、经历、立场——后续回答绝不能与之矛盾',
        '【面试官关注点】从提问推断',
        '【注意事项】答得不稳的点、需要圆回来的坑',
        '合并去重；超长时优先丢最旧的已问问题。只输出备忘本身，不要任何解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `【当前备忘】\n${oldMemo.trim() || '（空）'}\n\n【新一轮问答】\n问：${question.trim()}\n答：${answer.trim()}`,
    },
  ];
}

// ---------- P1-6: prefix-cache prewarm ----------

/**
 * The prewarm request: system prompt byte-identical to real answer requests
 * (that's the whole point — DeepSeek caches the common token prefix), plus a
 * constant one-word user turn; max_tokens=1 upstream, reply discarded.
 */
export function buildPrewarmMessages(stablePrefix: string): ChatMessage[] {
  return [
    { role: 'system', content: stablePrefix },
    { role: 'user', content: 'ok' },
  ];
}

export interface AnswerPromptInput {
  /** the sentence to answer (segment/continuous) or the text to translate */
  question?: string;
  /** recent transcript lines, oldest first */
  recentTranscript: string[];
  mode: 'segment' | 'continuous' | 'free' | 'translate';
  /** free-form user question (mode === 'free') */
  freeQuestion?: string;
  /** reply language for segment/continuous/free (default chinese) */
  answerLang?: AnswerLang;
  /** prior Q&A turns for a coherent session (oldest first) */
  history?: ChatMessage[];
  /** resume slot (双槽资料); falls back to `background` */
  resume?: string;
  /** job-description slot (双槽资料) */
  jd?: string;
  /** legacy single-slot KB / global default — treated as resume material */
  background?: string;
  /** rolling interview memo (P1) — slow-changing block, its own message */
  memo?: string;
  /** L2 personal notes — ride the STABLE prefix (upgrade P0) */
  notes?: string;
  /** v1.0.1 settings-derived prompt layers; segment/continuous only */
  promptLayers?: PromptLayers;
  /** L3 RAG recall lines, already formatted, most relevant first (upgrade P0) */
  ragContext?: string[];
  /** recalled blocks whose figures are not settled — see {@link formatRagContext} */
  ragConflicts?: string[];
  /**
   * Prepared-answer direct hit from the knowledge base. When present the UI has
   * already shown the verbatim answer, so the model's job is enrichment only —
   * see {@link formatQaBlock}.
   */
  qaHit?: { question: string; answer: string };
  /** web-search summary lines (KB-miss fallback) — see {@link formatWebBlock} */
  webLines?: string[];
  /** consistency conflict warnings (upgrade P3) — fast context, advisory */
  consistencyHint?: string;
  /** matched /trigger skill directive (upgrade P3, free mode only) */
  skillInstruction?: string;
}

/**
 * Format the RAG recall block for the fast context; '' when nothing hit.
 *
 * `conflicts` names the recalled blocks that carry an unresolved-figure marker
 * (⚠ / 口径 / 待核). This is not decoration: in the interview KB the same metric
 * legitimately has two numbers in different files, and a retrieval that happens
 * to return only the stale one would have the candidate read a figure they have
 * already judged wrong — to an interviewer who has the report in front of them.
 * Forcing both out loud converts a silent error into a stated uncertainty.
 */
export function formatRagContext(lines: string[], conflicts: string[] = []): string {
  const picked: string[] = [];
  let used = 0;
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (used + l.length > MAX_RAG_CONTEXT_CHARS) break;
    picked.push(l);
    used += l.length + 1;
  }
  if (!picked.length) return '';
  const warn = conflicts.length
    ? `\n【口径未定】以下出处对同一数字/事实存在不一致口径：${conflicts.join('、')}。\n` +
      '必须把各口径及其出处分别说出、并说明以哪个为准及依据；不得只挑一个念，也不得自行折中或编造第三个数字。' +
      '若被追问，直接承认存在两个口径并给出核对方式。'
    : '';
  return `【知识库召回】（检索到的相关历史资料，供回答参考）\n${picked.join('\n')}${warn}`;
}

/** Keep the most recent lines within the char budget (oldest dropped first). */
export function clampTranscript(lines: string[], maxChars = MAX_CONTEXT_CHARS): string[] {
  const out: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i].length + 1;
    if (total + len > maxChars) break;
    out.unshift(lines[i]);
    total += len;
  }
  return out;
}

/**
 * Translate a transcript line to Chinese (R: 翻译功能). Fixed target = 中文,
 * output only the translation. If the text is already Chinese the model
 * simply echoes it.
 */
export function buildTranslateMessages(text: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是翻译引擎。把用户给的整段文本翻译成【简体中文】。只输出译文本身，不要加引号、不要解释、不要复述原文；若原文已是中文则原样返回。',
    },
    { role: 'user', content: text.trim() },
  ];
}

/** R5: screenshot Q&A — one multimodal user message for a vision model. */
export function buildVisionMessages(  question: string,
  imageDataUrl: string,
  background?: string,
): ChatMessage[] {  const bg = (background ?? '').trim();
  const sys =
    '你是会议助手。用户发来一张屏幕截图（通常是对方共享的 PPT/文档或一道题目）。用中文简明回答用户关于截图的问题；若是提问/题目，给出用户可以直接说的回答要点或解题思路。' +
    (bg
      ? `\n\n===== 本人资料与知识库（作答时优先采用） =====\n${bg.slice(0, MAX_BACKGROUND_CHARS)}\n===== 资料结束 =====`
      : '');
  return [
    {
      role: 'system',
      content: sys,
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: question.trim() || '解读这页内容的要点，并给出我应该怎么回应的建议。' },
      ],
    },
  ];
}

/**
 * upgrade P2: OCR prefilter path — a text-rich region screenshot answered by
 * the FAST TEXT model from the extracted OCR text (no vision round-trip).
 * Streamable, unlike buildVisionMessages.
 */
export function buildOcrAnswerMessages(
  ocrText: string,
  question: string,
  background?: string,
): ChatMessage[] {
  const bg = (background ?? '').trim();
  const sys =
    '你是屏幕内容助手。用户框选了屏幕上一块区域，下面是这块区域 OCR 提取出的文本。基于这些文本回答用户的问题；若文本是一道题，给出可直接口述的解题思路或答案。' +
    'OCR 文本可能不完整或有识别错误：缺失处按上下文合理推断，但不编造与文本无关的内容。' +
    (bg
      ? `\n\n===== 本人资料与知识库（作答时优先采用） =====\n${bg.slice(0, MAX_BACKGROUND_CHARS)}\n===== 资料结束 =====`
      : '');
  const q = question.trim();
  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content: `${q ? `【我的问题】\n${q}\n\n` : ''}【框选区域的 OCR 文本】\n${ocrText.slice(0, 4000)}\n\n${
        q ? '请回答上面的问题。' : '解读这段内容的要点，并给出我应该怎么回应的建议。'
      }`,
    },
  ];
}

export function buildAnswerMessages(input: AnswerPromptInput): ChatMessage[] {
  if (input.mode === 'translate') {
    return buildTranslateMessages(input.question ?? '');
  }

  const lang: AnswerLang = input.answerLang ?? 'chinese';
  const context = clampTranscript(input.recentTranscript);
  const resume = (input.resume ?? '').trim() || (input.background ?? '').trim();
  const jd = (input.jd ?? '').trim();

  // Free "随便问": raw pass-through — NO meeting-assistant persona, so identity
  // / "which model are you" questions get the model's truthful answer. The
  // transcript + KB are offered only as optional reference. The v1.0.1 layers
  // (style / 应答人设 / 自定义指令) are deliberately NOT applied here either.
  if (input.mode === 'free') {
    const refs: string[] = [];
    const qa = input.qaHit;
    if (qa?.answer.trim()) refs.push(formatQaBlock(qa.question, qa.answer));
    if (resume) refs.push(`【本人资料（简历）】\n${resume.slice(0, MAX_BACKGROUND_CHARS)}`);
    if (jd) refs.push(`【岗位JD】\n${jd.slice(0, MAX_BACKGROUND_CHARS)}`);
    const notes = (input.notes ?? '').trim();
    if (notes) refs.push(`【个人背景】\n${notes.slice(0, MAX_NOTES_PROMPT_CHARS)}`);
    const ragBlock = formatRagContext(input.ragContext ?? [], input.ragConflicts ?? []);
    if (ragBlock) refs.push(ragBlock);
    const webBlock = formatWebBlock(input.webLines ?? []);
    if (webBlock) refs.push(webBlock);
    const skill = (input.skillInstruction ?? '').trim();
    if (skill) refs.push(`【技能指令】（必须遵守）\n${skill}`);
    if (context.length) refs.push(`【最近的对话转录】\n${context.join('\n')}`);
    const msgs: ChatMessage[] = [];
    if (refs.length) {
      msgs.push({ role: 'system', content: `以下资料供参考（可用可不用）：\n\n${refs.join('\n\n')}` });
    }
    msgs.push(...(input.history ?? []));
    msgs.push({ role: 'user', content: (input.freeQuestion ?? '').trim() });
    return msgs;
  }

  // segment / continuous: teleprompter with the stable prefix
  const msgs: ChatMessage[] = [
    {
      role: 'system',
      content: buildStablePrefix({ resume, jd, lang, notes: input.notes, layers: input.promptLayers }),
    },
  ];

  const memo = (input.memo ?? '').trim();
  if (memo) {
    // slow-changing block sits BETWEEN the stable prefix and the fast history,
    // so a memo refresh only invalidates the cache from this point on
    msgs.push({ role: 'user', content: `【面试进行备忘】（此前面试内容的滚动摘要，保持前后一致）\n${memo}` });
    msgs.push({ role: 'assistant', content: '收到，我会保持一致。' });
  }

  msgs.push(...(input.history ?? []));

  const contextBlock = context.length
    ? `【最近的对话转录】\n${context.join('\n')}`
    : '【最近的对话转录】（暂无）';
  const q = (input.question ?? '').trim();
  const hint = q ? questionHint(classifyQuestion(q)) : '';
  // fast-context knowledge: RAG recall + consistency warnings are per-question
  // and MUST NOT touch the stable prefix (prefix-cache safety, upgrade P0)
  const qa = input.qaHit;
  const qaBlock = qa?.answer.trim() ? formatQaBlock(qa.question, qa.answer) : '';
  const ragBlock = formatRagContext(input.ragContext ?? []);
  const webBlock = formatWebBlock(input.webLines ?? []);
  const consistency = (input.consistencyHint ?? '').trim();
  const knowledgeBlock = [
    qaBlock,
    ragBlock,
    webBlock,
    consistency ? `【一致性提醒】\n${consistency}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const ask = q
    ? qaBlock
      ? `面试官刚才说：\n“${q}”\n这道题我有准备的答案（见上）。请直接给出我照着念的最终版本：以准备的答案为主体并把它充实完整。`
      : `面试官刚才说：\n“${q}”\n${hint ? hint + '\n' : ''}请直接给出我可以照着念的回答。`
    : '基于上面最近的转录，面试官最新的话需要我回应。请直接给出我可以照着念的回答。';

  msgs.push({ role: 'user', content: `${contextBlock}\n\n${knowledgeBlock ? knowledgeBlock + '\n\n' : ''}${ask}` });
  return msgs;
}
