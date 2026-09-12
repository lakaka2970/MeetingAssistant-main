/**
 * Exam-mode (做题模式) prompts.
 *
 * The pipeline is deliberately staged, because an OA screen is read once and
 * then answered many times a minute:
 *
 *   1. read the screen  → the question as TEXT (local OCR when available, else
 *      the vision model) — one transcription call, no reasoning;
 *   2. look it up       → the user's own bank answers it verbatim (no model at
 *      all, which is also the only trustworthy path for 行测 answer keys);
 *   3. otherwise answer → the text model, with the bank entry as a hint and the
 *      fixed persona for personality items.
 *
 * Each sub-mode wants a different answer shape, and the coding one has a real
 * constraint beyond correctness: a hand-written answer must not read like a
 * generic AI dump (see CODE_STYLE_RULES).
 */
import type { ChatMessage } from './adapter';
import type { ExamSubMode } from '../../shared/bankStore';

export const MAX_SCREEN_TEXT_CHARS = 6000;

/**
 * Screen → question text. Exactness matters more than fluency: everything
 * downstream is keyed on this string, so it must not be paraphrased.
 *
 * `wholeScreen` is the 整屏 mode (no region was cropped), and it changes the
 * job: instead of "transcribe what is here" it has to first **decide which
 * question the user means**. A desktop shows taskbar, browser chrome, chat
 * windows and often several questions at once, and transcribing the wrong one
 * produces a confident answer to a question nobody asked — the one outcome this
 * pipeline must never produce. Hence the explicit locate rules and the
 * AMBIGUOUS marker rather than a silent guess.
 */
export function buildTranscribeMessages(wholeScreen = false): ChatMessage[] {
  const locating = wholeScreen
    ? [
        '这张图是**整个屏幕**，不是题目特写。画面里可能同时出现多道题、无关窗口、聊天内容、任务栏与网页边框。',
        '先判断用户当前要作答的是哪一道题，只转录那一道。判断依据（按优先级）：',
        '1) 有光标聚焦、已选中选项或已有作答输入的题；',
        '2) 位于页面主体作答区、带未作答 A./B./C./D. 选项的题；',
        '3) 题号最大的那道（说明正做到这里）；',
        '4) 面积最大、最完整可读的那道。',
        '必须忽略：任务栏、系统托盘、浏览器地址栏与书签栏、侧边栏、题号列表/答题卡、水印、' +
          '会议/聊天软件窗口、以及任何其他与本题无关的文字。',
        '若同时有两道题都像是候选，转录你选定的那道，并在最后单独一行输出 ' +
          'AMBIGUOUS: <一句话说另一道是什么>，不要合并两道题。',
        '若题干被滚动截断，只转录可见部分，不要凭常识补全缺失的选项或条件。',
      ]
    : [];
  return [
    {
      role: 'system',
      content: [
        '你是题目转录器。把截图里的题目原样转成文字，只输出题目本身。',
        ...locating,
        '要求：题干一字不改；选项保留原字母与原顺序（A./B./C./D. 各占一行）；',
        '有输入框/代码框时把已填写内容也转出来；不要作答、不要解释、不要重复说明是截图。',
        '若图中没有题目，只输出一行：NO_QUESTION',
      ].join('\n'),
    },
  ];
}

/** one multimodal turn: the screenshot plus the transcription instruction */
export function withScreenImage(messages: ChatMessage[], imageDataUrl: string): ChatMessage[] {
  return [
    ...messages,
    {
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: '按要求转录图中的题目。' },
      ],
      role: 'user',
    },
  ];
}

/**
 * The rules that make a live-coding answer sound like a person who has done it
 * before, rather than a template: one-line approach, the smallest readable
 * implementation, no ceremony the interviewer never asked for.
 */
const CODE_STYLE_RULES = [
  '写法要求（现场作答，按人写的样子）：',
  '- 第一行用一句话讲思路，然后直接写代码；不要「当然可以」「以下是我的解答」这类开场；',
  '- 只写题目要求的功能：不写测试、不写 main、不加参数校验框架、不做过度封装与抽象；',
  '- 变量名朴素可读（seen、res、left），不要浮夸命名与逐行注释；关键处一两个注释即可；',
  '- 能用标准库就用，不要为了炫技手写轮子；也不要顺手引入第三方库；',
  '- 复杂度写在代码后面一行说明（时间/空间），别展开推导；有坑就用一行点出；',
  '- 若题干信息不全，按最常见的题意做，并在末尾用一行说明你补的假设；',
  '- 不要输出免责声明、不要复述题目、不要给出多种语言版本（除非题目要求）。',
];

const APTITUDE_RULES = [
  '行测/客观题作答要求：',
  '- 先给结论：选项字母 + 选项原文（屏幕上选项可能被打乱，一律以屏幕上的字母为准）；',
  '- 再用不超过两句话讲依据，能口算的说出口算路径；不要长篇推导；',
  '- 拿不准时直说更倾向哪一项和为什么，不要含糊其辞。',
];

const ESSAY_RULES = [
  '申论/主观题作答要求：',
  '- 先给提纲（3-5 条，每条一句），再给可直接誊写的正文首段；',
  '- 用词正式、贴合材料，不编造材料里没有的数据与政策名称；',
  '- 字数控制在题目要求内，段落分明。',
];

