/**
 * Personality-test engine for 做题模式 (性格/心理测评 in OA).
 *
 * The user's requirement has two halves that pull against each other:
 *   1. answer so the profile matches what THIS employer wants for THIS role —
 *      derived from public research (「字节 后端 校招 性格测评 看重什么」), and
 *   2. stay internally consistent, because these tests re-ask the same
 *      statement in reverse and carry lie / social-desirability scales.
 * A plausible-but-contradictory set of answers is worse than mediocre answers,
 * so the deterministic layer here owns the consistency, and the model only
 * reads the item wording:
 *   - one persona (target level per dimension, with the reason it was chosen),
 *   - a ledger of what has already been committed this sitting,
 *   - scale mapping that avoids the extreme pole (except where the trait is a
 *     hard gate: 诚信/安全/责任心), which is what the lie scale punishes,
 *   - reverse-worded detection so an inverted item flips instead of contradicting,
 *   - forced-choice (迫选) arbitration between two statements.
 *
 * Pure logic — no fs, no electron, no model call. Unit-testable.
 */

/** the dimensions Chinese/foreign OA item banks actually rotate around */
export type TraitDim =
  | 'conscientiousness' // 责任心 / 执行可靠
  | 'detail' // 细致严谨
  | 'stability' // 情绪稳定
  | 'cooperation' // 合作 / 顺从
  | 'assertiveness' // 主导 / 表达
  | 'achievement' // 进取 / 结果导向
  | 'openness' // 学习 / 开放
  | 'integrity' // 诚信 / 规则
  | 'resilience'; // 抗压 / 强度适应

export const TRAIT_DIMS: TraitDim[] = [
  'conscientiousness',
  'detail',
  'stability',
  'cooperation',
  'assertiveness',
  'achievement',
  'openness',
  'integrity',
  'resilience',
];

export const TRAIT_LABELS: Record<TraitDim, string> = {
  conscientiousness: '责任心/执行可靠',
  detail: '细致严谨',
  stability: '情绪稳定',
  cooperation: '合作/配合',
  assertiveness: '主导/表达',
  achievement: '进取/结果导向',
  openness: '学习/开放',
  integrity: '诚信/规则',
  resilience: '抗压/强度适应',
};

/** −2 low … +2 high */
export type Level = -2 | -1 | 0 | 1 | 2;

export interface TraitTarget {
  dim: TraitDim;
  level: Level;
  /** why — the researched employer/role requirement, one line */
  why: string;
}

export interface Persona {
  role?: string;
  company?: string;
  targets: TraitTarget[];
  /** anything the user wants added (their own true constraints) */
  notes?: string;
  source: 'researched' | 'manual';
  updatedAt: number;
}

export type Pole = 'low' | 'mid' | 'high';

/** what has already been committed this sitting, per dimension */
export type Ledger = Partial<Record<TraitDim, { pole: Pole; times: number }>>;

const LEVELS: Level[] = [-2, -1, 0, 1, 2];

export function clampLevel(v: unknown): Level {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  const i = Math.max(-2, Math.min(2, Math.round(n)));
  return LEVELS[i + 2];
}

export function levelToPole(level: Level): Pole {
  return level <= -1 ? 'low' : level >= 1 ? 'high' : 'mid';
}

/**
 * Where to point on a 1..`scale` agreement slider.
 *
 * The extreme option is avoided on purpose (default `avoidTop: true`): ticking
 * 「非常符合」 on everything is exactly what the social-desirability / 测谎 items
 * catch. `hardGate` dimensions — 诚信、安全、责任心 in engineering roles — are the
 * ones where an ambivalent answer reads as a red flag, so they may take the top.
 */
export function pickLikert(level: Level, scale = 5, opts: { hardGate?: boolean } = {}): number {
  const s = Math.max(3, Math.min(7, scale));
  const top = s;
  const nearTop = s - 1;
  const nearBottom = 2;
  const mid = Math.ceil(s / 2);
  const floor = 1;
  switch (level) {
    case 2:
      return opts.hardGate ? top : nearTop;
    case 1:
      return opts.hardGate ? nearTop : nearTop;
    case 0:
      return mid;
    case -1:
      return nearBottom;
    case -2:
    default:
      // the bottom pole is only reachable where a low level is the target
      return opts.hardGate ? floor : nearBottom;
  }
}

/** the wording a Likert scale uses, so the answer can be spoken back to the user */
export function likertLabel(picked: number, scale = 5): string {
  const words5 = ['非常不符合', '比较不符合', '一般', '比较符合', '非常符合'];
  if (scale === 5) return words5[picked - 1] ?? String(picked);
  return `第 ${picked} 档（共 ${scale} 档）`;
}

/**
 * Which dimension an item talks about. Deliberately generous: a missed hit
 * costs one un-guided answer, while a wrong hit could contradict the persona,
 * so the lists stay wide but each is anchored on words an item bank really uses.
 */
