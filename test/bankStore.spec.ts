import { describe, it, expect } from 'vitest';
import { BankStore, decideBankAnswer, formatBankBlock, mergeDuplicateEntries, reanchorAnswer } from '../shared/bankStore';
import type { BankEntry } from '../shared/bankParse';
import type { BankVerdict } from '../shared/bankStore';

const APTITUDE = `# 言语与常识

1. 下列哪一项不属于认知风格的特点？
A. 独立性
B. 稳定性
C. 强制性
D. 一致性
答案：C
解析：认知风格是偏好，无对错强制。

2. 认知风格是否具有跨情境的一致性？
答案：是
解析：跨情境稳定是认知风格的核心特征。
`;

const TECH = `问：快速排序的平均与最坏复杂度
答：平均 O(n log n)，最坏 O(n^2)，随机化基准可规避。

【题】进程与线程的区别
【答】进程是资源分配单位，线程是调度单位；同进程线程共享地址空间。
`;

function store(): BankStore {
  const s = new BankStore();
  s.replace('aptitude', [{ ref: '行测-风格.md', text: APTITUDE }], 'D:/bank/aptitude');
  s.replace('technical', [{ ref: ' OS.md', text: TECH }], 'D:/bank/tech');
  return s;
}

describe('BankStore — per-sub-mode banks, isolated by construction', () => {
  it('parses both banks and reports per-mode counts', () => {
    const s = store();
    const st = s.status();
    expect(st.aptitude.entries).toBe(2);
    expect(st.aptitude.mc).toBe(1);
    expect(st.aptitude.dir).toBe('D:/bank/aptitude');
    expect(st.technical.entries).toBe(2);
    expect(st.open.entries).toBe(0);
    expect(s.size).toBe(4);
  });

  it('a bank hit returns the stored answer and the option letter', () => {
    const { mode, best } = s0().search('aptitude', '下列哪一项不属于认知风格的特点？');
    expect(mode).toBe('bank');
    expect(best?.entry.answerKey).toBe('C');
    expect(best?.entry.answerText).toBe('强制性');
    expect(best?.confidence).toBe('exact');
  });

  it('an unanswerable question is "none", not a bad guess', () => {
    const { mode, best } = s0().search('aptitude', '下列哪个是量子加密的协议');
    expect(mode).toBe('none');
    expect(best).toBeUndefined();
  });

  it('banks do not cross sub-modes', () => {
    const s = store();
    // the 快排 question lives in the technical bank only
    expect(s.search('aptitude', '快速排序的平均与最坏复杂度').mode).toBe('none');
    expect(s.search('technical', '快速排序的平均与最坏复杂度').best?.entry.answer).toContain('O(n log n)');
  });

  it('replacing a bank drops its old entries entirely', () => {
    const s = store();
    s.replace('aptitude', [{ ref: 'new.md', text: '题目：只有一题？\n答案：就一题。' }], 'D:/other');
    const st = s.status();
    expect(st.aptitude.entries).toBe(1);
    expect(st.aptitude.dir).toBe('D:/other');
    expect(s.search('aptitude', '下列哪一项不属于认知风格的特点').mode).toBe('none');
  });

  it('searchAll surfaces the mode that answered (one capture, no pre-classify)', () => {
    const hits = store().searchAll('进程与线程的区别');
    const answered = hits.filter((h) => h.verdict.mode !== 'none');
    expect(answered.map((h) => h.mode)).toEqual(['technical']);
  });

  it('list() gives the panel something to browse and clear() empties a mode', () => {
    const s = store();
    expect(s.list('technical').map((e) => e.stem)).toContain('快速排序的平均与最坏复杂度');
    s.clear('technical');
    expect(s.status().technical.entries).toBe(0);
    expect(s.status().aptitude.entries).toBe(2);
  });

  it('never answers with an entry that has no answer', () => {
    const s = new BankStore();
    // what the PDF join produces for a 材料子题 whose key lives in another
    // section: the stem is searchable, the answer is not known
    s.replaceEntries(
      'open',
      [
        {
          id: 'open#0',
          stem: '下面哪一项最能概括材料的主旨',
          kind: 'mc',
          options: [
            { key: 'A', text: '甲' },
            { key: 'B', text: '乙' },
          ],
          answer: '',
          tags: [],
          ref: '阅读.pdf',
          line: 1,
        },
      ],
      'D:/x',
    );
    expect(s.list('open')).toHaveLength(1);
    const v = s.search('open', '下面哪一项最能概括材料的主旨？');
    expect(v.mode).toBe('none');
    expect(v.best).toBeUndefined();
  });

  it('a fragment of a stem does not become a confident hit', () => {
    const v = s0().search('aptitude', '的主旨');
    expect(['none', 'hint']).toContain(v.mode);
  });

  it('refuses a hit built from a bare letter or a wrapped fragment', () => {
    const s = new BankStore();
    s.replaceEntries(
      'aptitude',
      [
        // 「来克服它的」: a stem cut by a PDF line wrap, with an essay answer
        { id: 'a#0', stem: '来克服它的', kind: 'open', options: [], answer: '【高分示范】很长的范文内容', tags: [], ref: 'p.pdf', line: 1 },
        // a key that points at options this entry never had
        { id: 'a#1', stem: '这道题的选项在别处', kind: 'mc', options: [], answer: 'C', tags: [], ref: 'p.pdf', line: 2 },
        // a healthy objective entry
        {
          id: 'a#2',
          stem: '下列哪一项不属于认知风格的特点',
          kind: 'mc',
          options: [
            { key: 'A', text: '独立性' },
            { key: 'B', text: '强制性' },
          ],
          answer: '强制性',
          answerKey: 'B',
          tags: [],
          ref: 'p.pdf',
          line: 3,
        },
      ],
      'D:/x',
    );
    expect(s.search('aptitude', '来克服它的').mode).toBe('none');
    expect(s.search('aptitude', '这道题的选项在别处').mode).toBe('none');
    expect(s.search('aptitude', '下列哪一项不属于认知风格的特点').mode).toBe('bank');
  });

  it('survives garbage without throwing', () => {
    const s = new BankStore();
    expect(() => s.replace('open', [{ ref: 'a.md', text: '' }, { ref: 'b.json', text: '{oops' }])).not.toThrow();
    expect(s.status().open.entries).toBe(0);
    expect(s.search('open', '任意问题').mode).toBe('none');
  });
});

