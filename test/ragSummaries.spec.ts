/**
 * Local section summaries for imported documents (v1.0.1 ③ "导入后自动分析").
 *
 * The analysis is extractive on purpose: a heading path plus the section's
 * first sentence, embedded with the already-selected local model. That keeps
 * import free of API cost and of any network round-trip, and it keeps the
 * records honest — a summary can never invent a figure the document lacks.
 */
import { describe, expect, it } from 'vitest';
import { RagIngestor } from '../electron/rag/ingest';
import { VectorStore, type RagRecord } from '../electron/rag/vector-store';
import {
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_SECTIONS,
  SECTION_GROUP_CHARS,
  buildDocSummaries,
  isSectionRefOf,
  sectionRefOf,
  splitSections,
} from '../electron/rag/summaries';
import { applySummaryQuota } from '../electron/rag/service';

const deck = [
  '## 第1页',
  '项目背景',
  '离线转录，无需联网',
  '备注：这里要强调离线运行',
  '## 第2页',
  '评测方法',
  'Hit@5 与 MRR 各测三轮。补充说明。',
].join('\n');

describe('splitSections', () => {
  it('cuts a pptx extraction at its slide markers', () => {
    expect(splitSections(deck)).toEqual([
      { title: '第1页', body: '项目背景\n离线转录，无需联网\n备注：这里要强调离线运行' },
      { title: '第2页', body: '评测方法\nHit@5 与 MRR 各测三轮。补充说明。' },
    ]);
  });

  it('carries the heading path so a section title is unambiguous', () => {
    const doc = ['# 产品', '定位说明', '## 架构', '分层设计', '### 检索', '混合召回', '## 路线图', '下一步'].join('\n');
    expect(splitSections(doc).map((s) => s.title)).toEqual([
      '产品',
      '产品 / 架构',
      '产品 / 架构 / 检索',
      '产品 / 路线图',
    ]);
  });

  it('keeps text that appears before the first heading', () => {
    expect(splitSections('前言文字\n# A\n正文')).toEqual([
      { title: '', body: '前言文字' },
      { title: 'A', body: '正文' },
    ]);
  });

  it('groups paragraphs of a heading-free document into bounded sections', () => {
    const para = (i: number) => `第${i}段。` + '内容'.repeat(40); // ~85 chars
    const flat = Array.from({ length: 20 }, (_, i) => para(i + 1)).join('\n\n');
    const sections = splitSections(flat);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expect(s.title).toBe('');
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.body.length).toBeLessThanOrEqual(SECTION_GROUP_CHARS);
    }
    // nothing lost, nothing duplicated
    expect(sections.map((s) => s.body).join('\n\n')).toBe(flat);
  });

  it('returns nothing for empty input', () => {
    expect(splitSections('   \n  ')).toEqual([]);
  });
});

