/**
 * Retrieval evaluation for the interview knowledge base, run against the KB's
 * own question set.
 *
 *   npm run kb:eval
 *
 * The point of this file is that every retrieval change below gets MEASURED
 * rather than asserted. It computes the same three metrics the KB's Python CLI
 * computes, over the same 45 questions, so the numbers are comparable — with
 * two deliberate differences that make the result harder, not easier:
 *
 *  1. the golden rows carry `job` and `intent`, and the Python evaluation feeds
 *     them straight into retrieve(). That is the answer key leaking into the
 *     retrieval. This harness ignores them: production has to guess, so the
 *     measurement guesses too.
 *  2. `recall` in that CLI is really Hit@5 — expect_docs lists 2-3 acceptable
 *     files and hitting any one scores full marks. The definition is kept here
 *     so the comparison holds, and labelled Hit@5 so nobody reads it as recall.
 *
 * Consequence: numbers here will sit BELOW baseline.json and that is not a
 * regression. Compare variants against each other, not against that file.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LexicalIndex } from '../shared/lexicalIndex';
import { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from '../electron/rag/chunker';
import { metaFieldOf, parseKbIndex, type KbChunk } from '../electron/rag/kbIndex';
import { KbRetrieval } from '../electron/rag/kbRetrieval';

/**
 * The KB root is a required argument. Under cmd.exe a bare CJK path arrives
 * with stray spaces inserted, which reads as "the index is empty" and looks
 * like a parser bug rather than a broken argument — quote it.
 */
const KB_ROOT = process.argv[2];
if (!KB_ROOT) {
  console.error('usage: npx vite-node tools/kb-eval.ts -- "<kbRootDir>"');
  process.exit(1);
}
const INDEX_FILE = join(KB_ROOT, '99_元数据与检索', '991_index.jsonl');
const GOLDEN_FILE = join(KB_ROOT, '99_元数据与检索', '_rag', 'golden.jsonl');
/** skip the tooling/model trees: they are not knowledge content */
const SKIP_DIRS = new Set(['_rag', '_tools', 'models', 'index', 'node_modules']);

interface Gold {
  q: string;
  expectDocs: string[];
  expectKeywords: string[];
}

interface Doc {
  id: string;
  /** doc_id for scoring; the KB's own identifier (P17-01, ASSET-92, …) */
  docId: string;
  stem: string;
  extra: string;
}

function readJsonl<T>(file: string, map: (r: Record<string, unknown>) => T | null): T[] {
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = map(JSON.parse(t) as Record<string, unknown>);
      if (m) out.push(m);
    } catch {
      /* truncated or hand-edited line: skip, do not abort the run */
    }
  }
  return out;
}

/** the `id:` in a file's YAML frontmatter, which is the doc_id the gold set uses */
function frontmatterId(md: string): string {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const f = m[1].match(/^id:\s*(\S+)\s*$/m);
  return f ? f[1].trim() : '';
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), acc);
    } else if (e.name.endsWith('.md')) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

/**
 * The KB's hand-tuned term-alias table (中文术语 → 英文缩写, e.g. 非极大值抑制
 * → nms, 交并比 → iou). This is the single most portable thing in the Python
 * side: it encodes how the author's documents are actually written versus how a
 * person asks. LexicalIndex is extended by appending the expansions to the
 * query rather than by changing its scoring, which keeps the index reusable.
 */
function loadAliases(): Map<string, string[]> {
  const file = join(KB_ROOT, '99_元数据与检索', '_rag', 'index', 'bm25_meta.json');
  const out = new Map<string, string[]>();
  if (!existsSync(file)) return out;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { aliases?: Record<string, unknown> };
    for (const [k, v] of Object.entries(j.aliases ?? {})) {
      if (typeof k !== 'string' || !Array.isArray(v)) continue;
      const targets = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (targets.length) out.set(k.toLowerCase(), targets);
    }
  } catch {
    /* a missing or half-written index costs aliases, nothing more */
  }
  return out;
}

/**
 * Hit@k / MRR / keyword coverage, computed exactly as cli.py::_eval_metrics does
 */
