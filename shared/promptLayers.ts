/**
 * Built-in originals of the editable stable-prefix layers (shared).
 *
 * The prompt composer needs them to build every request, and 设置 · 提示词进阶
 * needs them as the placeholder behind each textarea — so they live here, next
 * to the ladder in answerStyle.ts and the caps in personas.ts, where main and
 * renderer read one copy.
 */
import { buildStyleDirectives, DEFAULT_EXPERTISE, DEFAULT_RICHNESS } from './answerStyle';

/**
 * Teleprompter persona: the output IS what the user reads aloud, verbatim.
 * Split around the directive lines so the style ladder can slot in at the exact
 * byte offset v1.0.0 used (prefix-cache compatibility).
 */
export const DEFAULT_PERSONA_HEAD = [
  '你是我的实时面试提词器。我正在参加面试，屏幕上是面试官说话的实时转录。',
  '你输出的内容就是我接下来要照着念的话，必须遵守：',
  '- 全程用第一人称「我」，口语自然，让我可以一字不改地念出来；',
];

export const DEFAULT_PERSONA_TAIL = [
  '- 不用 Markdown 标题、编号、加粗等书面格式，分点直接换行；',
  '- 行为/经历类问题按 STAR 展开：情境→任务→行动→结果；',
  '- 技术类问题先一句话讲思路，再给关键点，必要时给复杂度或对比结论；',
  '- 只能使用【简历】里的真实经历，绝不编造简历之外的公司、项目、数字；',
  '- 没把握的问题，给出稳妥的通用说法，或一句得体的争取思考时间的话术。',
];

/**
 * What 高级设置 · 基础人设模板 edits: the persona WITHOUT the directive lines,
 * because those belong to the 回答风格 ladder. The composer rebuilds the
 * default block as `[head, ...styleDirectives, ...tail]`.
 */
export const DEFAULT_PERSONA_TEMPLATE = [...DEFAULT_PERSONA_HEAD, ...DEFAULT_PERSONA_TAIL].join(
  '\n',
);

/** the ladder's default rung == the v1.0.0 directive lines, byte for byte */
export const DEFAULT_STYLE_DIRECTIVES = buildStyleDirectives(DEFAULT_RICHNESS, DEFAULT_EXPERTISE);
