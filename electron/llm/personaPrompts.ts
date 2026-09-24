/**
 * v1.0.1 A5: the one-off prompt behind 「从简历/JD 生成初稿」 in the answer-persona
 * library. These builders sit OUTSIDE the answer path — nothing here may enter
 * the cached stable prefix (see electron/llm/prompts.ts for that pipeline).
 */
import type { ChatMessage } from './adapter';
import {
  JD_BUDGET,
  JD_PRIORITY,
  MAX_BACKGROUND_CHARS,
  RESUME_BUDGET,
  RESUME_PRIORITY,
  smartClip,
  type AnswerLang,
} from './prompts';
import { PERSONA_TEXT_MAX } from '../../shared/personas';

export interface PersonaDraftInput {
  resume?: string;
  jd?: string;
  lang: AnswerLang;
}

/** Ask the model to write the user's own answer persona from real material. */
export function buildPersonaDraftMessages(input: PersonaDraftInput): ChatMessage[] {
  const r = (input.resume ?? '').trim();
  const j = (input.jd ?? '').trim();
  const refs = [
    r ? `【简历】\n${smartClip(r, j ? RESUME_BUDGET : MAX_BACKGROUND_CHARS, RESUME_PRIORITY)}` : '',
    j ? `【岗位JD】\n${smartClip(j, r ? JD_BUDGET : MAX_BACKGROUND_CHARS, JD_PRIORITY)}` : '',
  ].filter(Boolean);
  return [
    {
      role: 'system',
      content: [
        '你在为实时面试提词器撰写一份「应答人设」：一段第一人称的自我设定，之后每次回答都会原样带进系统提示词，',
        '用来固定我的口吻、立场与详略取舍。要求：',
        '- 全程第一人称「我」，5-8 行短句，总长不超过 400 字；',
        '- 只写定位与说话方式（年限、擅长方向、表达偏好），不得新增材料里没有的公司、项目或数字；',
        '- 直接输出这段设定本身，不要标题、不要编号、不要引号、不要任何解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        refs.length ? refs.join('\n\n') : '（我没有提供简历或岗位JD，请按通用技术面试场景写一份中性的设定。）',
        '',
        `请用【${input.lang === 'english' ? '英文' : '中文'}】撰写这份应答人设。`,
      ].join('\n'),
    },
  ];
}

/**
 * The reply is pasted straight into the persona field: drop the code fence some
 * models wrap it in, and hold it to the budget the store will clamp to anyway.
 */
export function finalizePersonaDraft(raw: string): string {
  const body = raw
    .split('\n')
    .filter((l) => !/^\s*```/.test(l))
    .join('\n')
    .trim();
  return body.length > PERSONA_TEXT_MAX ? body.slice(0, PERSONA_TEXT_MAX) : body;
}
