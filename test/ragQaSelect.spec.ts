import { describe, it, expect } from 'vitest';
import {
  QA_DIRECT_MIN_COSINE,
  QA_DIRECT_MIN_LEXICAL,
  qaViewOf,
  selectQaHits,
  type QaSearchHit,
} from '../electron/rag/qaSelect';
import { formatQaRecord } from '../shared/qaPairs';

const hit = (
  question: string,
  answer: string,
  score: number,
  extra: { ref?: string; withMeta?: boolean } = {},
): QaSearchHit => ({
  score,
  record: {
    source: 'qa',
    ref: extra.ref ?? '面试准备.md',
    text: formatQaRecord(question, answer),
    metadata:
      extra.withMeta === false
        ? undefined
        : { qa: true, question, answer, qa_from: 'doc' },
  },
});

describe('selectQaHits — the gate before a prepared answer reaches the user', () => {
  it('accepts a confident embedding hit', () => {
    const out = selectQaHits('你的缺点是什么', [hit('说说你的缺点', '我有时过于追求细节', 0.72)]);
    expect(out).toHaveLength(1);
    expect(out[0].answer).toBe('我有时过于追求细节');
    expect(out[0].exact).toBe(false);
  });

  it('rejects a weak embedding hit with no lexical support', () => {
    expect(selectQaHits('今晚吃什么', [hit('你的缺点是什么', '过于追求细节', 0.4)])).toEqual([]);
  });

  it('accepts a literally repeated question even when the embedding drifts', () => {
    const out = selectQaHits('你的缺点是什么？', [hit('你的缺点是什么', '过于追求细节', 0.31)]);
    expect(out).toHaveLength(1);
    expect(out[0].exact).toBe(true);
  });

  it('is stricter than the doc-recall floor', () => {
    expect(QA_DIRECT_MIN_COSINE).toBeGreaterThan(0.4);
    expect(QA_DIRECT_MIN_LEXICAL).toBeGreaterThan(0.5);
  });

  it('caps at two hits and ranks by the STRONGER of the two signals', () => {
    const out = selectQaHits(
      '介绍下你的项目',
      [
        // 0.75 lexical (a near-identical question) beats a 0.66 cosine
        hit('介绍下你的项目经历', '近义问法', 0.58),
        hit('介绍下你的项目', '字面命中', 0.9),
        hit('你的项目难点是什么', '弱关联', 0.66),
      ],
      2,
    );
    expect(out.map((h) => h.answer)).toEqual(['字面命中', '近义问法']);
  });

  it('drops records whose stored pair is unusable', () => {
    const noMeta = hit('什么是幂等', '重复执行结果一致', 0.8, { withMeta: false });
    const empty = { score: 0.9, record: { source: 'qa', text: '没有配对的记录' } };
    const same = {
      score: 0.9,
      record: { source: 'qa', text: 'x', metadata: { question: 'x', answer: 'x' } },
    };
    expect(selectQaHits('什么是幂等', [noMeta, empty, same]).map((h) => h.answer)).toEqual([
      '重复执行结果一致',
    ]);
  });

  it('falls back to parsing the record text when metadata is missing', () => {
    const v = qaViewOf(hit('什么是 CAP', '一致可用分区三选二', 0.8, { withMeta: false }), '什么是 CAP');
    expect(v?.question).toBe('什么是 CAP');
    expect(v?.answer).toBe('一致可用分区三选二');
  });

  it('keeps the source ref so the UI can label where the answer came from', () => {
    const out = selectQaHits('q', [hit('q', 'a', 0.9, { ref: '简历.md' })]);
    expect(out[0].ref).toBe('简历.md');
    expect(out[0].source).toBe('qa');
  });

  it('is stable and bounded in what it reports', () => {
    const out = selectQaHits('q', [hit('q', 'a', 0.91234567)]);
    expect(out[0].score).toBe(0.9123);
    expect(Object.keys(out[0]).sort()).toEqual(['answer', 'exact', 'question', 'ref', 'score', 'source']);
  });
});
