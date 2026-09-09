import { describe, it, expect } from 'vitest';
import { parseBankFile, parseCsvBank, parseInlineAnswerBank, parseJsonBank, parseTextBank } from '../shared/bankParse';

describe('parseTextBank (markdown/plain-text question banks)', () => {
  it('reads a multiple-choice block with 全角 markers and bold answer', () => {
    const [e] = parseTextBank(
      `## 下列哪一项不属于认知风格的特点？

- A. 独立性
- B. 稳定性
- C. 强制性
- D. 一致性

**答案：C**
**解析：** 认知风格是偏好而非对错，不存在强制。`,
      '风格.md',
    );
    expect(e.kind).toBe('mc');
    expect(e.stem).toBe('下列哪一项不属于认知风格的特点');
    expect(e.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(e.answerKey).toBe('C');
    expect(e.answerText).toBe('强制性');
    expect(e.answer).toBe('强制性');
    expect(e.explanation).toContain('偏好');
  });

  it('accepts A.、A)、（A） and 甲乙丙 option spellings', () => {
    const one = parseTextBank(`题目：1+1 等于几？
A．一
B．二
C．三
答案：B`, 'a.md')[0];
    const two = parseTextBank(`题干：1+1 等于几？
（A）一
（B）二
（C）三
正确答案：（B）二`, 'b.md')[0];
    const three = parseTextBank(`1+1 等于几？
甲．一
乙．二
丙．三
答案：乙`, 'c.md')[0];
    expect(one.answerKey).toBe('B');
    expect(two.answerKey).toBe('B');
    expect(three.answerKey).toBe('B');
    expect(two.answerText).toBe('二');
  });

  it('recovers the letter when the answer was written as option text', () => {
    const e = parseTextBank(
      `某文件 8 页，每页 1024 字节，共占多少 KB？
A. 4
B. 8
C. 16
答案：8`,
      'x.md',
    )[0];
    expect(e.answerKey).toBe('B');
    expect(e.answerText).toBe('8');
  });

  it('reads an open question with a multi-line answer and 标签', () => {
    const [e] = parseTextBank(
      `【题】请简述快速排序的平均复杂度与最坏情况。
【答】平均 O(n log n)。
最坏发生在每次划分极不平衡时，为 O(n^2)。
【解析】可通过随机化选取基准规避。
标签：算法, 排序`,
      'alg.md',
    );
    expect(e.kind).toBe('open');
    expect(e.answer).toContain('平均 O(n log n)');
    expect(e.answer).toContain('O(n^2)');
    expect(e.explanation).toContain('随机化');
    expect(e.tags).toEqual(['算法', '排序']);
  });

  it('handles a numbered list of questions in one file', () => {
    const entries = parseTextBank(
      `1. 2^10 等于多少？
A. 512
B. 1024
答案：B

2. 1KB 等于多少字节？
A. 1000
B. 1024
答案：B`,
      'n.md',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].stem).toBe('2^10 等于多少');
    expect(entries[1].answerKey).toBe('B');
  });

  it('keeps fenced code inside an open answer', () => {
    const [e] = parseTextBank(
      `题目：写出去重并保持顺序的 Python 片段
答案：
\`\`\`python
def dedupe(seq):
    seen = set()
    return [x for x in seq if not (x in seen or seen.add(x))]
\`\`\``,
      'code.md',
    );
    expect(e.kind).toBe('open');
    expect(e.answer).toContain('def dedupe');
  });

  it('survives obsidian syntax in a stem', () => {
    const [e] = parseTextBank(`## 说说 [[CAP 定理]] 与 #一致性 的关系？
答：三者不可兼得，分区容错必选。`, 'o.md');
    expect(e.stem).toBe('说说 CAP 定理 与 一致性 的关系');
  });

  it('drops an mc block whose answer cannot be resolved, keeps the rest', () => {
    const entries = parseTextBank(
      `题目：这题没给答案
A. 一
B. 二

题目：这题给了答案
A. 一
B. 二
答案：A`,
      'p.md',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].stem).toBe('这题给了答案');
  });

  it('does not treat prose before the first question as a stem', () => {
    const entries = parseTextBank(`这一段是章节说明，随便写点背景内容。
题目：真正的题目是什么？
答案：在这里。`, 'q.md');
    expect(entries).toHaveLength(1);
    expect(entries[0].stem).toBe('真正的题目是什么');
  });
});

describe('parseJsonBank / parseCsvBank', () => {
  it('reads a JSON array with Chinese field names', () => {
    const json = JSON.stringify([
      { 题目: '下列哪个是NoSQL？', 选项: ['MySQL', 'Redis', 'PostgreSQL'], 答案: 'B', 解析: 'Redis 是非关系型', 标签: ['数据库'] },
    ]);
    const [e] = parseJsonBank(json, 'bank.json');
    expect(e.stem).toBe('下列哪个是NoSQL');
    expect(e.options[1]).toEqual({ key: 'B', text: 'Redis' });
    expect(e.answerKey).toBe('B');
    expect(e.answerText).toBe('Redis');
    expect(e.tags).toEqual(['数据库']);
  });

  it('reads an object-shaped JSON with options as a map', () => {
    const [e] = parseJsonBank(
      JSON.stringify({ questions: [{ stem: 'x+3=7，x=?', options: { A: 3, B: 4, C: 5 }, answer: 'B' }] }),
      'b.json',
    );
    expect(e.answerKey).toBe('B');
    expect(e.options).toHaveLength(3);
  });

  it('ignores malformed JSON instead of throwing', () => {
    expect(parseJsonBank('{not json', 'x.json')).toEqual([]);
  });

  it('reads a CSV with pipe-separated options', () => {
    const csv = [
      '题干,选项,答案,解析,标签',
      '"2+2=?","1|2|4","C","加法","算术"',
      '下列哪个是质数,2|4|6,A,"能被1和自身整除","数论"',
    ].join('\n');
    const entries = parseCsvBank(csv, 'bank.csv');
    expect(entries).toHaveLength(2);
    expect(entries[0].answerKey).toBe('C');
    expect(entries[0].answerText).toBe('4');
    expect(entries[1].tags).toEqual(['数论']);
  });
});