describe('reanchorAnswer — an OA screen shuffles the options', () => {
  const entry = {
    answerKey: 'C',
    answerText: '强制性',
    options: [
      { key: 'A', text: '独立性' },
      { key: 'B', text: '稳定性' },
      { key: 'C', text: '强制性' },
      { key: 'D', text: '一致性' },
    ],
  };

  it('keeps the letter when the screen order matches the bank', () => {
    const r = reanchorAnswer(entry, entry.options.map((o) => o.text));
    expect(r).toEqual({ letter: 'C', text: '强制性', reanchored: true });
  });

  it('follows the option text to its NEW letter', () => {
    const shuffled = ['一致性', '强制性', '独立性', '稳定性'];
    const r = reanchorAnswer(entry, shuffled);
    expect(r?.letter).toBe('B');
    expect(r?.text).toBe('强制性');
    expect(r?.reanchored).toBe(true);
  });

  it('refuses to claim an answer when the options are a different variant', () => {
    const r = reanchorAnswer(entry, ['完全相反的一个选项', '另一个不相干选项', '第三个也不相干']);
    expect(r).toBeUndefined();
  });

  it('falls back to the bank letter when no screen options were read', () => {
    const r = reanchorAnswer(entry, []);
    expect(r).toEqual({ letter: 'C', text: '强制性', reanchored: false });
  });

  it('formats the injected block for the model', () => {
    const s = s0();
    const hit = s.search('aptitude', '下列哪一项不属于认知风格的特点').best!;
    const block = formatBankBlock(hit, ['一致性', '强制性', '独立性', '稳定性']);
    expect(block).toContain('【题库命中】');
    expect(block).toContain('答案：B （强制性）');
    expect(block).toContain('解析：认知风格是偏好');
  });
});

const opts = (...pairs: [string, string][]) => pairs.map(([key, text]) => ({ key, text }));
const q = (id: string, stem: string, answerKey: string, options = opts(['A', '对称图形'], ['B', '旋转图形'], ['C', '轴对称'], ['D', '中心对称']), explanation?: string): BankEntry => ({
  id,
  stem,
  kind: 'mc',
  options,
  answer: answerKey,
  answerKey,
  answerText: options.find((o) => o.key === answerKey)?.text,
  explanation,
  tags: [],
  ref: `${id}.pdf`,
  line: 1,
});

describe('mergeDuplicateEntries — one question, several contradictory packs', () => {
  const STEM = '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性';

  it('folds unanimous duplicates and keeps the fullest explanation', () => {
    const m = mergeDuplicateEntries([
      q('a#0', STEM, 'D'),
      q('b#0', STEM, 'D', undefined, '逐项分析后选择 D，规律为翻转。'.repeat(4)),
    ]);
    expect(m.entries).toHaveLength(1);
    expect(m.duplicates).toBe(1);
    expect(m.conflicts).toBe(0);
    expect(m.entries[0].id).toBe('b#0');
  });

  it('follows the majority but records the dissent', () => {
    const m = mergeDuplicateEntries([q('a#0', STEM, 'D'), q('b#0', STEM, 'D'), q('c#0', STEM, 'B')]);
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].answerKey).toBe('D');
    expect(m.entries[0].explanation).toContain('不同答案');
    expect(m.entries[0].explanation).toContain('B');
  });

  it('refuses to pick a side when the packs tie', () => {
    const m = mergeDuplicateEntries([q('a#0', STEM, 'D'), q('b#0', STEM, 'B')]);
    expect(m.conflicts).toBe(1);
    expect(m.entries[0].answerKey).toBeUndefined();
    expect(m.entries[0].kind).toBe('open');
    expect(m.entries[0].answer).toContain('不一致');
  });

  it('leaves different questions alone even when the stem is identical', () => {
    // same instruction, different options ⇒ genuinely different items
    const m = mergeDuplicateEntries([
      q('a#0', STEM, 'D'),
      q('b#0', STEM, 'A', opts(['A', '收入增长'], ['B', '成本下降'], ['C', '人数稳定'], ['D', '利润波动'])),
    ]);
    expect(m.entries).toHaveLength(2);
    expect(m.duplicates).toBe(0);
  });

  it('is applied by the store, so no caller can skip it', () => {
    const s = new BankStore();
    s.replaceEntries('aptitude', [q('a#0', STEM, 'D'), q('b#0', STEM, 'D')]);
    expect(s.status().aptitude.entries).toBe(1);
  });
});

