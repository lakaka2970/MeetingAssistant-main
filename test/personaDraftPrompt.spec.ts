import { describe, expect, it } from 'vitest';
import { buildPersonaDraftMessages, finalizePersonaDraft } from '../electron/llm/personaPrompts';
import { PERSONA_TEXT_MAX } from '../shared/personas';

describe('buildPersonaDraftMessages (v1.0.1 A5: 应答人设初稿)', () => {
  const resume = '项目经历：负责实时转录系统的 ASR 链路。';
  const jd = '职责：高并发服务端架构。';

  it('is a system + user pair that asks for a first-person persona, plain text only', () => {
    const m = buildPersonaDraftMessages({ resume, jd, lang: 'chinese' });
    expect(m).toHaveLength(2);
    expect(m[0].role).toBe('system');
    expect(m[1].role).toBe('user');
    expect(m[0].content).toContain('第一人称');
    expect(m[0].content).toContain('应答人设');
    // the output is pasted straight into a settings field — no JSON, no fences
    expect(m[0].content).toContain('不要');
  });

  it('quotes both material slots when both exist', () => {
    const m = buildPersonaDraftMessages({ resume, jd, lang: 'chinese' });
    expect(m[1].content).toContain('【简历】');
    expect(m[1].content).toContain(resume);
    expect(m[1].content).toContain('【岗位JD】');
    expect(m[1].content).toContain(jd);
  });

  it('omits an empty slot instead of padding it', () => {
    expect(buildPersonaDraftMessages({ resume, lang: 'chinese' })[1].content).not.toContain('【岗位JD】');
    expect(buildPersonaDraftMessages({ jd, lang: 'chinese' })[1].content).not.toContain('【简历】');
  });

  it('clips oversized material with the same priority clip answers use', () => {
    const filler = '自我评价：热爱学习，性格开朗。'.repeat(400);
    const m = buildPersonaDraftMessages({ resume: `${filler}\n\n${resume}\n\n${filler}`, lang: 'chinese' });
    expect(m[1].content).toContain(resume);
    expect(m[1].content.length).toBeLessThan(9000);
  });

  it('asks for the draft in the current answer language', () => {
    expect(buildPersonaDraftMessages({ resume, lang: 'chinese' })[1].content).toContain('中文');
    expect(buildPersonaDraftMessages({ resume, lang: 'english' })[1].content).toContain('英文');
  });

  it('is deterministic and timestamp-free (same shape as the cached prompts)', () => {
    const a = buildPersonaDraftMessages({ resume, jd, lang: 'chinese' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(buildPersonaDraftMessages({ resume, jd, lang: 'chinese' })));
    expect(JSON.stringify(a)).not.toMatch(/\d{13}|\d{4}-\d{2}-\d{2}/);
  });
});

describe('finalizePersonaDraft (v1.0.1 A5)', () => {
  it('strips code fences and outer whitespace', () => {
    expect(finalizePersonaDraft('```\n  我是十年后端工程师。\n```')).toBe('我是十年后端工程师。');
    expect(finalizePersonaDraft('```plaintext\n我是十年后端工程师。\n```')).toBe('我是十年后端工程师。');
  });

  it('clamps to the stored persona budget', () => {
    expect(finalizePersonaDraft('字'.repeat(PERSONA_TEXT_MAX + 300))).toHaveLength(PERSONA_TEXT_MAX);
  });

  it('leaves ordinary multi-line text alone', () => {
    const t = '我是十年后端工程师。\n讲话先给结论。';
    expect(finalizePersonaDraft(t)).toBe(t);
  });
});
