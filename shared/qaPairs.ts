/**
 * Prepared Q&A extraction from knowledge-base text (interview prep notes,
 * resume addenda, project docs).
 *
 * The user pre-answers likely interview questions in the knowledge base. Those
 * answers must be surfaced VERBATIM on a retrieval hit (instant, trustworthy,
 * zero LLM latency) with the AI answer only enriching them — so the pairs have
 * to be recognised first, from whatever style the notes happen to use. This
 * module auto-detects the common writings without inventing a format:
 *
 *   问：问题 / 答：回答            【问题】…【回答】…
 *   Q: / Q1: / Question 2: …      **Q:** … **A:** …（加粗/引用前缀均可）
 *   ## 什么是 X？                 1.线性池了解吗？ 1.1 为什么 FastAPI？
 *   ### Q：介绍 js 的基本数据类型？（标题即问题，正文即答案）
 *   | 高频考点 | 一句话要点 |      | 追问 | 应答要点 |   | 问题 | 简要答案 |
 *
 * A pair is kept only when both sides exist; a bare question line with no
 * following body never becomes a pair, and prose questions that are not
 * question-like (no marker, no 问号/疑问词) are never harvested. Comparison
 * tables (`特性 | Kafka | RabbitMQ`, `并发问题 | 说明 | 示例`) are NOT Q&A: the
 * question and answer columns must be named explicitly.
 *
 * Pure string logic — no fs, no electron — so the parsing rules are unit-test
 * covered in isolation.
 */

export interface QaPair {
  /** the question, decorations removed */
  question: string;
  /** the prepared answer, verbatim (markdown intact) */
  answer: string;
  /** 1-based line of the question marker in the source text */
  line: number;
  /** how it was recognised: 问/Q marker, bare question line, or table row */
  via: 'marker' | 'question' | 'table';
}

/** safety caps — a "question" longer than this is prose, not a lookup key */
const MAX_QUESTION = 200;
/** answers can be long; this only guards against swallowing a whole document */
const MAX_ANSWER = 20_000;
/** a bare question LINE (prose) needs a real body before it counts as prep */
const MIN_QUESTION_VIA_ANSWER = 40;
/** table cells are terse: a shorter answer still counts, a dash does not */
const MIN_TABLE_ANSWER = 8;
/** two characters is a real topic in Chinese notes (闭包 / 事务 / 索引) */
const MIN_TABLE_QUESTION = 2;

// ---------- marker detection ----------

/**
 * Leading enumeration, as written in real prep notes: `1.`（可无空格）、`1.1`、
 * `（3）`、`三、`。A bare number followed by a space is deliberately NOT
 * stripped, so "2024 年发生了什么" keeps its year.
 */
const NUMBERING =
  /^\s*(?:[（(]\s*\d+(?:[._]\d+)*\s*[)）]|[一二三四五六七八九十]+[.、．]|\d+(?:[._]\d+)+[.、．]?|\d+[.、．])\s*/;
