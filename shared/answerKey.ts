/**
 * Student paper + answer paper → one bank.
 *
 * Real central/state-owned-enterprise and 北森 banks ship as two PDFs per set
 * (`…-学生版.pdf` / `…-答案版.pdf`), and the answer sheet is numbered per
 * SECTION: 第一部分 英语 has 1..77, then 第二部分 restarts at 1. Joining by
 * number alone would therefore attach an English answer to a logic question —
 * wrong with confidence, the worst possible failure here. So the join is keyed
 * by (section, number) and refuses to join sections it cannot align.
 *
 * PDF text also arrives damaged in a specific way — CJK headers come out as
 * 「中 国 东 方 航 空集 团」 — so every comparison here collapses spaces
 * rather than trusting the raw string.
 *
 * Pure logic — no fs, no electron.
 */
import type { BankEntry, BankOption } from './bankParse';

export interface RawQuestion {
  /** number as printed, restarts per section */
  no: number;
  section: string;
  /** monotonic section ordinal, so 「第一部分」 in one file matches the same part in the other */
  sectionIndex: number;
  stem: string;
  options: BankOption[];
  line: number;
}

export interface AnswerItem {
  no: number;
  section: string;
  sectionIndex: number;
  letter?: string;
  /** a written-out answer for non-lettered items (判断/填空/简答) */
  text?: string;
  explanation?: string;
}

/**
 * Section names, exactly as these papers print them. Matching is ANCHORED on
 * the whole line: a body sentence that merely contains 「选择」 or 「判断」 must
 * not start a new section — when it does, the (section, number) join key drifts
 * and answers get attached to the wrong questions.
 */
const SECTION_NAMES = [
  '英语', '数学', '数量关系', '言语理解与表达', '言语理解', '判断推理', '逻辑推理', '资料分析',
  '常识判断', '公共基础知识', '时政', '政治', '行测', '能力素质', '职业能力倾向测验', '性格测试',
  '性格测评', '心理测评', '汉语知识', '写作', '申论', '专业知识', '综合知识', '企业知识', '企业文化',
  '单项选择题', '多项选择', '不定项选择', '填空题', '判断题', '阅读理解', '完形填空', '简答题',
  '论述题', '案例分析', '案例分析题', '画图题', '口算题',
];

/** `第一部分        英语` / `一、言语理解` / `（二）判断题` / bare `数量关系` */
const SECTION_HEAD =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百]+\s*部\s*分\s*[:：、.．\s]*)?(?:[（(]?\s*[一二三四五六七八九十]{1,3}\s*[)）.、．:：]\s*)?([\u4e00-\u9fa5A-Za-z（）()、,，\s]{2,24}?)\s*$/;

function sectionTitleOf(line: string): string | undefined {
  const t = line.trim();
  // PDF text often spaces CJK out («第 一 部 分   英 语»), so judge the length
  // on the squashed form, and never treat a finished sentence as a heading
  if (!t || squash(t).length > 20 || /[。！？；]$/.test(t)) return undefined;
  const m = t.match(SECTION_HEAD);
  const cand = squash(m?.[1] ?? t);
  if (!cand) return undefined;
  for (const name of SECTION_NAMES) {
    const n = squash(name);
    if (cand === n || (cand.length > n.length && cand.startsWith(n) && cand.length - n.length <= 4)) return name;
    if (n.startsWith(cand) && cand.length >= 2 && n.length - cand.length <= 2) return name;
  }
  return undefined;
}

const OPTION_RUN = /([A-H])\s*[\.、．）)]\s*([^A-H\n][^\n]*?)(?=\s+[A-H]\s*[\.、．）)]|\s*$)/g;
/** `1.` `1、` `(1)` `（1）` at line start */
const NUMBERED = /^\s*[（(]?\s*(\d{1,3})\s*[)）.、．]\s*(.*)$/;
/** `【答案】D` / `答案：D` / `[答案] D` */
const ANSWER_INLINE = /[【\[]\s*答案\s*[】\]]\s*[:：]?\s*([A-H](?:\s*[,，、]\s*[A-H])*)?([^\n【]*)/i;
/** trailing `故本题答案为 D` — the papers state it twice, use it as a cross-check */
const ANSWER_RESTATE = /答案为\s*([A-H])/g;

