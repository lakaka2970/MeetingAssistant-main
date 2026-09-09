/**
 * Offline lexical index for the question banks (做题模式).
 *
 * Why not embeddings here: an OA screen shows the bank's 题干 nearly
 * character-for-character, so a normalised lexical match is both more accurate
 * and three orders of magnitude faster than a vector round-trip (sub-millisecond
 * vs a model load), needs no 600 MB download, and stays fully offline — which
 * is what a live test demands. A `qa`-style semantic layer stays available for
 * interview paraphrase matching; this is the "the same question is in my bank"
 * fast path.
 *
 * Design: character normalisation + a CJK bigram / latin-word inverted index,
 * idf-weighted coverage, a numeric guard (行测 资料分析 questions differ only
 * in their numbers), and an explicit confidence tier so the caller can decide
 * between "answer from the bank", "answer with the bank as a hint", and
 * "don't mention the bank at all".
 *
 * Pure logic — no fs, no electron — unit-testable and reusable by both
 * processes.
 */

/** digits and latin words survive; CJK is indexed on bigrams */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_WORD = /[a-z0-9_]+/g;
/** whitespace: collapse to one space */
const NOISE = /[\s\u3000]+/g;
/** markdown/CJK punctuation that carries no meaning in a stem: removed outright,
 * so `**下列**哪一项` and `下列哪一项` normalize identically */