/** line decorations: heading, blockquote, list bullet, emphasis */
const DECORATION = /^\s*(?:#{1,6}\s+)?(?:>\s*)?(?:[-*•]\s+)?\s*(?:\*\*|__|`)*\s*/;
const TRAILING_DECORATION = /\s*(?:\*\*|__|`)+\s*$/;

function stripDecoration(line: string): string {
  let out = line.replace(DECORATION, '').replace(TRAILING_DECORATION, '').trim();
  // the enumeration is not part of the question; peel `1.` / `1.1` chains
  for (let i = 0; i < 4; i++) {
    const next = out.replace(NUMBERING, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * A marker body can still carry emphasis that sat INSIDE the decoration, e.g.
 * `**Q:** 问题` → after the line decoration is gone the body is `** 问题`.
 * Markers are stripped from questions and from the first line of an answer;
 * the rest of an answer keeps its markdown (the UI renders it).
 */
function cleanCaptured(s: string): string {
  return s.replace(/^(?:\*\*|__|`)+\s*/, '').replace(/\s*(?:\*\*|__|`)+$/, '').trim();
}

/** 问： / 问题： / Q: / Q1： / Question 2: / 题目：/ 题干： / 【问题】 — captures the body.
 * 题目/题干 are included because a question bank writes them that way, and the
 * two parsers must agree on where a question starts or a merged bank double-lists it. */
const Q_MARKER =
  /^(?:【\s*(?:问\s*题|题\s*目|题\s*干|问)\s*】|(?:Q(?:uestion)?|问\s*题|题\s*目|题\s*干|问)\s*\d*\s*[：:])\s*(.*)$/i;
/** 答： / 回答： / 答案： / A: / A2： / Answer： / 【回答】 / 【答案】 */
const A_MARKER =
  /^(?:【\s*(?:回\s*答|答\s*案|答)\s*】|(?:A(?:nswer)?|回\s*答|答\s*案|答)\s*\d*\s*[：:])\s*(.*)$/i;

/** a question without any marker: ends in ？/? or is a heading asking something */
const QUESTION_ENDING = /[?？]\s*$/;
const QUESTION_HEAD =
  /^(?:请?[问讲讲说介描比总析列]|什么|哪些|哪个|怎样|怎么|如|为(?:什么|何)|是否|能否|有没有|是不是|有何|What|Why|How|Which|Who|When|Where|Explain|Describe|Compare|List|Tell|Talk)/i;

function isQuestionLine(stripped: string, wasHeading: boolean): boolean {
  if (!stripped || stripped.length > MAX_QUESTION) return false;
  if (QUESTION_ENDING.test(stripped)) return true;
  // a section heading that reads like a topic prompt ("## 为什么选择 Kafka")
  return wasHeading && QUESTION_HEAD.test(stripped);
}

// ---------- Q&A tables ----------

/**
 * Question/answer column names actually used in interview-note tables. Both are
 * anchored to the whole header cell, so `并发问题` or `特性` never qualify and a
 * comparison table is never mistaken for prepared answers.
 */
const TQ_HEADER =
  /^[\s#*｜|]*(?:高频考点|核心考点|考点|问题|提问|常见问题|常问问题|面试题|面试问题|题目|追问|反问|Q(?:uestion)?|Question)[\s?？:：*#]*$/i;
const TA_HEADER =
  /^[\s#*｜|]*(?:一句话答案|一句话要点|一句话结论|简要答案|简要回答|回答要点|应答要点|核心要点|标准答案|参考答案|答案|回答|要点|结论|A(?:nswer)?|Solution|Answer)[\s?？:：*#]*$/i;

/** markdown table separator row: `|---|:--:|` */
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** split a table row into trimmed cells, honouring `\|` escapes */
function splitRow(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith('|')) return [];
  const inner = t.replace(/^\|/, '').replace(/\|\s*$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '|') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

/**
 * A cell/heading that only echoes a section label is not a question. The list
 * also stops a bare 「## 问题」 heading from harvesting everything under it.
 */
const HEADER_ECHO =
  /^(?:问题|提问|考点|高频考点|核心考点|追问|反问|题目|答案|回答|要点|结论|说明|详情|备注|示例|维度|特性|对比|概述|背景|总结|Q|A)$/i;

/**
 * Final form of a question, whatever grammar found it: markdown links collapse
 * to their label (a note writing `[Flash Attention](https://…)` asks about
 * Flash Attention), a trailing `（高频考点）` annotation is metadata rather than
 * question text, and a bare header word yields nothing at all.
 */
function cleanQuestion(s: string): string {
  const out = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s*[【（(]\s*(?:高频|核心)?考\s*点\s*[】）)]\s*$/, '')
    .replace(/[?？]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return HEADER_ECHO.test(out) ? '' : out;
}

/** strip the decoration a cell can carry (`**题**`, `` `code` ``, trailing ？) */
function cellText(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?？]+$/, '')
    .trim();
}

interface TableScan {
  pairs: QaPair[];
  /** 0-based line indices the tables consumed, so the line scanner skips them */
  used: Set<number>;
}

