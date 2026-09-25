import { describe, it, expect } from 'vitest';
import { RagIngestor } from '../electron/rag/ingest';
import { VectorStore, type RagRecord } from '../electron/rag/vector-store';
import { questionSimilarity } from '../shared/qaPairs';

/**
 * A deterministic stand-in for the embed worker: a bag-of-characters vector, so
 * a text is always closest to itself and to text sharing its characters. The
 * tests below assert WHICH text was embedded (that is the whole point of the
 * prepared-answer design), not the geometry.
 */
function fakeEmbedder() {
  const embedded: string[][] = [];
  const vec = (s: string): Float32Array => {
    const v = new Float32Array(64);
    for (const ch of s) v[ch.charCodeAt(0) % 64] += 1;
    return v;
  };
  return {
    embedded,
    embed: async (texts: string[]) => {
      embedded.push(texts);
      return texts.map(vec);
    },
    embedOne: async (text: string) => vec(text),
  };
}

type FakeEmbedder = ReturnType<typeof fakeEmbedder>;

const asClient = (e: FakeEmbedder) => e as unknown as ConstructorParameters<typeof RagIngestor>[1];

const qaRecords = (store: VectorStore): RagRecord[] =>
  store.allRecords().filter((r) => r.source === 'qa');

describe('RagIngestor — prepared Q&A become dedicated records', () => {
  it('parses pairs out of an ingested document and stores them whole', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    const res = await ing.ingest({
      source: 'doc',
      ref: '面试准备.md',
      text: `问：你为什么离开上一家公司？
答：团队解散，我想找更稳定的技术团队。

---

一些普通的项目描述文字，不是问答对，应该只进普通分块。`,
    });
    const qa = qaRecords(store);
    expect(res.qa).toBe(1);
    expect(qa).toHaveLength(1);
    expect(qa[0].ref).toBe('面试准备.md');
    expect(qa[0].metadata).toMatchObject({
      qa: true,
      question: '你为什么离开上一家公司',
      answer: '团队解散，我想找更稳定的技术团队。',
      qa_from: 'doc',
    });
    // the stored text carries BOTH sides so a re-index / the search playground
    // can show the pair without needing metadata
    expect(qa[0].text).toContain('问：你为什么离开上一家公司');
    expect(qa[0].text).toContain('答：团队解散');
    // and the ordinary prose still got its regular chunks
    expect(store.allRecords().some((r) => r.source === 'doc')).toBe(true);
  });

  it('embeds the QUESTION only — a spoken question must match the question', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    await ing.ingest({
      source: 'knowledge',
      text: '问：介绍一下你的项目\n答：' + '很长的一段项目描述。'.repeat(20),
    });
    const qaEmbeds = emb.embedded.flat().filter((t) => t.startsWith('介绍一下你的项目'));
    expect(qaEmbeds.length).toBe(1);
    expect(qaEmbeds[0]).not.toContain('很长的一段项目描述');
  });

  it('scopes pairs to the session and replaces them on re-import', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    const doc = (t: string) => ing.ingest({ source: 'doc', ref: 'a.md', text: t, replace: true });

    await doc('问：老问题\n答：老答案。这是一段足够长的回答内容，用于通过长度门槛检查。');
    expect(qaRecords(store)[0].metadata).toMatchObject({ question: '老问题' });

    await doc('问：新问题\n答：新答案。');
    const qa = qaRecords(store);
    expect(qa).toHaveLength(1);
    expect(qa[0].metadata).toMatchObject({ question: '新问题' });
  });

  it('keeps per-session pairs out of another interview (and global ones in)', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    await ing.ingest({ source: 'resume', sessionId: 'A', ref: 'r.md', text: '问：A场问题\n答：A场答案。' });
    await ing.ingest({ source: 'knowledge', ref: 'g.md', text: '问：公共问题\n答：公共答案。' });

    const qvec = new Float32Array(64);
    for (const ch of 'A场问题') qvec[ch.charCodeAt(0) % 64] += 1;
    const hits = store.search(qvec, { sources: ['qa'], sessionId: 'A', minScore: 0.1, topK: 5 });
    const questions = hits.map((h) => (h.record.metadata as { question?: string }).question);
    expect(questions).toContain('A场问题');
    expect(questions).toContain('公共问题'); // global material is always in scope

    const other = store.search(qvec, { sources: ['qa'], sessionId: 'B', minScore: 0.1, topK: 5 });
    const otherQ = other.map((h) => (h.record.metadata as { question?: string }).question);
    expect(otherQ).not.toContain('A场问题');
    expect(otherQ).toContain('公共问题');
  });

  it('dropSession removes the pairs too (deleted interview stops answering)', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    await ing.ingest({ source: 'resume', sessionId: 'A', ref: 'r.md', text: '问：A场问题\n答：A答案。' });
    expect(qaRecords(store)).toHaveLength(1);
    expect(ing.dropSession('A')).toBeGreaterThan(0);
    expect(qaRecords(store)).toHaveLength(0);
  });

  it('qa: false skips the scan (transcript-style ingest)', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    const res = await ing.ingest({
      source: 'transcript',
      text: '问：现在几点了？\n答：三点整，这是一段足够长的转录内容用来通过门槛检查。',
      qa: false,
    });
    expect(res.qa).toBe(0);
    expect(qaRecords(store)).toHaveLength(0);
  });

  it('a question is retrievable by how it is actually asked', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    await ing.ingest({ source: 'knowledge', text: '问：你的缺点是什么\n答：我有时过于追求细节。' });
    const q = '说说你的缺点？';
    const hits = store.search(await emb.embedOne(q), { sources: ['qa'], minScore: 0, topK: 1 });
    expect(hits).toHaveLength(1);
    const md = hits[0].record.metadata as { question: string };
    expect(questionSimilarity(q, md.question)).toBeGreaterThan(0.3);
  });

  it('qa_from lets a removed resume/JD drop exactly its own pairs', async () => {
    const store = new VectorStore('test');
    const emb = fakeEmbedder();
    const ing = new RagIngestor(store, asClient(emb));
    await ing.ingest({ source: 'resume', sessionId: 'A', ref: 'r.md', text: '问：简历里的项目\n答：简历答案内容。' });
    await ing.ingest({ source: 'jd', sessionId: 'A', ref: 'j.md', text: '问：JD里的问题\n答：JD答案内容。' });
    await ing.ingest({ source: 'knowledge', ref: 'g.md', text: '问：全局问题\n答：全局答案内容。' });
    expect(qaRecords(store)).toHaveLength(3);

    // the exact predicate RagService.dropSessionSlot runs against the store
    const sameSession = (sessionId?: string) => (r: RagRecord): boolean =>
      (r.sessionId ?? undefined) === (sessionId ?? undefined);
    const dropped = store.removeWhere(
      (r) =>
        r.source === 'qa' &&
        sameSession('A')(r) &&
        (r.metadata as { qa_from?: unknown } | undefined)?.qa_from === 'resume',
    );
    store.removeWhere((r) => r.source === 'resume' && sameSession('A')(r));
    expect(dropped).toBe(1);
    const left = qaRecords(store).map((r) => (r.metadata as { question: string }).question);
    expect(left).toEqual(expect.arrayContaining(['JD里的问题', '全局问题']));
    expect(left).not.toContain('简历里的项目');
  });
});

describe('RagIngestor — a failed replace keeps the previous index', () => {
  it('leaves the old chunks in place when the embed worker dies mid-import', async () => {
    const store = new VectorStore('test');
    store.add({ source: 'doc', ref: 'a.md', text: '旧内容第一段', embedding: new Float32Array(64) });
    store.add({ source: 'doc', ref: 'a.md', text: '旧内容第二段', embedding: new Float32Array(64) });
    const ing = new RagIngestor(store, {
      embed: async () => {
        throw new Error('embed worker gone');
      },
      embedOne: async () => new Float32Array(64),
    } as unknown as ConstructorParameters<typeof RagIngestor>[1]);

    await expect(
      ing.ingest({ source: 'doc', ref: 'a.md', text: '新内容完全不同的一段文字', replace: true }),
    ).rejects.toThrow('embed worker gone');
    expect(store.allRecords().map((r) => r.text)).toEqual(['旧内容第一段', '旧内容第二段']);
  });
});