const DIM_HINTS: [RegExp, TraitDim][] = [
  [
    /(准时|守时|按期|截止|按流程|按制度|照规定|规则|制度|稳妥|可靠|托付|负责到底|做完|先做完|收尾|交代|拖延|懒散|敷衍|先玩|计划性|有条理|检查|认真|谨慎)/,
    'conscientiousness',
  ],
  [/(出错|错误|疏漏|反复核对|精确|严谨|细节|小粗心|粗心)/, 'detail'],
  [/(生气|发火|情绪|烦躁|沮丧|委屈|抱怨|崩溃|冷静|镇定|平静|紧张|慌张|害怕|焦虑|担心|被批评|心情|受挫)/, 'stability'],
  [/(团队|配合|同事|协商|商量|妥协|听从|服从|支持|合作|集体|大家|独自|一个人)/, 'cooperation'],
  [/(主张|坚持自己|坚持己见|表达|说服|带领|领导|主导|发言|异议|拒绝|提意见|让步)/, 'assertiveness'],
  [/(目标|第一|争胜|挑战|主动承担|结果|业绩|竞争|晋升|成就感|安逸|舒服日子|知足)/, 'achievement'],
  [/(新事物|新东西|尝试|变化|学习|好奇|不同意见|创意|想象|陌生|常规|一成不变)/, 'openness'],
  [/(诚实|说谎|造假|作弊|抄|违规|钻空子|举报|透明|承诺|贪|利益|私活|占便宜)/, 'integrity'],
  [/(加班|高压|紧急|同时多项|熬夜|连续|强度|赶工|顶着|多任务|顾此失彼|忙不过来)/, 'resilience'],
];

export function detectDims(itemText: string): TraitDim[] {
  const out = new Set<TraitDim>();
  for (const [re, dim] of DIM_HINTS) if (re.test(itemText)) out.add(dim);
  return [...out];
}

const NEGATION = /(从不|绝不|不太|很少|难以|不容易|无法|不大会|没有)/;
const POSITIVE_QUANT = /(总是|一向|每次|凡是|极少|很少)/;

/**
 * Does the item ask the negative of an earlier one? 「我不容易紧张」 vs
 * 「我容易紧张」 — same dimension, opposite direction, so agreeing to the first
 * means disagreeing with the second. Flagging it is what keeps the pair from
 * tripping the consistency check.
 */
export function isReverseWorded(itemText: string, dim: TraitDim): boolean {
  void dim;
  return NEGATION.test(itemText) || /不(容易|太|喜欢|愿意|擅长|希望)/.test(itemText);
}

/**
 * The direction the answer pushes the dimension, given the persona target and
 * whether the item is reverse-worded. `agree` means the user ticks 符合.
 */
export function impliedPole(agree: boolean, itemText: string, dims: TraitDim[]): Pole | undefined {
  const d = dims[0];
  if (!d) return undefined;
  const flipped = isReverseWorded(itemText, d);
  const positive = agree !== flipped; // XOR: agree on a normal item, disagree on a reversed one
  return positive ? 'high' : 'low';
}

/**
 * Would answering this way contradict what has already been committed?
 * Returns a human-readable warning (shown in the pane so the user can override)
 * or null when the answer is consistent / there is not yet evidence.
 */
export function checkContradiction(
  ledger: Ledger,
  itemText: string,
  intendAgree: boolean,
): { dim: TraitDim; message: string } | null {
  const dims = detectDims(itemText);
  const pole = impliedPole(intendAgree, itemText, dims);
  if (!dims.length || !pole) return null;
  for (const d of dims) {
    const prior = ledger[d];
    if (!prior || prior.times < 2) continue; // one earlier answer is not a pattern
    if (prior.pole !== pole) {
      return {
        dim: d,
        message: `此前 ${prior.times} 次把「${TRAIT_LABELS[d]}」答成${prior.pole === 'high' ? '偏高' : prior.pole === 'low' ? '偏低' : '中等'}，本题若这样答会变成${pole === 'high' ? '偏高' : pole === 'low' ? '偏低' : '中等'}，可能触发一致性校验。`,
      };
    }
  }
  return null;
}

/** fold one answered item into the ledger */
export function updateLedger(
  ledger: Ledger,
  itemText: string,
  intendAgree: boolean,
): { ledger: Ledger; dims: TraitDim[]; pole?: Pole } {
  const dims = detectDims(itemText);
  const pole = impliedPole(intendAgree, itemText, dims);
  const next: Ledger = { ...ledger };
  for (const d of dims) {
    const prior = next[d];
    const p = pole ?? prior?.pole ?? 'mid';
    next[d] = { pole: p, times: (prior?.times ?? 0) + 1 };
  }
  return { ledger: next, dims, pole };
}

/**
 * Forced choice («以下哪一项更符合你»): pick the alternative whose dimension is
 * closer to the persona target; ties break toward what has already been
 * committed, so the pair cannot disagree with itself.
 */