function evaluate(
  idx: LexicalIndex<Doc>,
  gold: Gold[],
  topK: number,
  maxPerFile: number,
  aliases?: Map<string, string[]>,
): { hit: number; mrr: number; kw: number; ms: number; n: number } {
  let hit = 0;
  let mrr = 0;
  let kw = 0;
  let ms = 0;
  for (const g of gold) {
    const t0 = Date.now();
    let query = g.q;
    if (aliases?.size) {
      const low = g.q.toLowerCase();
      const add: string[] = [];
      for (const [term, targets] of aliases) if (low.includes(term)) add.push(...targets);
      if (add.length) query = `${g.q} ${[...new Set(add)].join(' ')}`;
    }
    let found = idx.search(query, { limit: Math.max(topK * 6, 40) });
    if (maxPerFile > 0) {
      const seen = new Map<string, number>();
      const kept: typeof found = [];
      for (const h of found) {
        const key = h.doc.docId || h.doc.id;
        const n = seen.get(key) ?? 0;
        if (n >= maxPerFile) continue;
        seen.set(key, n + 1);
        kept.push(h);
        if (kept.length >= topK) break;
      }
      found = kept;
    } else {
      found = found.slice(0, topK);
    }
    ms += Date.now() - t0;
    const docs = found.map((h) => h.doc.docId);
    const exp = new Set(g.expectDocs);
    const rank = docs.findIndex((d) => exp.has(d));
    if (rank >= 0) {
      hit += 1;
      mrr += 1 / (rank + 1);
    }
    if (g.expectKeywords.length) {
      const ok = g.expectKeywords.every((k) =>
        found.some((h) => h.doc.extra.toLowerCase().includes(k.toLowerCase()) || h.doc.stem.toLowerCase().includes(k.toLowerCase())),
      );
      if (ok) kw += 1;
    } else {
      kw += 1;
    }
  }
  const lat = gold.length || 1;
  return { hit: hit / lat, mrr: mrr / lat, kw: kw / lat, ms: ms / lat, n: gold.length };
}

function pct(x: number): string {
  return x.toFixed(3);
}