const PERSONA_RULES = [
  '性格/心理测评作答要求：',
  '- 只输出「选哪一项 + 一句依据」，依据必须来自下面给定的人设；',
  '- 严格守住人设的前后一致：同一维度不得给出相反方向；反向表述的题要把方向反过来；',
  '- 除诚信/安全等硬性维度外，不要每题都选最极端一档（全部“非常符合”会命中装好与测谎题）。',
];

function systemFor(mode: ExamSubMode): string {
  switch (mode) {
    case 'technical':
      return ['你在帮用户现场作答技术/代码题。', ...CODE_STYLE_RULES].join('\n');
    case 'aptitude':
      return ['你在帮用户现场作答行测类客观题（言语理解、数量关系、判断推理、资料分析）与少量申论题。', ...APTITUDE_RULES, '', ...ESSAY_RULES].join('\n');
    case 'personality':
      return ['你在帮用户作答企业性格/心理测评。', ...PERSONA_RULES].join('\n');
    case 'open':
    default:
      return [
        '你在帮用户现场作答屏幕上的一道题（知识题、专业课、英语题等）。',
        '先给答案，再给不超过三句依据；不确定就说不确定并给出最可能的选项。',
      ].join('\n');
  }
}

export interface ExamAskInput {
  subMode: ExamSubMode;
  /** the question transcribed from the screen (or typed by the user) */
  question: string;
  /** extra instruction the user typed with this capture (may be empty) */
  instruction?: string;
  /** the bank block, when the user's own bank had this question */
  bankBlock?: string;
  /** the persona + ledger block for personality items */
  personaBlock?: string;
  /** a previous answer for the same screen (re-ask with a different instruction) */
  priorAnswer?: string;
  /** web results, when the bank had nothing and search is configured */
  webLines?: string[];
  answerLangZh?: boolean;
}

/**
 * The answer request. Everything volatile (bank hit, persona, web) goes in the
 * user turn: exam asks are one-shot, but keeping the system prompt byte-stable
 * per sub-mode still lets a prefix-caching provider skip the re-prefill.
 */
export function buildExamAskMessages(input: ExamAskInput): ChatMessage[] {
  const parts: string[] = [];
  if (input.personaBlock) parts.push(input.personaBlock);
  if (input.bankBlock) {
    parts.push(
      input.subMode === 'personality'
        ? `${input.bankBlock}\n（题库里已有该题的既定答法，照它选，并保证与上述人设一致。）`
        : `${input.bankBlock}\n（上面是用户自己题库里的原题与答案。以它为准作答：结论必须与之一致，只补充必要的简短依据；若与屏幕上的选项冲突，说明冲突并按屏幕选项重新判断。）`,
    );
  }
  if (input.webLines?.length) {
    parts.push(
      [
        '【网络检索】（题库里没有这道题，以下是刚检索到的资料，回答以它们为准）',
        ...input.webLines,
        '—— 只讲资料支持的内容，末尾用一行给出主要来源链接。',
      ].join('\n'),
    );
  }
  if (input.priorAnswer) {
    parts.push(`【上一次给出的答案】\n${input.priorAnswer.slice(0, 1500)}`);
  }
  parts.push(
    input.instruction?.trim()
      ? `【题目】\n${input.question.slice(0, MAX_SCREEN_TEXT_CHARS)}\n\n【我的补充要求】\n${input.instruction.trim()}`
      : `【题目】\n${input.question.slice(0, MAX_SCREEN_TEXT_CHARS)}`,
  );
  parts.push(input.subMode === 'aptitude' ? '请按格式作答。' : '请作答。');
  return [
    { role: 'system', content: systemFor(input.subMode) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** the block shown when the bank answered outright (no model call at all) */
export function bankAnswerHeadline(hit: {
  stem: string;
  answer: string;
  answerKey?: string;
  letter?: string;
}): string {
  const letter = hit.letter ?? hit.answerKey;
  return [letter ? `${letter}` : '', hit.answer].filter(Boolean).join('  ');
}

/** prompt for building the personality target from public research (one call) */
export function buildPersonaResearchMessages(
  role: string,
  company: string | undefined,
  webLines: string[],
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你在为企业性格测评制定“稳定可复现的目标画像”。根据下面的招聘方公开信息，',
        '推断该岗位在测评中被看重的特质，并给出该岗位候选人的合理定位（不是造假，是选择一致的自我呈现）。',
        '维度只能用这些 key：conscientiousness, detail, stability, cooperation, assertiveness, achievement, openness, integrity, resilience。',
        'level 取 -2..2 的整数；why 用一句中文说明依据（来自材料，不得编造公司政策）。',
        '只输出 JSON：{"role":"…","company":"…","targets":[{"dim":"…","level":1,"why":"…"}, …]}，不要代码块围栏。',
        '没有材料支持的维度就选 0，并在 why 里写明“无公开依据，取中性”。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `岗位：${role || '未指定'}`,
        company ? `公司：${company}` : '',
        '',
        webLines.length
          ? ['【检索到的公开信息】', ...webLines].join('\n')
          : '【检索到的公开信息】（无，按该岗位的通用要求给中性画像）',
        '',
        '请给出目标画像 JSON。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}
