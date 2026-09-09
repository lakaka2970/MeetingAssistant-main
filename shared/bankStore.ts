/**
 * The exam-mode question-bank store: parsed entries per sub-mode plus a lexical
 * index, kept COMPLETELY separate from the interview knowledge base.
 *
 * Why separate (and why not the RAG `doc` source): every `doc`/`qa` record in
 * `rag/index.json` with no sessionId is visible to every interview session
 * (vector-store's scope rule), and the Q&A harvester happily reads
 * 「| 考点 | 要点 |」tables. Importing an 行测 bank there would therefore start
 * answering interviews with civil-service arithmetic — the two modes must not
 * leak into each other. So banks live here: their own file, their own index,
 * their own lookup, and a purely lexical one (no embedding model, no download,
 * sub-millisecond — which is what "high-speed retrieval over a local bank"
 * actually needs).
 *
 * Pure logic — no fs, no electron. The main process feeds it
 * `{ref, text}` files and persists the JSON itself.
 */
import { parseBankFile, type BankEntry } from './bankParse';
import { judgeMatch, LexicalIndex, type LexicalDoc, type LexicalHit } from './lexicalIndex';

/** which kind of test question the user is facing */
export type ExamSubMode = 'aptitude' | 'technical' | 'personality' | 'open';

export const EXAM_SUB_MODES: ExamSubMode[] = ['aptitude', 'technical', 'personality', 'open'];

export interface BankFile {
  /** display name / relative path — becomes the entry `ref` */
  ref: string;
  text: string;
}

export interface BankSearchHit {
  entry: BankEntry;
  score: number;
  cover: number;
  confidence: 'exact' | 'strong' | 'weak';
}

export interface BankVerdict {
  /** 'bank' = answer from the user's own bank, no model needed */
  mode: 'bank' | 'hint' | 'none';
  best?: BankSearchHit;
  others: BankSearchHit[];
  /** how many records in this bank carry `best`'s exact stem; >1 means the stem
   * is a shared instruction (every 图形推理 item says the same thing and the
   * figure is the question), so no letter may be claimed from text alone */
  stemCopies?: number;
  ms: number;
}

interface PerMode {
  dir?: string;
  entries: BankEntry[];
  /** id → entry, so a search hit resolves without scanning the bank */
  byId: Map<string, BankEntry>;
  /** the index holds stem/option projections, not the full entry (see search) */
  index: LexicalIndex;
  /** flatKey(stem) → how many entries share it */
  stemCount: Map<string, number>;
  files: number;
  loadedAt?: number;
}

const indexOf = (entries: BankEntry[]): Map<string, BankEntry> =>
  new Map(entries.map((e) => [e.id, e]));

const countStems = (entries: BankEntry[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const e of entries) m.set(flatKey(e.stem), (m.get(flatKey(e.stem)) ?? 0) + 1);
  return m;
};

const EMPTY: PerMode = {
  entries: [],
  byId: new Map(),
  index: new LexicalIndex(),
  stemCount: new Map(),
  files: 0,
};

export class BankStore {
  private byMode = new Map<ExamSubMode, PerMode>();

  private slot(mode: ExamSubMode): PerMode {
    let p = this.byMode.get(mode);
    if (!p) {
      p = { entries: [], byId: new Map(), index: new LexicalIndex(), stemCount: new Map(), files: 0 };
      this.byMode.set(mode, p);
    }
    return p;
  }

  /**
   * Replace one sub-mode's bank with a fresh set of files (a directory re-scan
   * or a bind). Parsing is per file; a file that yields nothing is counted as
   * `emptyFiles` so the UI can tell "no bank" from "bank we could not read".
   */
  replace(mode: ExamSubMode, files: BankFile[], dir?: string): { entries: number; emptyFiles: number } {
    const entries: BankEntry[] = [];
    let emptyFiles = 0;
    for (const f of files) {
      const parsed = parseBankFile(f.ref, f.text);
      if (!parsed.entries.length) emptyFiles++;
      entries.push(...parsed.entries);
    }
    const slot: PerMode = {
      dir,
      entries,
      byId: indexOf(entries),
      index: new LexicalIndex(),
      stemCount: countStems(entries),
      files: files.length,
      loadedAt: Date.now(),
    };
    slot.index.addAll(
      entries.map((e) => ({
        id: e.id,
        stem: e.stem,
        // options + tags are secondary evidence: they catch the case where the
        // stem was rephrased but the (distinctive) options were copied
        extra: [...e.options.map((o) => o.text), ...e.tags].join(' '),
      })),
    );
    this.byMode.set(mode, slot);
    return { entries: entries.length, emptyFiles };
  }

  bindDir(mode: ExamSubMode, dir: string): void {
    const p = this.slot(mode);
    p.dir = dir;
  }