function main(): void {
  if (!existsSync(INDEX_FILE) || !existsSync(GOLDEN_FILE)) {
    console.error(`missing input:\n  ${INDEX_FILE}\n  ${GOLDEN_FILE}`);
    process.exitCode = 1;
    return;
  }
  const report = parseKbIndex(readFileSync(INDEX_FILE, 'utf8'));
  const gold = readJsonl<Gold>(GOLDEN_FILE, (r) => {
    const q = typeof r.q === 'string' ? r.q : '';
    if (!q) return null;
    return {
      q,
      expectDocs: Array.isArray(r.expect_docs) ? (r.expect_docs as string[]) : [],
      expectKeywords: Array.isArray(r.expect_keywords) ? (r.expect_keywords as string[]) : [],
    };
  });
  console.log(`KB index      : ${report.chunks.length} chunks / ${report.docs} docs (${report.skipped} bad lines skipped)`);
  console.log(`golden        : ${gold.length} questions`);
  console.log(`chunk size    : app default ${DEFAULT_CHUNK_SIZE} chars + ${DEFAULT_CHUNK_OVERLAP} overlap`);
  console.log('');
  console.log('NOTE 本工具不使用 gold 里的 job/intent，因此数字低于 _rag/baseline.json 是预期的。');
  console.log('      只在各变体之间横向比较。');
  console.log('');

  // ---- variant A: the KB's own structural chunks, lexical only ----
  const mkDocs = (stemOf: (c: KbChunk) => string, extraOf: (c: KbChunk) => string): Doc[] =>
    report.chunks.map((c: KbChunk) => ({
      id: c.chunkId,
      docId: c.docId,
      stem: stemOf(c),
      extra: extraOf(c),
    }));
  const build = (docs: Doc[]): LexicalIndex<Doc> => {
    const ix = new LexicalIndex<Doc>();
    ix.addAll(docs);
    return ix;
  };
  // field mapping matters more than it looks: LexicalIndex weights `stem` ×3,
  // and title/section are near-constant within one file, so putting them alone
  // in `stem` hands a 3× boost to a non-discriminative field.
  const idxTitle = build(mkDocs((c) => `${c.title} ${c.section}`, (c) => `${metaFieldOf(c)} ${c.text}`));
  const idxText = build(mkDocs((c) => `${c.section} ${c.text.slice(0, 400)}`, (c) => `${c.title} ${metaFieldOf(c)} ${c.text}`));
  const idxBreadcrumb = build(
    mkDocs(
      (c) => `${c.breadcrumb.join(' ')} ${c.section} ${c.text.slice(0, 400)}`,
      (c) => `${c.title} ${metaFieldOf(c)} ${c.text}`,
    ),
  );

  // ---- variant B: what the app would build itself (300-char sliding window) ----
  const appDocs: Doc[] = [];
  for (const file of walk(KB_ROOT)) {
    const md = readFileSync(file, 'utf8');
    const docId = frontmatterId(md) || file.split(/[\\/]/).pop()!.replace(/\.md$/, '');
    for (const piece of chunkText(md, { chunkSize: DEFAULT_CHUNK_SIZE, overlap: DEFAULT_CHUNK_OVERLAP })) {
      appDocs.push({ id: `${docId}#${appDocs.length}`, docId, stem: piece.slice(0, 120), extra: piece });
    }
  }
  const idxApp = new LexicalIndex<Doc>();
  idxApp.addAll(appDocs);

  const rows: [string, ReturnType<typeof evaluate>][] = [];
  for (const [name, ix] of [
    ['stem=标题+小节', idxTitle],
    ['stem=小节+正文首400', idxText],
    ['stem=面包屑+小节+正文首400', idxBreadcrumb],
  ] as const) {
    for (const topK of [3, 5, 8]) {
      rows.push([`KB分块 ${name} topK=${topK}`, evaluate(ix, gold, topK, 0)]);
    }
  }
  rows.push(['KB分块 stem=面包屑+小节+正文 topK=8 每文件≤2', evaluate(idxBreadcrumb, gold, 8, 2)]);
  const aliases = loadAliases();
  console.log(`别名表        : ${aliases.size} 组（来自 _rag/index/bm25_meta.json）`);
  for (const topK of [3, 5, 8]) {
    rows.push([`KB分块 stem=小节+正文首400 +别名 topK=${topK}`, evaluate(idxText, gold, topK, 0, aliases)]);
  }
  for (const topK of [3, 8]) {
    rows.push([`App滑窗分块 · 词法 · topK=${topK}`, evaluate(idxApp, gold, topK, 0)]);
  }

    // Run the metric against the SHIPPED retriever, not a re-implementation of
  // it. Without these rows the numbers above would describe a prototype only
  // this file knows about; these are what actually execute at question time.
  for (const topK of [3, 5, 8]) {
    const kb = new KbRetrieval();
    if (!kb.load(INDEX_FILE)) {
      console.error(`KbRetrieval failed to load: ${kb.state.error}`);
      break;
    }
    let hit = 0;
    let mrr = 0;
    let kw = 0;
    let ms = 0;
    let conflicts = 0;
    for (const g of gold) {
      const t0 = Date.now();
      const found = kb.search(g.q, topK);
      ms += Date.now() - t0;
      const exp = new Set(g.expectDocs);
      const rank = found.findIndex((h) => exp.has(h.docId));
      if (rank >= 0) {
        hit += 1;
        mrr += 1 / (rank + 1);
      }
      if (
        !g.expectKeywords.length ||
        g.expectKeywords.every((k) => found.some((h) => h.text.toLowerCase().includes(k.toLowerCase())))
      ) {
        kw += 1;
      }
      conflicts += found.filter((h) => h.conflicting).length;
    }
    const n = gold.length || 1;
    rows.push([
      `【运行时 KbRetrieval】topK=${topK} 冲突块${conflicts}`,
      { hit: hit / n, mrr: mrr / n, kw: kw / n, ms: ms / n, n },
    ]);
  }

  // Corpus-level view of the conflict marker: the rate is what tells us whether
  // it is a signal or noise, and the 40.5/29.03 case is what tells us tightening
  // did not throw away the one thing it exists to catch.
  const flagged = report.chunks.filter((c) => /⚠|口径不一致|口径冲突|数字口径|两个口径|多口径|以哪一份为准|待核实|未实测|实测为?.{0,12}(为准|不符)|与.{0,10}口径(冲突|不一致)/.test(c.text));
  const fps = report.chunks.filter((c) => /40\.5\s*FPS/i.test(c.text) || /29\.03\s*FPS/i.test(c.text));
  console.log(
    `冲突标记      : ${flagged.length}/${report.chunks.length} 块 (${((flagged.length / report.chunks.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `40.5/29.03 块 : ${fps.length} 个，其中已标记 ${fps.filter((c) => flagged.includes(c)).length} 个` +
      ` → ${fps.map((c) => c.docId).join(', ') || '（无）'}`,
  );
  console.log('');

  console.log('变体                                          Hit@k    MRR    关键词   均耗时');
  for (const [label, r] of rows) {
    console.log(
      `${label.padEnd(36)} ${pct(r.hit).padStart(6)} ${pct(r.mrr).padStart(7)} ${pct(r.kw).padStart(8)} ${r.ms.toFixed(1).padStart(7)}ms`,
    );
  }
  console.log('');
  console.log(
    `索引规模: KB分块 ${idxTitle.size} 块 · App滑窗 ${idxApp.size} 块 (${(statSync(INDEX_FILE).size / 1048576).toFixed(2)} MB 源索引)`,
  );
}

main();