describe('buildDocSummaries', () => {
  it('summarises each section as its heading path plus first sentence', () => {
    expect(buildDocSummaries(deck)).toEqual([
      { index: 1, title: '第1页', text: '第1页：项目背景' },
      { index: 2, title: '第2页', text: '第2页：评测方法' },
    ]);
  });

  it('omits the title prefix when the document has no headings', () => {
    const [only] = buildDocSummaries('团队解散后我在做离线转录方向。其余内容略。');
    expect(only.text).toBe('团队解散后我在做离线转录方向。');
  });

  it('skips a section with no body but keeps the document section numbering', () => {
    const summaries = buildDocSummaries('# A\n正文A\n# B\n# C\n正文C');
    expect(summaries.map((s) => s.index)).toEqual([1, 3]);
    expect(summaries[1].text).toBe('C：正文C');
  });

  it('caps one document at 40 sections', () => {
    const many = Array.from({ length: MAX_SUMMARY_SECTIONS + 5 }, (_, i) => `## 第${i + 1}页\n第${i + 1}页要点。`).join('\n');
    const summaries = buildDocSummaries(many);
    expect(summaries).toHaveLength(MAX_SUMMARY_SECTIONS);
    expect(summaries[MAX_SUMMARY_SECTIONS - 1].index).toBe(MAX_SUMMARY_SECTIONS);
  });

  it('truncates a long first sentence instead of reproducing the section', () => {
    const long = `# 标题\n${'很长的一句说明'.repeat(40)}。`;
    const [only] = buildDocSummaries(long);
    expect(only.text.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(only.text.endsWith('…')).toBe(true);
  });
});

describe('section refs', () => {
  it('derives and recognises a section ref from its document ref', () => {
    expect(sectionRefOf('deck.pptx', 3)).toBe('deck.pptx#s3');
    expect(isSectionRefOf('deck.pptx#s3', 'deck.pptx')).toBe(true);
    expect(isSectionRefOf('deck.pptx', 'deck.pptx')).toBe(false);
    expect(isSectionRefOf('other.pptx#s3', 'deck.pptx')).toBe(false);
    expect(isSectionRefOf(undefined, 'deck.pptx')).toBe(false);
  });
});

/** the same bag-of-characters stand-in the Q&A ingest tests use */
function fakeEmbedder() {
  const vec = (s: string): Float32Array => {
    const v = new Float32Array(64);
    for (const ch of s) v[ch.charCodeAt(0) % 64] += 1;
    return v;
  };
  return {
    embed: async (texts: string[]) => texts.map(vec),
    embedOne: async (text: string) => vec(text),
  };
}

const asClient = (e: ReturnType<typeof fakeEmbedder>) =>
  e as unknown as ConstructorParameters<typeof RagIngestor>[1];

const sectionRecords = (store: VectorStore): RagRecord[] =>
  store.allRecords().filter((r) => isSectionRefOf(r.ref, 'deck.pptx'));

describe('RagIngestor.ingestDocSummaries', () => {
  it('stores one doc record per section, tagged as a summary', async () => {
    const store = new VectorStore('test');
    const ing = new RagIngestor(store, asClient(fakeEmbedder()));
    const added = await ing.ingestDocSummaries({
      docRef: 'deck.pptx',
      text: deck,
      metadata: { doc_name: 'deck.pptx' },
    });
    expect(added).toBe(2);
    const records = sectionRecords(store);
    expect(records.map((r) => r.ref)).toEqual(['deck.pptx#s1', 'deck.pptx#s2']);
    for (const r of records) {
      expect(r.source).toBe('doc');
      expect(r.metadata).toMatchObject({ kind: 'summary', doc_ref: 'deck.pptx', doc_name: 'deck.pptx' });
    }
    expect(records[0].text).toBe('第1页：项目背景');
  });

  it('replaces the previous section records of the same document', async () => {
    const store = new VectorStore('test');
    const ing = new RagIngestor(store, asClient(fakeEmbedder()));
    await ing.ingestDocSummaries({ docRef: 'deck.pptx', text: deck });
    const shrunk = splitSections(deck).slice(0, 1).map((s) => s.body).join('\n');
    const added = await ing.ingestDocSummaries({ docRef: 'deck.pptx', text: `## 第1页\n${shrunk}` });
    expect(added).toBe(1);
    expect(sectionRecords(store).map((r) => r.ref)).toEqual(['deck.pptx#s1']);
  });

  it('keeps the old summaries when the re-analysis cannot embed its new ones', async () => {
    // Same rule as the document body: a worker that dies halfway must leave the
    // previous section summaries retrievable, not a document with no coverage.
    const store = new VectorStore('test');
    const ing = new RagIngestor(store, asClient(fakeEmbedder()));
    await ing.ingestDocSummaries({ docRef: 'deck.pptx', text: deck });
    const before = sectionRecords(store).map((r) => r.ref);
    expect(before).toEqual(['deck.pptx#s1', 'deck.pptx#s2']);

    const broken = new RagIngestor(
      store,
      asClient({
        ...fakeEmbedder(),
        embed: async () => {
          throw new Error('embed worker gone');
        },
      }),
    );
    await expect(
      broken.ingestDocSummaries({ docRef: 'deck.pptx', text: `## 第1页\n换了一版正文` }),
    ).rejects.toThrow('embed worker gone');
    expect(sectionRecords(store).map((r) => r.ref)).toEqual(before);
  });

  it('leaves the document body records and other documents alone', async () => {
    const store = new VectorStore('test');
    const ing = new RagIngestor(store, asClient(fakeEmbedder()));
    await ing.ingest({ text: '正文一。正文二。', source: 'doc', ref: 'deck.pptx', replace: true });
    await ing.ingest({ text: '另一个文档的正文。', source: 'doc', ref: 'notes.md', replace: true });
    await ing.ingestDocSummaries({ docRef: 'deck.pptx', text: deck });
    expect(store.allRecords().map((r) => r.ref).sort()).toEqual(
      ['deck.pptx', 'deck.pptx#s1', 'deck.pptx#s2', 'notes.md'].sort(),
    );
  });

  it('never turns a summary line into a prepared answer', async () => {
    const store = new VectorStore('test');
    const ing = new RagIngestor(store, asClient(fakeEmbedder()));
    await ing.ingestDocSummaries({ docRef: 'deck.pptx', text: '# A\n问：为什么选离线方案？\n答：延迟与隐私。' });
    expect(store.allRecords().filter((r) => r.source === 'qa')).toEqual([]);
  });

  it('re-ingesting the document body drops its stale section summaries', async () => {
    const store = new VectorStore('test');
    const ing = new RagIngestor(store, asClient(fakeEmbedder()));
    await ing.ingestDocSummaries({ docRef: 'deck.pptx', text: deck });
    await ing.ingest({ text: '重写后的正文。', source: 'doc', ref: 'deck.pptx', replace: true });
    expect(sectionRecords(store)).toEqual([]);
  });
});

describe('applySummaryQuota (summaries must not crowd out the source text)', () => {
  const hit = (label: string, kind?: string) => ({ text: label, source: 'doc', score: 1, kind });

  it('keeps at most max summary hits, dropping the weakest', () => {
    const hits = [
      hit('s1', 'summary'),
      hit('body'),
      hit('s2', 'summary'),
      hit('s3', 'summary'),
      hit('body2'),
    ];
    expect(applySummaryQuota(hits, 2).map((h) => h.text)).toEqual(['s1', 'body', 's2', 'body2']);
  });

  it('passes a hit list with no summaries through untouched', () => {
    const hits = [hit('a'), hit('b')];
    expect(applySummaryQuota(hits, 2)).toEqual(hits);
  });

  it('is a no-op when the quota is not exceeded', () => {
    const hits = [hit('s1', 'summary'), hit('body')];
    expect(applySummaryQuota(hits, 2).map((h) => h.text)).toEqual(['s1', 'body']);
  });
});
