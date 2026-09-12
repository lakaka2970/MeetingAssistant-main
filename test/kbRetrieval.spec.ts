/**
 * Tests for the pre-chunked knowledge-base retrieval channel.
 *
 * These lock the decisions that MEASUREMENT produced, not ones that looked
 * reasonable: the field mapping that beat title-in-stem, the conflict marker
 * that must survive to the prompt, and the two Python behaviours deliberately
 * NOT ported because they scored worse here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { metaFieldOf, parseKbChunkLine, parseKbIndex } from '../electron/rag/kbIndex';
import { KbRetrieval } from '../electron/rag/kbRetrieval';
import { RagService, rrfMerge } from '../electron/rag/service';
import { formatRagContext } from '../electron/llm/prompts';

const chunk = (over: Record<string, unknown>): string =>
  JSON.stringify({
    chunk_id: 'C1',
    doc_id: 'P17-04',
    title: '毫米波雷达高频面试问答',
    path: '17_毫米波雷达/04_高频面试问答.md',
    section: '4. 高频面试问答',
    doc_type: '问答',
    job_primary: '17_毫米波雷达',
    job_secondary: ['16_感知算法'],
    layer: '岗位包',
    domain: '雷达岗面试问答',
    scenarios: ['检测杂波追问'],
    evidence: ['PRISM-Pillars-RF'],
    priority: 'P0',
    status: '已校验',
    breadcrumb: ['岗位:17_毫米波雷达', '文件:04_高频面试问答'],
    text: '正文内容',
    n_chars: 4,
    hash: 'h1',
    updated: '2026-09-12',
    sources: [],
    ...over,
  });

describe('kbIndex parsing', () => {
  it('parses a good line and maps the metadata arrays', () => {
    const c = parseKbChunkLine(chunk({}));
    expect(c).not.toBeNull();
    expect(c!.docId).toBe('P17-04');
    expect(c!.jobSecondary).toEqual(['16_感知算法']);
    expect(c!.evidence).toEqual(['PRISM-Pillars-RF']);
    // a scalar where a list is expected degrades to one item, not a crash
    expect(parseKbChunkLine(chunk({ scenarios: '单值场景' }))!.scenarios).toEqual(['单值场景']);
  });

  it('skips blank, malformed and contentless lines instead of throwing', () => {
    const report = parseKbIndex(
      [
        '',
        '   ',
        '{not json',
        '[]',
        chunk({ chunk_id: '' }), // no id → useless
        chunk({ text: '   ' }), // no content → useless
        chunk({ chunk_id: 'ok' }),
      ].join('\n'),
    );
    expect(report.chunks).toHaveLength(1);
    expect(report.chunks[0].chunkId).toBe('ok');
    expect(report.skipped).toBe(4);
    expect(report.docs).toBe(1);
  });

  it('metaField carries the routing metadata the lexical index scores separately', () => {
    const m = metaFieldOf(parseKbChunkLine(chunk({}))!);
    for (const needle of ['17_毫米波雷达', '岗位包', '雷达岗面试问答', 'PRISM-Pillars-RF']) {
      expect(m).toContain(needle);
    }
  });
});

describe('KbRetrieval', () => {
  let dir: string;
  let metaDir: string;

  const writeIndex = (rows: string[]) => {
    writeFileSync(join(metaDir, '991_index.jsonl'), rows.join('\n'), 'utf8');
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-kb-'));
    metaDir = join(dir, '99_元数据与检索');
    mkdirSync(metaDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the index from the KB root, the metadata folder, or the file itself', () => {
    writeIndex([chunk({})]);
    const kb = new KbRetrieval();
    expect(kb.load(dir)).toBe(true);
    expect(kb.state.chunks).toBe(1);

    const byFile = new KbRetrieval();
    expect(byFile.load(join(metaDir, '991_index.jsonl'))).toBe(true);

    const byMetaDir = new KbRetrieval();
    expect(byMetaDir.load(metaDir)).toBe(true);
  });

  it('reports a clear error and loads nothing when the path has no index', () => {
    const kb = new KbRetrieval();
    expect(kb.load(join(dir, 'nowhere'))).toBe(false);
    expect(kb.state.error).toContain('未找到 991_index.jsonl');
    expect(kb.search('任意问题', 5)).toEqual([]);
  });

  it('returns the structural chunk with a citable ref, not a re-chunked fragment', () => {
    writeIndex([
      chunk({
        chunk_id: 'A',
        doc_id: 'P17-01',
        section: '2. 原理与推导',
        text: 'CFAR 的门限因子由虚警概率推出：Pfa = (1+α)^(-Nr) - 1，因此 α = Pfa^(-1/Nr) - 1。',
      }),
      chunk({
        chunk_id: 'B',
        doc_id: 'P16-01',
        section: '3. 工程实践',
        text: '点云稀疏时用体素化与稀疏卷积降低计算量。',
      }),
    ]);
    const kb = new KbRetrieval();
    expect(kb.load(dir)).toBe(true);
    const hits = kb.search('CFAR 的门限因子是怎么推出来的？', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].docId).toBe('P17-01');
    // the ref is what makes an answer checkable: file id + section, both present
    expect(hits[0].ref).toBe('P17-01 §2. 原理与推导');
    expect(hits[0].text).toContain('Pfa');
  });

  /**
   * LexicalIndex prunes any term occurring in over 60% of documents as a
   * stopword. In a two-document fixture every term is universal, so nothing is
   * informative and the query returns empty — unrelated filler is required for
   * a corpus this small. (The real index has 569 blocks and never hits this.)
   */
  const filler = (n: number): string[] =>
    Array.from({ length: n }, (_, i) =>
      chunk({
        chunk_id: `F${i}`,
        doc_id: `FILL-${i}`,
        section: ` filler ${i}`,
        text: `无关内容${i} 主题${String.fromCharCode(65 + (i % 26))}${i}`,
      }),
    );

  it('collapses several blocks of one section to its best scorer', () => {
    writeIndex([
      chunk({ chunk_id: 'X1', section: '4. 高频面试问答', text: '非极大值抑制用于去掉重复框。' }),
      chunk({ chunk_id: 'X2', section: '4. 高频面试问答', text: '非极大值抑制的另一种写法说明。' }),
      ...filler(8),
    ]);
    const kb = new KbRetrieval();
    expect(kb.load(dir)).toBe(true);
    const hits = kb.search('非极大值抑制用于去掉重复框', 5);
    expect(hits.length).toBeGreaterThan(0);
    // both blocks share doc_id + section, so only the better one may survive
    expect(new Set(hits.map((h) => h.ref)).size).toBe(hits.length);
  });

  it('flags a chunk whose figures are not settled', () => {
    writeIndex([
      chunk({
        chunk_id: 'K',
        doc_id: 'ASSET-91',
        section: '5. 数字口径',
        text: '⚠ 40.5 FPS 为早期口径，仓库实测为 29.03 FPS，冲突未消解。',
      }),
      chunk({
        chunk_id: 'S',
        doc_id: 'ASSET-92',
        section: '6. 实验方法',
        text: '训练损失按设定策略收敛正常。',
      }),
      ...filler(8),
    ]);
    const kb = new KbRetrieval();
    expect(kb.load(dir)).toBe(true);
    const hits = kb.search('40.5 FPS 29.03 口径', 5);
    expect(hits.find((h) => h.docId === 'ASSET-91')?.conflicting).toBe(true);
    // the invariant is "only flagged blocks are flagged", not "every block is
    // retrieved" — an unrelated section legitimately stays out of the top hits
    expect(hits.filter((h) => h.conflicting).map((h) => h.docId)).toEqual(['ASSET-91']);
  });

  it('detects a rebuilt index by mtime', () => {
    writeIndex([chunk({ chunk_id: 'old' })]);
    const kb = new KbRetrieval();
    kb.load(dir);
    expect(kb.needsReload(dir)).toBe(false);
    writeIndex([chunk({ chunk_id: 'new' }), chunk({ chunk_id: 'new2', doc_id: 'P16-09' })]);
    // rewrite can land in the same clock tick, so force a later mtime
    const t = new Date(Date.now() + 5000);
    utimesSync(join(metaDir, '991_index.jsonl'), t, t);
    expect(kb.needsReload(dir)).toBe(true);
    expect(kb.load(dir)).toBe(true);
    expect(kb.state.chunks).toBe(2);
  });

  it('clear() drops everything', () => {
    writeIndex([chunk({})]);
    const kb = new KbRetrieval();
    kb.load(dir);
    kb.clear();
    expect(kb.state.loaded).toBe(false);
    expect(kb.search('任意问题', 5)).toEqual([]);
  });
});