/**
 * A generated PDF bank (the 北森 pack is 285 MB of it) flows the answer into the
 * same text stream as the question, hard-wrapped anywhere, with the question
 * number alone on its own line. The line-anchored reader finds 67 of 702
 * questions in such a file, so this shape is parsed by answer, not by line.
 */
const FLOWED = `言语理解推理题
1
高新科技成果转化为生产力，有一个客观的转化过程。从基础理论到技术研究，进而设计、开发、
研制出样品、样机。        对这段话最准确的复述是:
A:高新科技成果转化为生产力要经许多环节
B:解决经济规模生产的工艺问题是首要任务
C:解决工艺问题与设计开发同等重要
D:转化要做许多具体工作，主要是解决工艺问题
正确答案:D
解析:第一步，分析文段。因此，选择 D 选项。要点:A 项:偏离重点。
2
虽然春节、清明、端午和中秋被称为四大传统节日，中秋要年轻许多。        下面理解正确的是
A:中秋节在宋代以前已是节日
B:端午节在先秦已形成独立节日
C:清明节的传说未必可信
D:中秋节形成于大唐
正确答案:C
解析:由题意可知 A 错误。故本题选 C。
3
每个人在学习新事物时都会有恐惧心态，但如果因此而(　　)，就学不到新知识。
A:因噎废食
B:瞻前顾后
C:首鼠两端
D:视为畏途
正确答案:D
解析:题中意为害怕就不做。因此选择 D。`;

describe('parseInlineAnswerBank (answer-anchored PDF dumps)', () => {
  it('needs a dump before it fires — a handwritten note is never re-cut', () => {
    expect(parseInlineAnswerBank(FLOWED, '北森.pdf')).toHaveLength(3);
    expect(parseInlineAnswerBank('题目：1+1?\nA. 1\nB. 2\n答案：B', 'note.md')).toEqual([]);
  });

  it('pairs each stem with its own answer instead of its neighbour’s', () => {
    const entries = parseInlineAnswerBank(FLOWED, '北森.pdf');
    expect(entries.map((e) => e.answerKey)).toEqual(['D', 'C', 'D']);
    expect(entries[0].stem).toContain('高新科技成果');
    expect(entries[1].stem).toContain('四大传统节日');
    expect(entries[2].stem).toContain('恐惧心态');
  });

  it('keeps the previous question’s 解析 out of the next stem', () => {
    const [, second] = parseInlineAnswerBank(FLOWED, '北森.pdf');
    expect(second.stem).not.toContain('分析文段');
    expect(second.stem).not.toContain('偏离重点');
    expect(second.explanation).toContain('由题意可知'); // its own reasoning survives
    expect(second.explanation).not.toContain('分析文段'); // not the previous answer's
    expect(second.explanation).not.toMatch(/\s3$/); // and not the next question's number
  });

  it('splits inline options by letter and keeps the 提问 tail', () => {
    const [e] = parseInlineAnswerBank(FLOWED, '北森.pdf');
    expect(e.kind).toBe('mc');
    expect(e.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(e.answerText).toBe('转化要做许多具体工作，主要是解决工艺问题');
    expect(e.stem).toContain('最准确的复述');
  });

  it('reads 判断题 answered with a word rather than a letter', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `${i + 1}\n中国是全球最大的啤酒生产国。（${'　'.repeat(2)}）\n正确答案:错误`).join('\n');
    const entries = parseInlineAnswerBank(rows, '判断.pdf');
    expect(entries.length).toBeGreaterThan(10);
    expect(entries[0].answer).toContain('错误');
  });

  it('parseBankFile prefers it when it reads more of the file', () => {
    const r = parseBankFile('北森.pdf', FLOWED);
    expect(r.entries).toHaveLength(3);
    expect(r.entries[1].answerKey).toBe('C');
  });
});

describe('parseBankFile (one entry point)', () => {
  it('routes by extension and falls back to text grammar on bad JSON', () => {
    const ok = parseBankFile('a.json', '[{"题目":"1+1?","选项":"1|2","答案":"B"}]');
    expect(ok.format).toBe('json');
    const fell = parseBankFile('broken.json', '题目：1+1?\nA. 1\nB. 2\n答案：B');
    expect(fell.format).toBe('text');
    expect(fell.entries[0].answerKey).toBe('B');
  });

  it('harvests 问:/答: notes as open entries (a prepared-answer note is a bank)', () => {
    const r = parseBankFile('notes.md', '问：你如何保证消息不丢失？\n答：生产端 acks=all，消费端手动提交位移。\n');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].stem).toBe('你如何保证消息不丢失');
    expect(r.entries[0].answer).toContain('acks=all');
  });

  it('does not duplicate a stem the text grammar already produced', () => {
    const r = parseBankFile('d.md', '问：什么是幂等？\n答：重复执行结果一致。\n');
    expect(r.entries.filter((e) => e.stem.includes('幂等'))).toHaveLength(1);
  });
});