const squash = (s: string): string => s.replace(/[\s\u3000]/g, '');

/**
 * Split a paper into sections. A section is a heading that names a known part
 * (possibly with a 第X部分 / 一、 prefix); everything under it belongs to it.
 * Text before the first heading lands in section 0 with an empty title.
 */
export function splitSections(text: string): { title: string; index: number; lines: { t: string; n: number }[] }[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: { title: string; index: number; lines: { t: string; n: number }[] }[] = [];
  let cur: { title: string; lines: { t: string; n: number }[] } = { title: '', lines: [] };
  const emit = (): void => {
    // a heading with no questions under it (a part title followed at once by
    // its 题型 heading) is dropped: keeping it would shift every later index
    if (!cur.lines.length) return;
    out.push({ title: cur.title, index: out.length, lines: cur.lines });
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const title = sectionTitleOf(raw);
    if (title) {
      if (cur.title === title && !cur.lines.length) continue; // repeated heading
      emit();
      cur = { title, lines: [] };
      continue;
    }
    cur.lines.push({ t: raw, n: i + 1 });
  }
  emit();
  if (!out.length) out.push({ title: '', index: 0, lines: lines.map((t, i) => ({ t, n: i + 1 })) });
  return out;
}

/** parse the question paper (`…-学生版`) into numbered questions */
export function parseQuestionsDoc(text: string): RawQuestion[] {
  const out: RawQuestion[] = [];
  for (const sec of splitSections(text)) {
    let cur: RawQuestion | null = null;
    const close = (): void => {
      if (!cur) return;
      const stem = cur.stem.replace(/\s+/g, ' ').trim();
      if (stem) out.push({ ...cur, stem });
      cur = null;
    };
    for (const { t, n } of sec.lines) {
      const line = t.trim();
      if (!line) continue;
      const m = line.match(NUMBERED);
      if (m) {
        close();
        cur = { no: Number(m[1]), section: sec.title, sectionIndex: sec.index, stem: m[2] ?? '', options: [], line: n };
        // the options are often on the same line as the stem
        if (cur) collectOptions(cur, m[2] ?? '');
        continue;
      }
      if (!cur) continue; // instructions / headers above the first question
      const opt: RawQuestion = cur;
      const before = opt.options.length;
      collectOptions(opt, line);
      if (opt.options.length === before) {
        // only prose that is not an option continues the stem
        if (!opt.options.length) opt.stem += ' ' + line;
      }
    }
    close();
  }
  return out;
}

function collectOptions(q: RawQuestion, line: string): void {
  for (const m of line.matchAll(OPTION_RUN)) {
    const key = m[1].toUpperCase();
    const text = (m[2] ?? '')
      .trim()
      .replace(/[;；]\s*$/, '')
      // two-blank items print their words far apart: 「流光溢彩      巧夺天工」
      .replace(/[\s\u3000]{2,}/g, ' ');
    if (!text) continue;
    if (q.options.some((o) => o.key === key && o.text === text)) continue;
    q.options.push({ key, text });
  }
}