  /**
   * Load entries the caller already produced — the PDF path needs this, because
   * a 学生版/答案版 pair is only meaningful when the two files are read and
   * joined together (shared/answerKey.ts), which the fs layer does.
   */
  replaceEntries(mode: ExamSubMode, incoming: BankEntry[], dir?: string): BankMergeResult {
    const merged = mergeDuplicateEntries(incoming);
    const entries = merged.entries;
    const p: PerMode = {
      dir,
      entries,
      byId: indexOf(entries),
      index: new LexicalIndex(),
      stemCount: countStems(entries),
      files: 0,
      loadedAt: Date.now(),
    };
    p.index.addAll(
      entries.map((e) => ({
        id: e.id,
        stem: e.stem,
        extra: [...e.options.map((o) => o.text), ...e.tags].join(' '),
      })),
    );
    this.byMode.set(mode, p);
    return merged;
  }

  clear(mode?: ExamSubMode): void {
    if (mode) this.byMode.delete(mode);
    else this.byMode.clear();
  }

  get size(): number {
    let n = 0;
    for (const p of this.byMode.values()) n += p.entries.length;
    return n;
  }

  status(): Record<ExamSubMode, { dir?: string; files: number; entries: number; mc: number; loadedAt?: number }> {
    const out = {} as Record<ExamSubMode, { dir?: string; files: number; entries: number; mc: number; loadedAt?: number }>;
    for (const m of EXAM_SUB_MODES) {
      const p = this.byMode.get(m) ?? EMPTY;
      out[m] = {
        dir: p.dir,
        files: p.files,
        entries: p.entries.length,
        mc: p.entries.filter((e) => e.kind === 'mc').length,
        loadedAt: p.loadedAt,
      };
    }
    return out;
  }

  /** entries of one sub-mode (for the panel's browse view) */
  list(mode: ExamSubMode, limit = 200): BankEntry[] {
    return (this.byMode.get(mode) ?? EMPTY).entries.slice(0, limit);
  }

  /**
   * Look the question up in a sub-mode's bank. `hint` (weak) is deliberately
   * distinct from `bank`: a weak match is shown as "类似的题在库里,答案是…"
   * and the model still answers, whereas `bank` is printed as the answer.
   *
   * Entries with no answer are never returned as an answer. A paper indexed
   * whole contains reading-comprehension sub-items whose key lives in another
   * section (or was simply not printed) — surfacing 「料的主旨 → (blank)」 as a
   * hit would be worse than admitting the bank does not answer it.
   */
  search(mode: ExamSubMode, question: string, limit = 3): BankVerdict {
    const t0 = Date.now();
    const p = this.byMode.get(mode) ?? EMPTY;
    const q = question.trim();
    // Below a handful of characters nothing identifies a question in a bank of
    // thousands — `选 D` would "match" a hundred stems by accident. Saying the
    // bank does not answer it is the correct answer; guessing is not.
    if (!q || !p.entries.length || q.replace(/\s/g, '').length < 6) {
      return { mode: 'none', others: [], ms: Date.now() - t0 };
    }
    const answerable = (h: LexicalHit<LexicalDoc>): boolean => {
      const e = p.byId.get(h.doc.id);
      if (!e || !e.answer.trim()) return false;
      // a bare letter with no options on the entry cannot be a real key for this
      // stem: PDF column splits make such a number match another section's
      // answer, and answering 「来克服它的 → C」 would be wrong with confidence
      if (!e.options.length && /^[A-H]$/.test(e.answer.trim().toUpperCase())) return false;
      // a wrapped line can leave a 4-character stem fragment behind; it matches
      // almost anything by accident and is never worth presenting as a hit
      if (e.stem.replace(/\s/g, '').length < 6) return false;
      return true;
    };
    const raw = p.index.search(q, { limit: limit + 3 }).filter(answerable);
    // the index stores stem projections, so every hit is resolved back to its
    // full entry by id before it is handed to the caller
    const toView = (h: LexicalHit<LexicalDoc>): BankSearchHit | null => {
      const entry = p.byId.get(h.doc.id);
      if (!entry) return null;
      return { entry, score: h.score, cover: h.cover, confidence: h.confidence };
    };
    const views = raw.map(toView).filter((v): v is BankSearchHit => !!v);
    const judged = judgeMatch(raw);
    const best = judged.best ? toView(judged.best) : undefined;
    const stemCopies = best ? (p.stemCount.get(flatKey(best.entry.stem)) ?? 1) : 1;
    if (judged.confidence === 'none' || !best)
      return { mode: 'none', others: views.slice(0, Math.max(1, limit - 1)), stemCopies: 1, ms: Date.now() - t0 };
    return {
      mode: judged.confidence === 'strong' ? 'bank' : 'hint',
      best,
      others: views.slice(0, limit).filter((v) => v.entry.id !== best!.entry.id),
      stemCopies,
      ms: Date.now() - t0,
    };
  }

