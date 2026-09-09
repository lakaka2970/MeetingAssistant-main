import { describe, it, expect } from 'vitest';
import {
  docRole,
  joinQuestionsAndAnswers,
  parseAnswersDoc,
  parseQuestionsDoc,
  splitSections,
} from '../shared/answerKey';

/** the shapes the real packs print (numbers restart per 部分; 每空 multi-blank) */
const STUDENT = `1
中 国 东 方 航 空集 团 有 限 公 司
第一部分        英语
单项选择
1.      He _______ himself a superhero and goes out at night.
A. presumes     B. assumes      C. suppose      D. imagines
2.      Swimming is an all-body workout. It _______ small muscle groups.
A. works        B. keeps        C. helps        D. heals

第二部分        数量关系
1. 2，3，12，37，（ ）
A. 52     B. 71     C. 86     D. 92
`;

/** the same paper's answer file: numbering RESTARTS after 第二部分 */
const ANSWER = `第一部分        英语
单项选择
1.【答案】D。解析：考查动词词义辨析。句意为“他把自己想象成超级英雄”。故本题答案为 D。
2.【答案】A。解析：它可以锻炼被忽视的小肌肉群。故本题答案为 A。

第二部分        数量关系
1.【答案】C。解析：作差得 1、9、25，为 1、3、5 的平方，下一项 49，故 37+49=86。
`;

/** a grouped speed-check answer sheet, the other common layout */
const GROUPED_ANSWER = `第一部分        英语
单项选择题
1~4：BACD
5.【答案】A。解析：略。
`;

const GROUPED_STUDENT = `第一部分        英语
1. 一？
A. 甲     B. 乙     C. 丙     D. 丁
2. 二？
A. 甲     B. 乙     C. 丙     D. 丁
3. 三？
A. 甲     B. 乙     C. 丙     D. 丁
4. 四？
A. 甲     B. 乙     C. 丙     D. 丁
5. 五？
A. 甲     B. 乙     C. 丙     D. 丁
`;

describe('splitSections', () => {
  it('splits on the 题型 heading and ignores body sentences that mention one', () => {
    const secs = splitSections(STUDENT);
    // the preamble (page number + company name) is its own unlabelled block;
    // 第一部分 英语 carries no items of its own, so the 题型 heading below it
    // is what the items belong to — and the answer paper uses the same title,
    // which is why the join keys on the title rather than the position
    expect(secs.map((s) => s.title)).toEqual(['', '单项选择题', '数量关系']);
    const noise = splitSections(`公司要求员工具备选择的能力。\n判断一个命题真假需要依据。\n1. 真正的题？\nA. 甲 B. 乙`);
    expect(noise.map((s) => s.title)).toEqual(['']);
    expect(noise[0].lines.length).toBe(4);
  });

  it('treats a heading repeated right away as the same section', () => {
    const secs = splitSections('英语\n单项选择\n英语\n1. 题？\nA. 甲 B. 乙');
    expect(secs.length).toBeLessThanOrEqual(2);
  });
});

describe('parseQuestionsDoc', () => {
  it('parses stems, per-line options and keeps section + printed number', () => {
    const qs = parseQuestionsDoc(STUDENT);
    expect(qs).toHaveLength(3);
    expect(qs[0]).toMatchObject({ no: 1, section: '单项选择题', sectionIndex: 1 });
    expect(qs[0].options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(qs[0].stem).toContain('superhero');
    // 数量关系 restarts at 1 in BOTH papers — the join must key on
    // (section, number), or the English answer lands on the maths question
    expect(qs[2]).toMatchObject({ no: 1, section: '数量关系', sectionIndex: 2 });
  });

  it('collapses the wide gaps a two-blank option prints with', () => {
    const [q] = parseQuestionsDoc(`第一部分 言语\n1. 空格题。\nA. 流光溢彩      巧夺天工     B. 美轮美奂      登峰造极`);
    expect(q.options[0].text).toBe('流光溢彩 巧夺天工');
  });
});

describe('parseAnswersDoc', () => {
  it('reads 【答案】X。解析：… and keeps the explanation', () => {
    const as = parseAnswersDoc(ANSWER);
    expect(as.find((a) => a.sectionIndex === 0 && a.no === 1)?.letter).toBe('D');
    const second = as.find((a) => a.sectionIndex === 1 && a.no === 1);
    expect(second?.letter).toBe('C');
    expect(second?.explanation).toContain('作差');
  });

  it('reads grouped 1~4：BACD keys', () => {
    const as = parseAnswersDoc(GROUPED_ANSWER);
    const first = as.filter((a) => a.sectionIndex === 0);
    expect(first.find((a) => a.no === 1)?.letter).toBe('B');
    expect(first.find((a) => a.no === 4)?.letter).toBe('D');
    expect(first.find((a) => a.no === 5)?.letter).toBe('A');
  });

  it('does not invent an answer for a number the sheet skips', () => {
    const as = parseAnswersDoc('第一部分 英语\n1.【答案】A。解析：略。');
    expect(as.some((a) => a.no === 7)).toBe(false);
  });
});

describe('joinQuestionsAndAnswers', () => {
  it('joins per (section, number) even when numbering restarts', () => {
    const { entries, unanswered } = joinQuestionsAndAnswers(
      parseQuestionsDoc(STUDENT),
      parseAnswersDoc(ANSWER),
      '东航.pdf',
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ answerKey: 'D', answerText: 'imagines' });
    expect(entries[1]).toMatchObject({ answerKey: 'A', answerText: 'works' });
    // the restarted 「1.」 in 第二部分 must land on the 数量关系 item, not 英语
    expect(entries[2]).toMatchObject({ answerKey: 'C', answerText: '86', stem: expect.stringContaining('37') });
    expect(unanswered).toBe(0);
  });

  it('joins grouped keys and reports what it could not answer', () => {
    const { entries } = joinQuestionsAndAnswers(
      parseQuestionsDoc(GROUPED_STUDENT),
      parseAnswersDoc(GROUPED_ANSWER),
      'g.pdf',
    );
    expect(entries.map((e) => e.answerKey)).toEqual(['B', 'A', 'C', 'D', 'A']);
  });

  it('refuses a letter that is not among the options (shuffled paper)', () => {
    const qs = parseQuestionsDoc('第一部分 英语\n1. 题？\nA. 甲 B. 乙 C. 丙');
    const as = parseAnswersDoc('第一部分 英语\n1.【答案】D。解析：略。');
    const { entries, unanswered } = joinQuestionsAndAnswers(qs, as, 'x.pdf');
    expect(entries[0].answerKey).toBeUndefined();
    expect(unanswered).toBe(1);
  });

  it('tags each entry with its section so recall can filter by 题型', () => {
    const { entries } = joinQuestionsAndAnswers(parseQuestionsDoc(STUDENT), parseAnswersDoc(ANSWER), 'x.pdf');
    expect(entries[2].tags).toContain('数量关系');
  });
});

describe('docRole', () => {
  it('classifies by name and by content markers', () => {
    expect(docRole('X-学生版.pdf', '1. 题？')).toBe('questions');
    expect(docRole('X-答案版.pdf', '1.【答案】A')).toBe('answers');
    expect(docRole('杂题.pdf', '1.【答案】A\n2.【答案】B\n3.【答案】C\n4.【答案】D\n5.【答案】A')).toBe('answers');
    expect(docRole('杂题.pdf', '1. 题？\nA. 甲')).toBe('mixed');
  });
});