/** parse the answer paper (`…-答案版`) into numbered answers */
export function parseAnswersDoc(text: string): AnswerItem[] {
  const out: AnswerItem[] = [];
  for (const sec of splitSections(text)) {
    let cur: AnswerItem | null = null;
    let buf = '';
    const close = (): void => {
      if (!cur) return;
      const extra = squash(buf);
      if (!cur.letter) {
        const restate = [...buf.matchAll(ANSWER_RESTATE)].pop();
        if (restate) cur.letter = restate[1].toUpperCase();
      }
      if (!cur.letter && !cur.text && extra) cur.text = buf.trim();
      if (cur.letter || cur.text) out.push({ ...cur, explanation: cur.explanation?.trim() || undefined });
      cur = null;
      buf = '';
    };
    /** `1~5：BACDE` speed-check tables: expand in place, one row is one run */
    const expandRun = (line: string): boolean => {
      const m = line.match(/^\s*(\d{1,3})\s*[-—~～至]\s*(\d{1,3})\s*[:：]?\s*([A-H]{2,})\s*[.。]?$/i);
      if (!m) return false;
      const from = Number(m[1]);
      const to = Number(m[2]);
      const letters = m[3].toUpperCase().split('');
      if (to < from || letters.length !== to - from + 1) return false;
      close();
      letters.forEach((letter, i) =>
        out.push({ no: from + i, section: sec.title, sectionIndex: sec.index, letter }),
      );
      return true;
    };

    for (const { t } of sec.lines) {
      const line = t.trim();
      if (!line) continue;
      if (expandRun(line)) continue;
      const m = line.match(NUMBERED);
      if (m) {
        close();
        cur = { no: Number(m[1]), section: sec.title, sectionIndex: sec.index };
        readInto(cur, m[2] ?? '', (b) => (buf += ' ' + b));
        continue;
      }
      if (!cur) continue;
      readInto(cur, line, (b) => (buf += ' ' + b));
    }
    close();
  }
  // de-duplicate: a grouped table and a per-item block can both list #3
  const byKey = new Map<string, AnswerItem>();
  for (const a of out) {
    const k = `${a.sectionIndex}#${a.no}`;
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, a);
    else if (!prev.letter && a.letter) byKey.set(k, { ...prev, ...a });
  }
  return [...byKey.values()];
}

function readInto(item: AnswerItem, line: string, rest: (s: string) => void): void {
  const m = line.match(ANSWER_INLINE);
  if (m) {
    if (m[1]) item.letter = m[1].toUpperCase().replace(/[^A-H]/g, '')[0];
    const tail = (m[2] ?? '').trim();
    const exp = tail.replace(/^[。．.、\s]*(?:解析|解答|答题要点|答案解读)\s*[:：]?\s*/, '');
    if (exp) item.explanation = (item.explanation ?? '') + ' ' + exp;
    return;
  }
  const plain = line.match(/^(?:答案|答|【答案】)\s*[:：]?\s*([A-H])?\s*(.*)$/i);
  if (plain) {
    if (plain[1]) item.letter = plain[1].toUpperCase();
    const exp = plain[2] ?? '';
    if (exp.trim()) item.explanation = (item.explanation ?? '') + ' ' + exp;
    return;
  }
  rest(line);
}

export interface JoinReport {
  entries: BankEntry[];
  /** questions whose answer could not be attached (kept: they still make good recall material) */
  unanswered: number;
  /** section titles present in the answer paper that the question paper never used */
  mismatchedSections: string[];
}

/**
 * Attach answers to questions. Two rules keep a wrong answer from being
 * presented as a right one:
 *   • (section, number) must both match — a section the two papers disagree on
 *     contributes nothing;
 *   • a lettered answer must exist among that question's options, otherwise the
 *     pair is treated as unresolved (a shuffled or re-numbered paper).
 */
