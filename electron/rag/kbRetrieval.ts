/**
 * Lexical retrieval over a pre-chunked knowledge base (`991_index.jsonl`).
 *
 * Why a separate channel instead of feeding the .md files to the ordinary
 * importer: the importer's 300-char sliding window destroys the KB's chunk
 * boundaries, and that costs real accuracy. Measured on the KB's own 45-question
 * set (npm run kb:eval, same metric definition as the KB's Python CLI, and
 * WITHOUT the leaked job/intent the Python evaluation feeds itself):
 *
 *   app sliding-window chunks, dense-only topK=3   Hit@5 0.489  MRR 0.356  kw 0.622
 *   KB structural chunks, lexical, topK=5 + aliases Hit@5 0.689  MRR 0.417  kw 0.800
 *
 * Why lexical at all, when the app has a vector store: because it needs no
 * model download (bge-m3 is 620 MB and may not be cached), it costs 0.3 ms, and
 * the questions in this KB are full of exact terms — 非极大值抑制 vs NMS,
 * 交并比 vs IoU — which is exactly where dense cosine drifts.
 *
 * Deliberately NOT ported from the Python side, because measuring said no:
 *  - `max_per_file = 2`: it lowered keyword coverage here (0.844 → 0.822). That
 *    rule suits a corpus with duplicated papers, not a 569-block index.
 *  - the 2.6/1.9/1.5/1.0 four-field weights: they were tuned on jieba tokens
 *    over four separately-indexed fields. LexicalIndex indexes two fields, and
 *    putting `title` in the high-weight one measurably HURT (title is constant
 *    across a file's blocks, so it hands a 3x boost to a non-discriminative
 *    field). Section + the head of the body is what actually discriminates.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { LexicalIndex } from '../../shared/lexicalIndex';
import { metaFieldOf, parseKbIndex, type KbChunk } from './kbIndex';

export interface KbHit {
  text: string;
  /** `P17-04 §4. 高频面试问答` — a human-readable locus, so the answer can cite it */
  ref: string;
  docId: string;
  section: string;
  jobPrimary: string;
  layer: string;
  priority: string;
  score: number;
  /** the chunk carries an unresolved-terms marker, so the prompt must not pick a side */
  conflicting: boolean;
}

export interface KbStatus {
  loaded: boolean;
  /** the index file actually read */
  file: string;
  chunks: number;
  docs: number;
  aliases: number;
  /** mtime of the index, so a rebuild can be detected without hashing 1.7 MB */
  mtimeMs: number;
  error: string;
}

/**
 * Markers that a block carries a figure whose provenance is genuinely unsettled.
 *
 * Deliberately compounds, NOT bare 口径 / 冲突. In a radar and optics corpus
 * 口径 is an ordinary technical noun (天线口径, 波束口径) and 冲突 appears in
 * normal prose (关联冲突, 线程冲突); the loose version flagged ~1.9 blocks per
 * question and would have made the model hedge about routine engineering
 * content — a false alarm that erodes the one warning that matters.
 */
const CONFLICT_MARK =
  /(⚠|口径不一致|口径冲突|数字口径|两个口径|多口径|以哪一份为准|待核实|未实测|实测为?.{0,12}(为准|不符)|与.{0,10}口径(冲突|不一致))/;

/**
 * Intent → layer/type boosts, ported in spirit from the KB's own rule tables
 * and then RE-MEASURED here rather than trusted: those constants were tuned on
 * jieba scores over a different fusion, so a number that helps there can be
 * neutral or harmful against this lexical scorer.
 *
 * The asymmetry is deliberate and comes from how the corpus is written: asking
 * about your own project, paper or numbers must preferentially pull the 个人资产
 * layer (that is where the first-person, defensible detail lives), while asking
 * about a principle must NOT pull it — otherwise the model narrates a project
 * detail as if it were the textbook answer.
 */
const EVIDENCE_INTENT = /(我的|咱们|你负责|你做的|这个项目|该项目|论文|实验|实测|指标|贡献|创新点|简历|经历|深挖|怎么做的|实现细节)/;
const PRINCIPLE_INTENT = /(是什么|什么是|原理|为什么|如何推导|公式|定义|区别|优缺点|概念|机制)/;

function intentBoost(c: KbChunk, wantsEvidence: boolean, wantsPrinciple: boolean): number {
  let b = 1;
  if (wantsEvidence) {
    if (c.layer === '个人资产层') b *= 1.3;
    if (c.docType === '个人资产') b *= 1.2;
    // a block that cites concrete evidence is what a project question needs
    if (c.evidence.length) b *= 1.1;
  }
  if (wantsPrinciple) {
    if (c.layer === '通用基础层') b *= 1.2;
    if (c.layer === '个人资产层') b *= 0.85;
  }
  // navigation hubs answer "先看什么/投哪个岗位", not technical questions
  if (c.docType === '导航索引') b *= wantsEvidence ? 0.9 : 1.05;
  if (c.priority === 'P0') b *= 1.05;
  // a preamble block is mostly front-matter noise around a real section
  if (c.section.startsWith('_preamble') || !c.section.trim()) b *= 0.8;
  return b;
}

/** how much of the body goes into the high-weight field */
const STEM_HEAD_CHARS = 400;

interface KbDoc {
  id: string;
  docId: string;
  stem: string;
  extra: string;
}

export class KbRetrieval {
  private index: LexicalIndex<KbDoc> | null = null;
  private byId = new Map<string, KbChunk>();
  private aliases = new Map<string, string[]>();
  private status: KbStatus = {
    loaded: false,
    file: '',
    chunks: 0,
    docs: 0,
    aliases: 0,
    mtimeMs: 0,
    error: '',
  };

  get state(): KbStatus {
    return this.status;
  }