describe('decideBankAnswer — the single gate between a bank hit and an answer', () => {
  const STEM = '某出版社发布一则招聘启事，最恰当的应聘材料投递方式是下列哪一项，请选出正确答案';
  const verdict = (best: BankEntry, others: BankEntry[] = [], confidence: 'exact' | 'strong' = 'exact'): BankVerdict => ({
    mode: 'bank',
    best: { entry: best, score: 1, cover: 1, confidence },
    others: others.map((e, i) => ({ entry: e, score: 1 - i * 0.01, cover: 1, confidence })),
    ms: 0,
  });
  const screen = (e: BankEntry) => e.options.map((o) => o.text);

  it('answers directly on an original hit that is objective and anchored', () => {
    const e = q('a#0', STEM, 'D');
    const d = decideBankAnswer(verdict(e), screen(e));
    expect(d).toMatchObject({ letter: 'D', direct: true, disagree: false });
  });

  it('hands a near-miss stem to the model instead of printing it as fact', () => {
    const e = q('a#0', STEM, 'D');
    expect(decideBankAnswer(verdict(e, [], 'strong'), screen(e)).direct).toBe(false);
  });

  it('will not claim a letter for an open entry', () => {
    const e = { ...q('a#0', STEM, 'D'), kind: 'open' as const, answerKey: undefined, answer: '书面应聘材料一份' };
    expect(decideBankAnswer(verdict(e), []).direct).toBe(false);
  });

  it('will not claim a letter it cannot anchor onto the screen options', () => {
    const e = q('a#0', STEM, 'D');
    expect(decideBankAnswer(verdict(e), ['毫不相干的一项', '另一项不相干', '第三项也不相干', '第四项']).direct).toBe(false);
  });

  it('surfaces a tie that answers differently rather than choosing one', () => {
    const a = q('a#0', STEM, 'D');
    const b = q('b#0', STEM, 'B');
    const d = decideBankAnswer(verdict(a, [b]), screen(a));
    expect(d.disagree).toBe(true);
    expect(d.direct).toBe(false);
    expect(d.near).toHaveLength(2);
  });

  it('tolerates a duplicate that agrees with it', () => {
    const a = q('a#0', STEM, 'D');
    expect(decideBankAnswer(verdict(a, [q('b#0', STEM, 'D')]), screen(a))).toMatchObject({ disagree: false, direct: true });
  });

  it('refuses a stem that is only the instruction — 图形推理 lives in the figure', () => {
    const e = q('a#0', '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性', 'D');
    const v = { ...verdict(e), stemCopies: 34 };
    const d = decideBankAnswer(v, screen(e));
    expect(d.best?.confidence).toBe('exact'); // the text matched perfectly…
    expect(d.unique).toBe(false); // …and it matched 34 other items just as well
    expect(d.direct).toBe(false);
  });

  it('counts shared stems through the store, not by trusting the caller', () => {
    const s = new BankStore();
    const STEM = '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性';
    s.replaceEntries(
      'aptitude',
      [q('a#0', STEM, 'D'), q('b#0', STEM, 'A', opts(['A', '收入增长'], ['B', '成本下降'], ['C', '人数稳定'], ['D', '利润波动'])), q('c#0', STEM, 'B')],
    );
    const v = s.search('aptitude', STEM);
    // three records, but two of them were the same question with the same
    // options and a different letter — merged into one conflict entry
    expect(v.stemCopies).toBe(2);
    expect(v.best?.entry.answer).toContain('不一致');
    expect(decideBankAnswer(v, []).direct).toBe(false);
  });

  it('explains itself instead of answering short once the user asks why', () => {
    const e = q('a#0', STEM, 'D');
    expect(decideBankAnswer(verdict(e), screen(e), { wantsExplanation: true }).direct).toBe(false);
  });
});

describe('BankStore.search — a query too short to identify anything', () => {
  it('returns none for a fragment instead of a coincidental letter', () => {
    const s = store();
    expect(s.search('aptitude', '认知').mode).toBe('none');
    expect(s.search('aptitude', '选 D').mode).toBe('none');
    expect(s.search('aptitude', '下列哪一项不属于认知风格的特点').mode).toBe('bank');
  });
});

let cached: BankStore | null = null;
function s0(): BankStore {
  if (!cached) cached = store();
  return cached;
}