/**
 * Harvest Q&A tables: a header row naming a question column and an answer
 * column, then one pair per data row. Anything that is not a two-column-shaped
 * table (no question col, no answer col, cols the wrong way round with nothing
 * after) is left alone and stays ordinary recall material.
 */
export function extractTableQa(lines: string[]): TableScan {
  const pairs: QaPair[] = [];
  const used = new Set<number>();
  for (let i = 0; i + 2 < lines.length; i++) {
    const header = splitRow(lines[i]);
    if (header.length < 2 || !TABLE_SEP.test(lines[i + 1])) continue;
    const qi = header.findIndex((c) => TQ_HEADER.test(c.trim()));
    if (qi < 0) continue;
    let ai = -1;
    for (let c = qi + 1; c < header.length; c++) {
      if (TA_HEADER.test(header[c].trim())) {
        ai = c;
        break;
      }
    }
    if (ai < 0) continue; // no answer column after the question column

    let row = i + 2;
    for (; row < lines.length; row++) {
      if (!/^\s*\|/.test(lines[row])) break;
      used.add(row);
      const cells = splitRow(lines[row]);
      if (cells.length <= ai) continue;
      const question = cleanQuestion(cellText(cells[qi] ?? ''));
      const answer = cellText(cells[ai] ?? '');
      if (question.length < MIN_TABLE_QUESTION || answer.length < MIN_TABLE_ANSWER) continue;
      if (question.length > MAX_QUESTION || answer.length > MAX_ANSWER) continue;
      pairs.push({ question, answer, line: row + 1, via: 'table' });
    }
    // the header + separator belong to this table too
    used.add(i);
    used.add(i + 1);
    i = row - 1;
  }
  return { pairs, used };
}

// ---------- the scanner ----------

interface Open {
  qParts: string[];
  aParts: string[];
  line: number;
  via: 'marker' | 'question';
  /** true while a marker-Q still has no body and no A: has been seen */
  awaitingQ: boolean;
  /**
   * Deliberate structure (a `问:`/`Q:` marker, or a `## …？` HEADING) is the
   * author labelling a question, so any answer body qualifies. A bare
   * question-mark LINE inside running prose is not — it needs a real body
   * before it can be treated as a prepared answer.
   */
  strong: boolean;
}

/**
 * Extract prepared Q&A pairs, in document order. Overlapping styles are fine —
 * the first marker of a pair wins, and an A: that appears mid-answer just
 * continues the answer body.
 */