  /**
   * Search across the sub-modes a screen shot could belong to, so one capture
   * does not force the user to pre-classify. `aptitude` and `technical` are
   * tried first because their banks are large and specific.
   */
  searchAll(question: string, limit = 3): { mode: ExamSubMode; verdict: BankVerdict }[] {
    const order: ExamSubMode[] = ['aptitude', 'technical', 'personality', 'open'];
    return order
      .filter((m) => (this.byMode.get(m)?.entries.length ?? 0) > 0)
      .map((m) => ({ mode: m, verdict: this.search(m, question, limit) }));
  }
}

/**
 * An OA screen reshuffles the options, so the bank's letter means nothing on
 * its own. Re-anchor the answer onto the letters as they appear on screen:
 * match by option text, fall back to the bank letter when the screen order is
 * unknown. Returns undefined when the screen options do not overlap the bank's
 * at all (a different variant of the same question) — then the caller must NOT
 * claim a bank answer.
 */
export function reanchorAnswer(
  entry: Pick<BankEntry, 'answerKey' | 'answerText' | 'options'>,
  screenOptions: string[],
): { letter?: string; text: string; reanchored: boolean } | undefined {
  const norm = (s: string): string => s.replace(/[\s，。.；;：:、]/g, '').toLowerCase();
  const bankText = entry.answerText ?? entry.options.find((o) => o.key === entry.answerKey)?.text ?? '';
  if (!bankText) return undefined;
  if (!screenOptions.length) {
    return { letter: entry.answerKey, text: bankText, reanchored: false };
  }
  const idx = screenOptions.findIndex((s) => {
    const t = norm(s);
    return t === norm(bankText) || (t.length > 3 && (t.includes(norm(bankText)) || norm(bankText).includes(t)));
  });
  if (idx < 0) {
    // A multiple-choice entry whose options do not appear on screen is a
    // different variant of the same stem — the letter and the text are both
    // untrustworthy, so refuse rather than send the user to the wrong option.
    if (entry.options.length) return undefined;
    return entry.answerText ? { text: entry.answerText, reanchored: false } : undefined;
  }
  return { letter: String.fromCharCode(65 + idx), text: screenOptions[idx], reanchored: true };
}

export interface BankMergeResult {
  entries: BankEntry[];
  /** dropped: another record asked the same thing and answered it the same way */
  duplicates: number;
  /** refused as a direct answer: the user's own files disagree about this one */
  conflicts: number;
}

const flatKey = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

const richest = (list: BankEntry[]): BankEntry =>
  list.reduce((a, b) => ((b.explanation?.length ?? 0) > (a.explanation?.length ?? 0) ? b : a));

/**
 * Collapse the same question appearing in several files.
 *
 * A real 题库 directory is a pile of downloaded packs, so one question arrives
 * five times — sometimes with five different letters, because at least one of
 * those packs is wrong. Printing any of them as fact is the failure this mode
 * cannot afford, so: a unanimous group keeps its best-documented member, a
 * majority keeps its answer with the dissent recorded in the explanation, and a
 * tie becomes an entry that cannot be answered directly but still shows the
 * user that their sources contradict each other.
 */