  /**
   * Accepts either the index file itself or any directory inside the KB — the
   * layout (`99_元数据与检索/991_index.jsonl`) is a convention of this KB, not a
   * path the user should have to type.
   */
  private resolveIndexFile(p: string): string | null {
    if (!p.trim()) return null;
    if (basename(p).toLowerCase() === '991_index.jsonl' && existsSync(p)) return p;
    const direct = join(p, '991_index.jsonl');
    if (existsSync(direct)) return direct;
    const nested = join(p, '99_元数据与检索', '991_index.jsonl');
    if (existsSync(nested)) return nested;
    // walk up two levels: the user may point at the metadata folder
    const up = join(dirname(dirname(p)), '99_元数据与检索', '991_index.jsonl');
    if (existsSync(up)) return up;
    return null;
  }

  /** (Re)load the index. Returns false, and keeps any previous index, on failure. */
  load(dirOrFile: string | undefined): boolean {
    if (!dirOrFile) {
      this.status = { ...this.status, error: '' };
      return false;
    }
    const file = this.resolveIndexFile(dirOrFile);
    if (!file) {
      this.status = { ...this.status, error: `未找到 991_index.jsonl（${dirOrFile}）` };
      return false;
    }
    let content = '';
    let mtimeMs = 0;
    try {
      content = readFileSync(file, 'utf8');
      mtimeMs = statSync(file).mtimeMs;
    } catch (e) {
      this.status = { ...this.status, error: `读取失败：${(e as Error).message}` };
      return false;
    }
    const parsed = parseKbIndex(content);
    if (!parsed.chunks.length) {
      this.status = { ...this.status, error: '索引为空或全部无法解析' };
      return false;
    }
    const idx = new LexicalIndex<KbDoc>();
    idx.addAll(
      parsed.chunks.map((c) => ({
        id: c.chunkId,
        docId: c.docId,
        stem: `${c.section} ${c.text.slice(0, STEM_HEAD_CHARS)}`,
        extra: `${c.title} ${metaFieldOf(c)} ${c.text}`,
      })),
    );
    this.index = idx;
    this.byId = new Map(parsed.chunks.map((c) => [c.chunkId, c]));
    this.aliases = loadAliases(join(dirname(file), '_rag', 'index', 'bm25_meta.json'));
    this.status = {
      loaded: true,
      file,
      chunks: parsed.chunks.length,
      docs: parsed.docs,
      aliases: this.aliases.size,
      mtimeMs,
      error: '',
    };
    return true;
  }

  /** true when the file behind the current index changed on disk */
  needsReload(dirOrFile: string | undefined): boolean {
    if (!this.status.loaded) return !!dirOrFile;
    const file = this.resolveIndexFile(dirOrFile ?? '');
    if (!file || file !== this.status.file) return true;
    try {
      return statSync(file).mtimeMs !== this.status.mtimeMs;
    } catch {
      return true;
    }
  }

  clear(): void {
    this.index = null;
    this.byId.clear();
    this.aliases.clear();
    this.status = { loaded: false, file: '', chunks: 0, docs: 0, aliases: 0, mtimeMs: 0, error: '' };
  }

  /**
   * Query expansion by term alias. Appending the expansions to the query (rather
   * than re-scoring) keeps the inverted index untouched and keeps the measured
   * +13% MRR. Bounded so a pathological query cannot explode.
   */
  private expand(query: string): string {
    if (!this.aliases.size) return query;
    const low = query.toLowerCase();
    const add = new Set<string>();
    for (const [term, targets] of this.aliases) {
      if (!low.includes(term)) continue;
      for (const t of targets) if (add.size < 24) add.add(t);
    }
    return add.size ? `${query} ${[...add].join(' ')}` : query;
  }

  search(query: string, topK = 5): KbHit[] {
    if (!this.index || query.trim().length < 2) return [];
    const wantsEvidence = EVIDENCE_INTENT.test(query);
    const wantsPrinciple = !wantsEvidence && PRINCIPLE_INTENT.test(query);
    const raw = this.index
      .search(this.expand(query), { limit: Math.max(topK * 6, 30) })
      .map((h) => {
        const c = this.byId.get(h.doc.id);
        if (!c) return null;
        return { c, score: h.score * intentBoost(c, wantsEvidence, wantsPrinciple) };
      })
      .filter((x): x is { c: KbChunk; score: number } => x !== null)
      .sort((a, b) => b.score - a.score);
    const out: KbHit[] = [];
    const seenSection = new Set<string>();
    for (const { c, score } of raw) {
      // two blocks of the same section answer the same way; keep the best one
      const sectionKey = `${c.docId}§${c.section}`;
      if (seenSection.has(sectionKey)) continue;
      seenSection.add(sectionKey);
      out.push({
        text: c.text,
        ref: `${c.docId} §${c.section}`.trim(),
        docId: c.docId,
        section: c.section,
        jobPrimary: c.jobPrimary,
        layer: c.layer,
        priority: c.priority,
        score: Number(score.toFixed(4)),
        conflicting: CONFLICT_MARK.test(c.text),
      });
      if (out.length >= topK) break;
    }
    return out;
  }
}

/**
 * The alias table lives in a derived, gitignored file the KB's own rebuild
 * writes. Read it when present (measured +13% MRR), silently proceed without it
 * when not — a missing convenience must not become an error.
 */
function loadAliases(file: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(file)) return out;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { aliases?: Record<string, unknown> };
    for (const [k, v] of Object.entries(j.aliases ?? {})) {
      if (typeof k !== 'string' || k.length < 2 || !Array.isArray(v)) continue;
      const targets = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (targets.length) out.set(k.toLowerCase(), targets);
    }
  } catch {
    /* ignore */
  }
  return out;
}