export function joinQuestionsAndAnswers(
  questions: RawQuestion[],
  answers: AnswerItem[],
  ref: string,
  tags: string[] = [],
): JoinReport {
  const byTitleNo = new Map<string, AnswerItem>();
  for (const a of answers) {
    const t = squash(a.section);
    if (t) byTitleNo.set(`${t}#${a.no}`, a);
  }
  const byKey = new Map<string, AnswerItem>();
  for (const a of answers) byKey.set(`${a.sectionIndex}#${a.no}`, a);
  // Section INDEX is only trustworthy when both papers list the same sections in
  // the same order; otherwise a dropped heading shifts every later answer onto
  // the wrong question (an English item answering with a maths key — wrong with
  // confidence, the one failure this join may not have).
  const qSections = [...new Set(questions.map((q) => q.sectionIndex))].sort((x, y) => x - y);
  const aSections = [...new Set(answers.map((a) => a.sectionIndex))].sort((x, y) => x - y);
  const titleOfQ = new Map<number, string>();
  for (const q of questions) if (q.section) titleOfQ.set(q.sectionIndex, squash(q.section));
  const titleOfA = new Map<number, string>();
  for (const a of answers) if (a.section) titleOfA.set(a.sectionIndex, squash(a.section));
  const indexAligned =
    qSections.length === aSections.length &&
    qSections.every((idx, i) => idx === aSections[i] && (titleOfQ.get(idx) ?? '') === (titleOfA.get(idx) ?? ''));
  // Some packs number continuously through the whole paper (no per-section
  // restart). When the numbers are unique on both sides, plain number join is
  // safer than section alignment, which can drift on a heading we missed.
  const dupQ = new Set<number>();
  const seenQ = new Set<number>();
  for (const q of questions) {
    if (seenQ.has(q.no)) dupQ.add(q.no);
    seenQ.add(q.no);
  }
  const dupA = new Set<number>();
  const seenA = new Set<number>();
  for (const a of answers) {
    if (seenA.has(a.no)) dupA.add(a.no);
    seenA.add(a.no);
  }
  const byNumber = new Map<number, AnswerItem>();
  if (!dupQ.size && !dupA.size) for (const a of answers) byNumber.set(a.no, a);

  const entries: BankEntry[] = [];
  const seenSections = new Set<string>();
  let unanswered = 0;
  for (const q of questions) {
    seenSections.add(squash(q.section));
    const a =
      byTitleNo.get(`${squash(q.section)}#${q.no}`) ??
      (indexAligned ? byKey.get(`${q.sectionIndex}#${q.no}`) : undefined) ??
      byNumber.get(q.no);
    const kind: BankEntry['kind'] = q.options.length >= 2 ? 'mc' : 'open';
    let answerKey: string | undefined;
    let answerText: string | undefined;
    if (a?.letter) {
      const opt = q.options.find((o) => o.key === a.letter);
      if (kind === 'mc' && !opt) {
        // the letter points at nothing on this paper — do not guess
        answerKey = undefined;
      } else {
        answerKey = a.letter;
        answerText = opt?.text;
      }
    } else if (a?.text) {
      answerText = a.text;
    } else if (a && !a.letter && !a.text && a.explanation) {
      answerText = a.explanation;
    }
    const answer = answerText ?? answerKey;
    if (!answer) unanswered++;
    entries.push({
      id: `${ref}#${entries.length}`,
      stem: q.stem,
      kind,
      options: q.options,
      answer: answer ?? '',
      answerKey,
      answerText,
      explanation: a?.explanation?.trim() || undefined,
      tags: [...tags, q.section].filter(Boolean),
      ref,
      line: q.line,
    });
  }
  const answerTitles = new Set(answers.map((a) => squash(a.section)).filter(Boolean));
  const mismatchedSections = [...answerTitles].filter((s) => !seenSections.has(s));
  return { entries, unanswered, mismatchedSections };
}

/** is this file the question paper, the answer paper, or self-contained? */
export function docRole(name: string, text: string): 'questions' | 'answers' | 'mixed' {
  if (/答案|解析版|详解|答案版/.test(name) && !/学生|试题|题目|卷子/.test(name)) return 'answers';
  const answerMarks = (text.match(/【答案】/g) ?? []).length;
  if (answerMarks >= 5) return 'answers';
  if (/学生版/.test(name)) return 'questions';
  return 'mixed';
}