const MARKUP = /[*_~`>#\\·…——–\-]/g;

const FULL_WIDTH = /[\uff01-\uff5e]/g;

function toHalfWidth(s: string): string {
  return s.replace(FULL_WIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * One comparison key for a stem or query: half width, no markdown or
 * punctuation, lowercase, spaces collapsed. Two questions that differ only in
 * layout, emphasis or full/half-width punctuation land on the same string.
 */
export function normalizeQuestion(s: string): string {
  return toHalfWidth(s)
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, l) => l || t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // an obsidian #tag before CJK is metadata, not part of the question
    .replace(/(^|\s)#+(?=[\p{Script=Han}])/gu, '$1')
    .replace(/\\?\|/g, ' ')
    .replace(MARKUP, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(NOISE, ' ')
    .toLowerCase()
    .trim();
}

/** indexable tokens: latin words / numbers, plus CJK bigrams (unigram if len 1) */
export function tokenize(normalized: string): string[] {
  const out: string[] = [];
  const latin = normalized.match(LATIN_WORD);
  if (latin) out.push(...latin);
  for (const run of normalized.match(/[^\x00-\x7f]+/g) ?? []) {
    const chars = [...run].filter((c) => CJK.test(c));
    if (!chars.length) continue;
    if (chars.length === 1) out.push(chars[0]);
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** the numbers inside a question — the discriminative part of 资料分析 stems */
function numbersOf(normalized: string): string[] {
  return normalized.match(/\d+(?:\.\d+)?/g) ?? [];
}

export interface LexicalDoc {
  /** what the caller wants back (a BankEntry id, a row, anything) */
  id: string;
  /** the stem — weighted most heavily */
  stem: string;
  /** option texts + tags + explanation: secondary evidence */
  extra?: string;
}

export type MatchConfidence = 'exact' | 'strong' | 'weak';

export interface LexicalHit<T> {
  doc: T;
  /** [0,1]; 1 == the query's normalised stem is contained in this stem */
  score: number;
  /** share of the query's idf-weighted tokens found in the document */
  cover: number;
  confidence: MatchConfidence;
}

export interface SearchOptions {
  limit?: number;
  /** drop hits below this weighted token coverage (default 0.34) */
  minCover?: number;
}

interface Posting {
  /** docIndex → term frequency */
  tfs: Map<number, number>;
}

const STEM_WEIGHT = 3;
const EXTRA_WEIGHT = 1;
/**
 * A token is a discriminator when it appears in at most this much of the
 * corpus — with `max(1, …)` so a five-question bank still has discriminators
 * (a df-of-1 token is the whole signal there).
 */
const RARE_DF_RATIO = 0.12;
/** a token in more than this share of docs is a stopword: no information, and
 * scanning its postings is the difference between sub-ms and tens of ms */
const STOPWORD_DF_RATIO = 0.6;

/**
 * A small in-memory inverted index. Documents are added in bulk at load;
 * a query walks only the informative query tokens' postings — one pass, no
 * per-candidate rescanning — so even a 20k-question bank answers in ~1 ms.
 * That matters: a bank hit must never be the thing that makes the user wait.
 */
export class LexicalIndex<T extends LexicalDoc = LexicalDoc> {
  private docs: T[] = [];
  private post = new Map<string, Posting>();
  /** normalised stems, for the containment check */
  private normStem: string[] = [];
  /** the same with all whitespace removed — a PDF wraps `公众宣传` as
   * `公众 宣传`, and that stray space must not cost the original-question hit */
  private normFlat: string[] = [];
  private nums: string[][] = [];

  get size(): number {
    return this.docs.length;
  }

  clear(): void {
    this.docs = [];
    this.post.clear();
    this.normStem = [];
    this.normFlat = [];
    this.nums = [];
  }

  add(doc: T): void {
    const i = this.docs.length;
    this.docs.push(doc);
    const stemNorm = normalizeQuestion(doc.stem);
    this.normStem.push(stemNorm);
    this.normFlat.push(stemNorm.replace(/\s+/g, ''));
    this.nums.push(numbersOf(stemNorm));
    const bump = (text: string, weight: number): void => {
      for (const t of tokenize(text)) {
        let p = this.post.get(t);
        if (!p) this.post.set(t, (p = { tfs: new Map() }));
        p.tfs.set(i, (p.tfs.get(i) ?? 0) + weight);
      }
    };
    bump(stemNorm, STEM_WEIGHT);
    if (doc.extra) bump(normalizeQuestion(doc.extra), EXTRA_WEIGHT);
  }

  addAll(docs: T[]): void {
    for (const d of docs) this.add(d);
  }

  /**
   * Drop the documents matching `pred` — the same contract as
   * VectorStore.removeWhere, so `pred` selects what goes away, not what stays.
   * Used when a bank file is removed or re-imported.
   */
  removeWhere(pred: (doc: T) => boolean): number {
    const keep = this.docs.filter((d) => !pred(d));
    if (keep.length === this.docs.length) return 0;
    const removed = this.docs.length - keep.length;
    this.clear();
    this.addAll(keep);
    return removed;
  }

  search(query: string, opts: SearchOptions = {}): LexicalHit<T>[] {
    const limit = Math.max(1, opts.limit ?? 5);
    const minCover = opts.minCover ?? 0.34;
    const qNorm = normalizeQuestion(query);
    if (!qNorm) return [];
    const total = this.docs.length || 1;
    const rareMax = Math.max(1, total * RARE_DF_RATIO);

    // Coverage must be measured against the whole question: a term the corpus
    // has never seen is the strongest possible evidence of a mismatch, so it
    // joins the denominator with no postings. (Excluding it would let any two
    // questions that share one word score as a perfect match.)
    const stopwordMax = total >= 20 ? Math.max(3, total * STOPWORD_DF_RATIO) : Number.POSITIVE_INFINITY;
    const kept: { posting: Posting; idf: number; rare: boolean }[] = [];
    let idfSum = 0;
    for (const token of new Set(tokenize(qNorm))) {
      const posting = this.post.get(token);
      const df = posting?.tfs.size ?? 0;
      if (posting && df > stopwordMax) continue; // corpus-wide filler: no signal
      const idf = Math.log(1 + total / (1 + df));
      idfSum += idf;
      if (posting) kept.push({ posting, idf, rare: df <= rareMax });
    }
    if (!kept.length || idfSum <= 0) return [];

    const coverW = new Map<number, number>();
    const disc = new Set<number>();
    for (const { posting, idf, rare } of kept) {
      for (const [idx, tf] of posting.tfs) {
        // tf only nudges the score: repeating a term inside one long document
        // must not out-rank a document that matched more of the question
        coverW.set(idx, (coverW.get(idx) ?? 0) + idf * (1 + 0.15 * Math.log(tf)));
        if (rare) disc.add(idx);
      }
    }

    const qNums = numbersOf(qNorm);
    // a fragment («料的主旨») has almost no information to match on: anything it
    // "hits" is a coincidence of two shared characters, so it must be an exact
    // containment or nothing at all
    const qFlat = qNorm.replace(/\s+/g, '');
    const qLen = qFlat.length;
    const shortQuery = qLen < 8;
    const out: LexicalHit<T>[] = [];
    for (const [idx, weight] of coverW) {
      const cover = Math.min(1, weight / idfSum);
      const discriminative = disc.has(idx);
      // the substring scan is the expensive part — only pay for plausible docs
      const s = this.normFlat[idx];
      const q = qFlat;
      const sLen = s.length;
      const docInQuery = sLen >= 8 && q.includes(s);
      const queryInDoc = qLen >= 8 && s.includes(q);
      // Containment is not proof of a same question: 资料分析 and 言语理解 items
      // share a long 材料 and differ only in the tail they ask («…最适合本文的
      // 标题是»), which is a substring of dozens of other records. Treat the
      // short-side-inside-the-long-side case as a hint, not as an original hit —
      // the model adjudicates, and a wrong letter never gets printed as one.
      const sameLength = qLen >= sLen * 0.6 && sLen >= qLen * 0.6;
      const containment = (docInQuery && sLen >= 8) || (queryInDoc && (sameLength || qLen >= 40));
      if (!containment && !discriminative) continue;
      if (shortQuery && !containment && cover < 0.85) continue;
      // different numbers ⇒ different 资料分析 question, however similar the prose
      if (qNums.length) {
        const d = this.nums[idx];
        if (d.length && !d.some((n) => qNums.includes(n))) continue;
      }
      if (cover < minCover && !containment) continue;
      const score = containment
        ? Math.max(0.97, cover)
        : (queryInDoc ? Math.max(cover, 0.8) : cover) * (discriminative ? 1 : 0.85);
      out.push({
        doc: this.docs[idx],
        score: Number(score.toFixed(4)),
        cover: Number(cover.toFixed(4)),
        confidence: containment ? 'exact' : score >= 0.62 ? 'strong' : 'weak',
      });
    }
    out.sort((a, b) => b.score - a.score || a.doc.stem.length - b.doc.stem.length);
    return out.slice(0, limit);
  }
}

/**
 * Does the bank answer this question, hint at it, or not know it? The caller
 * needs three behaviours, not a score: print the bank's answer, use it as
 * context, or ignore the bank and answer from the model (+ web).
 */
export function judgeMatch<T extends LexicalDoc>(
  hits: LexicalHit<T>[],
  opts: { strong?: number; weakFloor?: number } = {},
): { best?: LexicalHit<T>; confidence: MatchConfidence | 'none' } {
  const strong = opts.strong ?? 0.62;
  const weakFloor = opts.weakFloor ?? 0.4;
  const best = hits[0];
  if (!best) return { confidence: 'none' };
  if (best.confidence === 'exact' || best.score >= strong) return { best, confidence: 'strong' };
  if (best.score >= weakFloor) return { best, confidence: 'weak' };
  return { best, confidence: 'none' };
}