describe('RagService wiring (settings.kbIndex → retrieve)', () => {
  let dir: string;
  let kbDir: string;

  const seed = (): void => {
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(
      join(kbDir, '991_index.jsonl'),
      [
        chunk({
          chunk_id: 'K1',
          doc_id: 'P17-01',
          section: '2. 原理与推导',
          text: 'CFAR 门限因子由虚警概率推出：Pfa = (1+α)^(-Nr)，故 α = Pfa^(-1/Nr) - 1。',
        }),
        chunk({
          chunk_id: 'K2',
          doc_id: 'P16-01',
          section: '3. 工程实践',
          text: '点云稀疏时采用体素化与稀疏卷积，显著降低计算量。',
        }),
        ...Array.from({ length: 8 }, (_, i) =>
          chunk({
            chunk_id: `F${i}`,
            doc_id: `FILL-${i}`,
            section: ` filler ${i}`,
            text: `无关内容${i} 主题${String.fromCharCode(65 + i)}${i}`,
          }),
        ),
      ].join('\n'),
      'utf8',
    );
  };

  /** RagService plus the test-only stand-in for the settings patch */
  type TestService = RagService & { setKbPath: (p: string) => void };

  const makeService = (kbIndex: string): TestService => {
    let kbPath = kbIndex;
    const svc = new RagService({
      userDataDir: dir,
      modelsDir: join(dir, 'models'),
      getSettings: () => ({
        enabled: true,
        model: 'bge-m3',
        topK: 5,
        minScore: 0.2,
        remoteHost: '',
        kbIndex: kbPath,
      }),
    });
    // bindKb is what the settings row calls; keep the two in step like main does
    const orig = svc.bindKb.bind(svc);
    svc.bindKb = (p: string) => {
      kbPath = p;
      return orig(p);
    };
    // stands in for `settings.applyPatch({ rag: { kbIndex } })`, which the real
    // handler performs alongside the bind/unbind call
    const testSvc: TestService = Object.assign(svc, {
      setKbPath: (p: string): void => {
        kbPath = p;
      },
    });
    return testSvc;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-rag-'));
    kbDir = join(dir, 'kb');
    seed();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns knowledge-base hits with no embedder and no model download', async () => {
    // This is the whole reason the channel exists: a machine that never fetched
    // bge-m3 still answers from the knowledge base instead of returning nothing.
    const svc = makeService('');
    expect(svc.bindKb(kbDir).ok).toBe(true);
    const r = await svc.retrieve('CFAR 的门限因子是怎么推出来的？');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].source).toBe('知识库');
    expect(r.hits[0].ref).toContain('P17-01');
    expect(r.conflicts).toEqual([]);
    expect(r.qa).toEqual([]);
  });

  it('reports the bound index through status so the settings row can show it', () => {
    const svc = makeService('');
    expect(svc.status().kb.configured).toBe('');
    expect(svc.status().kb.loaded).toBe(false);
    svc.bindKb(kbDir);
    const st = svc.status();
    expect(st.kb.configured).toBe(kbDir);
    expect(st.kb.loaded).toBe(true);
    expect(st.kb.chunks).toBe(10);
    expect(st.kb.docs).toBe(10);
    expect(st.kb.error).toBe('');
  });

  it('surfaces a bad path instead of failing silently', () => {
    const svc = makeService('');
    const res = svc.bindKb(join(dir, 'nowhere'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未找到 991_index.jsonl');
    // and the status keeps showing what was attempted, so the UI is not blank
    expect(svc.status().kb.loaded).toBe(false);
  });

  it('unbind clears the retrieval, and the setting must go too', () => {
    // Documents the real contract: unbindKb() drops the loaded index, but the
    // path lives in settings, and ensureKb() would silently re-load it on the
    // next question if the caller forgot to clear rag.kbIndex. The main-process
    // handler does both; this asserts both are needed.
    const svc = makeService('');
    svc.bindKb(kbDir);
    expect(svc.status().kb.loaded).toBe(true);

    svc.unbindKb();
    expect(svc.status().kb.loaded).toBe(false);
    // still configured, so a question would re-bind it — this is the trap
    expect(svc.status().kb.configured).toBe(kbDir);

    // what the handler actually does: clear the setting as well
    svc.setKbPath('');
    svc.unbindKb();
    expect(svc.status().kb.configured).toBe('');
  });
});

