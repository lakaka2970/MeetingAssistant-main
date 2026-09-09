import { describe, it, expect } from 'vitest';
import {
  LexicalIndex,
  judgeMatch,
  normalizeQuestion,
  tokenize,
  type LexicalDoc,
} from '../shared/lexicalIndex';

const doc = (id: string, stem: string, extra = ''): LexicalDoc & { id: string } => ({ id, stem, extra });

describe('normalizeQuestion / tokenize', () => {
  it('folds layout, width and markdown noise into one key', () => {
    const a = normalizeQuestion('**下列哪一项**不属于认知风格的特点？');
    const b = normalizeQuestion('下列哪一项不属于认知风格的特点?');
    expect(a).toBe(b);
    // full-width operators are noise: what matters is that both writings agree
    expect(normalizeQuestion('２＋２')).toBe(normalizeQuestion('2+2'));
    expect(normalizeQuestion('说说 [[CAP 定理]] 的关系')).toBe('说说 cap 定理 的关系');
  });

  it('indexes CJK on bigrams and latin/numbers as words', () => {
    const t = tokenize(normalizeQuestion('Kafka 幂等性 12'));
    expect(t).toContain('kafka');
    expect(t).toContain('12');
    expect(t).toContain('幂等');
    expect(t).toContain('等性');
  });
});

describe('LexicalIndex.search — an OA screen copied the stem', () => {
  const index = new LexicalIndex();
  index.addAll([
    doc('b1', '下列哪一项不属于认知风格的特点？', '独立性 稳定性 强制性 一致性'),
    doc('b2', '认知风格是否具有跨情境的一致性？', '稳定性'),
    doc('b3', '2 的 10 次方等于多少？', '1024'),
    doc('b4', '某项目预算 120 万元，实际支出 150 万元，超支百分比是多少？', '25%'),
    doc('b5', '某项目工期 30 天，实际用时 45 天，超期百分比是多少？', '50%'),
  ]);

  it('returns the exact stem first, with containment confidence', () => {
    const hits = index.search('下列哪一项不属于认知风格的特点');
    expect(hits[0].doc.id).toBe('b1');
    expect(hits[0].confidence).toBe('exact');
    expect(hits[0].score).toBeGreaterThanOrEqual(0.97);
  });

  it('survives the option line noise an OCR capture brings along', () => {
    const hits = index.search('下列哪一项不属于认知风格的特点？ A. 独立性 B. 稳定性 C. 强制性 D. 一致性');
    expect(hits[0].doc.id).toBe('b1');
  });

  it('separates questions that differ only in their numbers', () => {
    const hits = index.search('某项目预算 120 万元，实际支出 150 万元，超支百分比是多少');
    expect(hits.map((h) => h.doc.id)).not.toContain('b5');
    expect(hits[0].doc.id).toBe('b4');
  });

  it('ranks a paraphrase below an exact stem', () => {
    const exact = index.search('下列哪一项不属于认知风格的特点')[0];
    const para = index.search('认知风格 一致性 属于哪一项')[0];
    expect(exact.score).toBeGreaterThan(para.score);
  });

  it('answers "none" for an unrelated question instead of a bad guess', () => {
    const hits = index.search('如何用 git rebase 改写提交历史');
    expect(judgeMatch(hits).confidence).toBe('none');
  });

  it('reports weak (hint-only) for partial overlap', () => {
    const hits = index.search('认知风格的跨情境');
    const judged = judgeMatch(hits);
    expect(judged.best?.doc.id).toBe('b2');
    expect(['weak', 'strong']).toContain(judged.confidence);
  });

  it('is fast enough to never be the latency problem', () => {
    const big = new LexicalIndex();
    const docs: LexicalDoc[] = [];
    for (let i = 0; i < 20_000; i++) {
      docs.push({ id: `x${i}`, stem: `第 ${i} 题 关于 数据结构 与 算法 的 判断 题 选项 分析`, extra: `选项甲 选项乙 ${i}` });
    }
    const t0 = performance.now();
    big.addAll(docs);
    const buildMs = performance.now() - t0;
    const q = '第 12345 题 关于 数据结构 与 算法 的 判断 题';
    const s0 = performance.now();
    let hits = big.search(q, { limit: 5 });
    for (let i = 0; i < 100; i++) hits = big.search(q, { limit: 5 });
    const perQuery = (performance.now() - s0) / 100;
    expect(hits[0].doc.id).toBe('x12345');
    expect(hits[0].confidence).toBe('exact');
    expect(perQuery).toBeLessThan(5);
    expect(buildMs).toBeLessThan(10_000);
  });
});

describe('LexicalIndex maintenance and judgeMatch', () => {
  it('removeWhere forgets the dropped docs', () => {
    const index = new LexicalIndex();
    index.addAll([doc('a', '甲题 内容 与 干挠 词'), doc('b', '乙题 内容')]);
    expect(index.size).toBe(2);
    expect(index.removeWhere((d) => d.id === 'a')).toBe(1);
    expect(index.size).toBe(1);
    // a question from the dropped doc is no longer answered by the bank
    expect(judgeMatch(index.search('甲题 内容 与 干挠 词')).confidence).toBe('none');
    expect(judgeMatch(index.search('乙题 内容')).confidence).not.toBe('none');
  });

  it('handles an empty index and an empty query without throwing', () => {
    const index = new LexicalIndex();
    expect(index.search('随便什么')).toEqual([]);
    expect(index.search('')).toEqual([]);
    expect(judgeMatch([]).confidence).toBe('none');
  });

  it('keeps exact containment even for a very short stem', () => {
    const index = new LexicalIndex();
    index.add(doc('s', '幂等性'));
    const hits = index.search('幂等性');
    expect(hits[0].doc.id).toBe('s');
    expect(hits[0].cover).toBeGreaterThan(0.9);
  });
});