export function mergeDuplicateEntries(list: BankEntry[]): BankMergeResult {
  const order: string[] = [];
  const groups = new Map<string, BankEntry[]>();
  for (const e of list) {
    const key = `${flatKey(e.stem)}|${e.options.map((o) => flatKey(o.text)).sort().join('|')}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else {
      groups.set(key, [e]);
      order.push(key);
    }
  }
  const entries: BankEntry[] = [];
  let duplicates = 0;
  let conflicts = 0;
  for (const key of order) {
    const g = groups.get(key)!;
    if (g.length === 1) {
      entries.push(g[0]);
      continue;
    }
    duplicates += g.length - 1;
    const tally = new Map<string, BankEntry[]>();
    for (const e of g) {
      const k = e.answerKey ?? flatKey(e.answer);
      const t = tally.get(k);
      if (t) t.push(e);
      else tally.set(k, [e]);
    }
    if (tally.size === 1) {
      entries.push(richest(g));
      continue;
    }
    const ranked = [...tally.entries()].sort((a, b) => b[1].length - a[1].length);
    const topEntries = ranked[0][1];
    const runner = ranked[1]?.[1];
    const base = richest(topEntries);
    if (!runner || topEntries.length > runner.length) {
      const dissent = ranked
        .slice(1)
        .map(([k, v]) => `${k}（${v.length} 份）`)
        .join('、');
      entries.push({
        ...base,
        explanation: `${base.explanation ? base.explanation + ' ' : ''}【注意】另有 ${dissent} 的题库给出不同答案。`,
      });
      continue;
    }
    // a tie: no way to know which pack is right, so say exactly that
    conflicts++;
    entries.push({
      ...base,
      kind: 'open',
      answerKey: undefined,
      answerText: undefined,
      answer: `你的题库对这道题的答案不一致（${ranked.map(([k, v]) => `${k}×${v.length}`).join('、')}），请自行核对`,
      explanation: ranked
        .map(([k, v]) => `· ${k}：${(v[0].answerText ?? v[0].answer).replace(/\s+/g, ' ').slice(0, 60)}`)
        .join('\n'),
    });
  }
  return { entries, duplicates, conflicts };
}

export interface BankDecision {
  best?: BankSearchHit;
  /** the letter as the SCREEN would show it, after re-anchoring */
  letter?: string;
  /** near matches worth confirming, best first */
  near: BankSearchHit[];
  /** two bank records that look alike but answer differently */
  disagree: boolean;
  /** the winning stem belongs to one record only, so it actually identifies it */
  unique: boolean;
  /** safe to print the bank's answer without a model */
  direct: boolean;
}

/**
 * The whole safety gate in one function, so no caller can invent a looser one:
 * a bank answer is printed as fact only when the stem is an original-level hit,
 * the entry is objective, the letter can be anchored onto the screen options,
 * and no equally-good record contradicts it. Everything weaker is handed to the
 * model with the bank as context, and a contradiction is shown as a choice.
 */
export function decideBankAnswer(
  verdict: BankVerdict,
  screenOptions: string[],
  opts: { wantsExplanation?: boolean } = {},
): BankDecision {
  const best = verdict.best;
  if (!best) return { near: verdict.others, disagree: false, unique: false, direct: false };
  const anchored = reanchorAnswer(best.entry, screenOptions);
  const letter = anchored?.letter ?? (anchored ? best.entry.answerKey : undefined);
  const near = [best, ...verdict.others].slice(0, 3);
  const rival = near[1] && near[1].score >= best.score - NEAR_TIE ? near[1] : undefined;
  const keyOf = (h: BankSearchHit): string => h.entry.answerKey ?? h.entry.answer;
  const disagree = !!rival && keyOf(rival) !== keyOf(best);
  // «从所给的四个选项中，选择最合适的一个填入问号处» is not a question: it is
  // the instruction above every 图形推理 item, and the figure — which no text
  // match can see — is the question. A character count cannot tell those apart
  // from a real 33-character stem, so the caller passes in how many bank records
  // carry this same stem: more than one means the stem identifies nothing.
  const unique = (verdict.stemCopies ?? 1) <= 1;
  const direct =
    best.confidence === 'exact' &&
    best.entry.kind === 'mc' &&
    !!letter &&
    !disagree &&
    unique &&
    !opts.wantsExplanation;
  return { best, letter, near, disagree, unique, direct };
}

/** within this much of the top score, a second record is a real competitor */
const NEAR_TIE = 0.08;

/** the block injected into the exam prompt when the bank answered */
export function formatBankBlock(hit: BankSearchHit, screenOptions: string[]): string {
  const e = hit.entry;
  const anchored = reanchorAnswer(e, screenOptions);
  // A weak hit must not read like a hit: the model is told to think for itself
  // here, because «相似度 0.47» in a bank of thousands is a different question
  // that happens to share a topic.
  const lines =
    hit.confidence === 'weak'
      ? [`【题库里最相近的题】相似度仅 ${hit.score}，很可能不是同一道题：只作参考，按屏幕题目自己判断`]
      : [`【题库命中】(${hit.confidence === 'exact' ? '原题' : '同义题干'} · 相似度 ${hit.score})`];
  lines.push(`题干：${e.stem}`);
  if (e.options.length) lines.push(`库内选项：${e.options.map((o) => `${o.key}. ${o.text}`).join(' / ')}`);
  if (anchored?.letter) lines.push(`答案：${anchored.letter}${anchored.text ? ` （${anchored.text}）` : ''}`);
  else if (anchored?.text) lines.push(`答案：${anchored.text}`);
  // re-anchoring can fail (the screen shows no options, or a shuffled variant);
  // the stored answer is still the library's own, so show it rather than nothing
  else if (e.answer) lines.push(`答案（库内原文，字母以屏幕选项为准）：${e.answer}`);
  if (e.explanation) lines.push(`解析：${e.explanation}`);
  if (screenOptions.length && anchored?.reanchored === false) {
    lines.push('注意：屏幕上的选项与题库不一致，可能是同题变体 —— 以选项文字为准重新判断。');
  }
  return lines.join('\n');
}