export function extractQaPairs(text: string): QaPair[] {
  const pairs: QaPair[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Q&A tables are claimed first: their rows are pairs, and the line scanner
  // must not also harvest a table row as a loose question
  const tables = extractTableQa(lines);
  let open: Open | null = null;
  let inFence = false;

  // helpers never assign `open` — the scanner keeps that in one place so the
  // state machine (and TypeScript's view of it) stays readable
  const close = (o: Open | null): void => {
    const p = o ? toPair(o) : null;
    if (p) pairs.push(p);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // a Q&A table row is its own pair; it also ends any open prose answer
    if (tables.used.has(i)) {
      close(open);
      open = null;
      continue;
    }

    // fenced code belongs to the answer body (coding prep is the main use case)
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      if (open && !open.awaitingQ) open.aParts.push(raw);
      continue;
    }
    if (inFence) {
      if (open && !open.awaitingQ) open.aParts.push(raw);
      continue;
    }

    const body = stripDecoration(raw);
    const wasHeading = /^\s*#{1,6}\s/.test(raw);

    // a horizontal rule is the author's "end of block" — it closes the answer
    // so trailing prose of a section never rides along into the next hit
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      close(open);
      open = null;
      continue;
    }

    const qm = body.match(Q_MARKER);
    const am = !qm ? body.match(A_MARKER) : null;

    if (qm) {
      close(open);
      const rest = cleanCaptured(qm[1]);
      open = {
        qParts: rest ? [rest] : [],
        aParts: [],
        line: i + 1,
        via: 'marker',
        awaitingQ: !rest,
        strong: true,
      };
      continue;
    }
    if (am && open) {
      const rest = cleanCaptured(am[1]);
      // an explicit 答： is strong evidence the block is a prepared Q&A, even
      // when the question line itself carried no marker
      open.via = 'marker';
      open.strong = true;
      open.awaitingQ = false;
      if (rest) open.aParts.push(rest);
      continue;
    }
    if (am && !open) continue; // orphan 答: — nothing to attach it to

    if (isQuestionLine(body, wasHeading)) {
      // `**Q:**` on its own line, question on the next: that line IS the body
      if (open && open.awaitingQ) {
        open.qParts.push(body);
        open.awaitingQ = false;
        continue;
      }
      close(open);
      open = {
        qParts: [body],
        aParts: [],
        line: i + 1,
        via: 'question',
        awaitingQ: false,
        strong: wasHeading,
      };
      continue;
    }

    if (!open) continue;
    if (!trimmed) {
      // a blank while the question is still forming closes nothing; a blank
      // inside the answer is kept only once real content has started
      if (!open.awaitingQ && open.aParts.some((l) => l.trim())) open.aParts.push('');
      continue;
    }
    if (open.awaitingQ) open.qParts.push(body);
    else open.aParts.push(raw.replace(/^\s+/, ''));
  }
  close(open);
  return dedupe([...tables.pairs, ...pairs].sort((a, b) => a.line - b.line));
}

/** a finished block -> a pair, or null when it is not a real prepared answer */
function toPair(open: Open): QaPair | null {
  // one cleanup path for every grammar: decorations, links and annotations are
  // gone, and a section label («问题») never becomes a question at all
  const question = cleanQuestion(open.qParts.join('\n').trim());
  const answer = open.aParts.join('\n').trim();
  const ok =
    question.length > 0 &&
    question.length <= MAX_QUESTION &&
    answer.length > 0 &&
    answer.length <= MAX_ANSWER &&
    (open.strong || answer.length >= MIN_QUESTION_VIA_ANSWER);
  return ok ? { question, answer, line: open.line, via: open.via } : null;
}

/** same question twice in one document → keep the first */
function dedupe(pairs: QaPair[]): QaPair[] {
  const seen = new Set<string>();
  const out: QaPair[] = [];
  for (const p of pairs) {
    const key = normalizeQuestion(p.question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ---------- matching helpers (shared by ingest and retrieval) ----------

/**
 * A lookup key for a question: lowercase, markdown/punctuation gone, ALL
 * whitespace dropped (CJK spacing is noise; bigrams then line up for Chinese
 * and English alike).
 */
export function normalizeQuestion(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_>#【】\[\]()（）]/g, ' ')
    .replace(/[\s，。、；：“”‘’！？!.,;:'"“”～~\-—–?？]+/g, '')
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length <= 1) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * Lexical similarity in [0,1] between two questions — character-bigram Jaccard,
 * which behaves for Chinese (no word boundaries) and English alike. Used as a
 * cheap gate/booster next to the embedding cosine: it is what turns a literally
 * identical question into a guaranteed direct hit without any model call.
 */
export function questionSimilarity(a: string, b: string): number {
  const x = normalizeQuestion(a);
  const y = normalizeQuestion(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ba = bigrams(x);
  const bb = bigrams(y);
  if (!ba.size || !bb.size) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return inter / (ba.size + bb.size - inter);
}

/** how a pair is stored in the vector index so re-indexing re-embeds it as-is */
export function formatQaRecord(question: string, answer: string): string {
  return `问：${question}\n\n答：${answer}`;
}

/** the record text back into its parts (metadata usually carries them already) */
export function parseQaRecord(text: string): { question: string; answer: string } {
  const m = text.match(/^问：([\s\S]*?)\n\n答：([\s\S]*)$/);
  if (m) return { question: m[1].trim(), answer: m[2].trim() };
  return { question: text, answer: text };
}