export function pickForced(
  persona: Persona,
  ledger: Ledger,
  options: string[],
): { index: number; reason: string } | undefined {
  if (options.length < 2) return undefined;
  const scored = options.map((text, index) => {
    const dims = detectDims(text);
    let best = 0;
    for (const d of dims) {
      const t = persona.targets.find((x) => x.dim === d);
      if (!t) continue;
      // an option that flatters a dimension we want LOW is a bad pick
      const want = t.level;
      const gain = want > 0 ? want : want < 0 ? want : 0;
      best = Math.max(best, gain);
    }
    const committed = dims.filter((d) => ledger[d]?.times).length;
    return { index, text, score: best * 2 + committed };
  });
  scored.sort((a, b) => b.score - a.score);
  const win = scored[0];
  if (!win || win.score === 0) return undefined;
  return { index: win.index, reason: `该项对应维度更贴近目标画像${win.text ? `：${win.text.slice(0, 20)}` : ''}` };
}

/**
 * The block injected into the exam prompt: persona, ledger, and the four rules
 * that make a run of answers hold together. Advisory by design — the model
 * still reads the actual item, but it may not invent a new personality halfway
 * through the test.
 */
export function buildPersonaBlock(persona: Persona, ledger: Ledger, scale = 5): string {
  const targets = persona.targets
    .map((t) => {
      const gate = t.dim === 'integrity' || (t.dim === 'conscientiousness' && t.level === 2);
      return `- ${TRAIT_LABELS[t.dim]}：${t.level > 0 ? '偏高' : t.level < 0 ? '偏低' : '中等'}（选第 ${pickLikert(t.level, scale, { hardGate: gate })} 档）— ${t.why}`;
    })
    .join('\n');
  const committed = (Object.keys(ledger) as TraitDim[])
    .filter((d) => ledger[d]?.times)
    .map((d) => `- ${TRAIT_LABELS[d]}：已答 ${ledger[d]!.times} 次，方向${ledger[d]!.pole === 'high' ? '偏高' : ledger[d]!.pole === 'low' ? '偏低' : '中等'}`)
    .join('\n');
  return [
    '【性格测评人设】（本次测评全程固定，不得中途改变）',
    persona.company || persona.role
      ? `岗位：${persona.role ?? '未填'}${persona.company ? ` / 公司：${persona.company}` : ''}`
      : '',
    targets,
    persona.notes ? `补充：${persona.notes}` : '',
    '',
    committed ? `【已答方向】\n${committed}` : '【已答方向】（本场尚未作答）',
    '',
    '作答规则（必须同时满足）：',
    '1. 同一维度前后不得矛盾；题干反向表述时（“从不/不太/难以”），选项方向要反过来选；',
    '2. 除诚信/安全/硬性要求外，不要每题都选最极端的一档 —— 全部“非常符合”会命中装好与测谎题；',
    '3. 迫选二选一（“以下更符合你”）时，选与上面画像更贴近的一项，另一项不评价；',
    '4. 每题用一行给出：选哪一项 + 一句依据（依据必须来自该画像，不得临场新增人设）。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Validate the JSON the research step (or the user) produced. Anything unusable
 * falls back to a safe default instead of half a persona, because a corrupt
 * target list silently corrupts every answer in the test.
 */
export function parsePersona(raw: unknown): Persona | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.targets) ? o.targets : Array.isArray(o.dimensions) ? o.dimensions : [];
  const targets: TraitTarget[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const x = t as Record<string, unknown>;
    const dimKey = String(x.dim ?? x.dimension ?? x.key ?? '').trim() as TraitDim;
    const dim = TRAIT_DIMS.includes(dimKey)
      ? dimKey
      : TRAIT_DIMS.find((d) => TRAIT_LABELS[d] === dimKey || String(x.label ?? '') === TRAIT_LABELS[d]);
    if (!dim) continue;
    if (targets.some((p) => p.dim === dim)) continue;
    targets.push({
      dim,
      level: clampLevel(x.level ?? x.target ?? x.value),
      why: String(x.why ?? x.reason ?? x.依据 ?? '按岗位要求设定').slice(0, 120),
    });
  }
  if (!targets.length) return null;
  return {
    role: typeof o.role === 'string' ? o.role.slice(0, 60) : undefined,
    company: typeof o.company === 'string' ? o.company.slice(0, 60) : undefined,
    targets,
    notes: typeof o.notes === 'string' ? o.notes.slice(0, 600) : undefined,
    source: o.source === 'manual' ? 'manual' : 'researched',
    updatedAt: Date.now(),
  };
}

/** a conservative starting point before any research has been done */
export function defaultPersona(role = '研发工程师'): Persona {
  return {
    role,
    source: 'manual',
    updatedAt: Date.now(),
    targets: [
      { dim: 'conscientiousness', level: 2, why: '交付可靠性是工程岗底线' },
      { dim: 'detail', level: 1, why: '需要少出错，但不必追求完美主义' },
      { dim: 'stability', level: 1, why: '线上问题与评审都要稳' },
      { dim: 'cooperation', level: 1, why: '协作型组织' },
      { dim: 'assertiveness', level: 0, why: '能表达不同意见，但不抢主导' },
      { dim: 'achievement', level: 1, why: '自驱解决问题' },
      { dim: 'openness', level: 1, why: '技术栈更新快' },
      { dim: 'integrity', level: 2, why: '诚信是硬性门槛' },
      { dim: 'resilience', level: 1, why: '版本节点与线上应急' },
    ],
  };
}