describe('rrfMerge', () => {
  it('fuses by rank so incomparable score scales cannot distort the order', () => {
    // lexical scores are coverage in 0..1, cosine is similarity in ~0.2..0.9:
    // a single 0.6 must not automatically outrank a first-place lexical hit
    const lexical = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    const dense = [{ id: 'C' }, { id: 'D' }];
    const out = rrfMerge(
      [
        { items: lexical, key: (x) => x.id },
        { items: dense, key: (x) => x.id },
      ],
      3,
    ).map((x) => x.id);
    // C is 3rd in lexical and 1st in dense: 1/63 + 1/61 outranks A's lone 1/61.
    // Appearing in both retrievers is the evidence that should win.
    expect(out).toEqual(['C', 'A', 'B']);
  });

  it('a document strong in both lists beats one strong in only one', () => {
    const out = rrfMerge(
      [
        { items: [{ id: 'solo' }, { id: 'both' }], key: (x) => x.id },
        { items: [{ id: 'both' }], key: (x) => x.id },
      ],
      2,
    ).map((x) => x.id);
    expect(out[0]).toBe('both');
  });

  it('honours the limit', () => {
    expect(
      rrfMerge([{ items: [1, 2, 3, 4], key: String }], 2),
    ).toEqual([1, 2]);
  });
});

describe('conflict guardrail in the prompt', () => {
  it('says nothing about口径 when nothing is flagged', () => {
    const block = formatRagContext(['[知识库|P16-01 §2] 正文']);
    expect(block).toContain('知识库召回');
    expect(block).not.toContain('口径未定');
  });

  it('names the conflicting sources and forbids picking one silently', () => {
    const block = formatRagContext(['[知识库|ASSET-91 §5] 正文'], ['ASSET-91 §5. 数字口径']);
    expect(block).toContain('口径未定');
    expect(block).toContain('ASSET-91 §5. 数字口径');
    // the whole point: enumerate, do not choose, do not invent
    expect(block).toContain('不得只挑一个念');
    expect(block).toContain('编造第三个数字');
  });

  it('returns nothing when there is no material, conflict or not', () => {
    expect(formatRagContext([], ['X §1'])).toBe('');
  });
});
