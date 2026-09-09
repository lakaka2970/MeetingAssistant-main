/**
 * Question-bank parsing (做题模式).
 *
 * The user keeps no bank yet, so the app must accept whatever they naturally
 * write: an Obsidian-style markdown note per topic, a plain-text list, or an
 * exported JSON/CSV. This module turns any of those into one flat entry shape
 * without inventing a format the user has to learn.
 *
 * Recognised prose grammar (all markers accept 全角/半角冒号, markdown bold,
 * blockquote/list prefixes and enumeration `1.` `1.1` `（2）` `三、`):
 *
 *   ## 下列哪一项不属于…？          题目：…  题干：…  【题】…  Q: …
 *   A. 选项一   B、选项二   C) 选项三   （D）选项四
 *   答案：B     【答案】B    正确答案：C    answer: B
 *   解析：…     【解析】…    思路：…       explanation: …
 *   标签：资损防范, 成本意识   #认知风格    [[行测-数量关系]]
 *
 * A block with ≥2 options becomes `mc`; without options it is an `open` entry —
 * and plain 「问：… 答：…」 notes are harvested through the prepared-answer
 * parser, so an interview note already works as a knowledge bank.
 *
 * Pure string logic — no fs, no electron, unit-testable.
 */
import { extractQaPairs } from './qaPairs';

export interface BankOption {
  /** display key as written (A/B/C/…), normalised to one letter */
  key: string;
  text: string;
}

export interface BankEntry {
  /** stable id: `<ref>#<ordinal>` — the caller may override the ref */
  id: string;
  /** the question stem, decorations removed */
  stem: string;
  kind: 'mc' | 'open';
  options: BankOption[];
  /** answer as written: for `mc` the option letter, for `open` the answer text */
  answer: string;
  /** resolved option letter for a multiple-choice entry */
  answerKey?: string;
  /** the option TEXT behind answerKey — what to read aloud, since the OA screen
   * may present the same options in a different order */
  answerText?: string;
  explanation?: string;
  tags: string[];
  /** file/label the entry came from */
  ref: string;
  /** 1-based line of the stem inside that file */
  line: number;
}

export interface BankParseResult {
  entries: BankEntry[];
  format: 'json' | 'csv' | 'text';
}

/** anything longer than this is a document, not a question stem */
const MAX_STEM = 600;
const MAX_ANSWER = 4000;

// ---------- line grammars ----------

/** decorations a marker line may wear: heading, quote, list bullet, bold, enumeration */
const Pfx = /^\s*(?:#{1,6}\s+)?(?:>\s*)?(?:[-*•]\s+)?\s*(?:\*\*|__|`)*\s*/;
const NUMBER =
  /^(?:[（(]?\d+(?:[._]\d+)*[)）]?|[一二三四五六七八九十]+)\s*[.、．]\s*/;
const Sfx = /\s*(?:\*\*|__|`)+\s*$/;

function stripLine(line: string): string {
  let out = line.replace(Pfx, '').replace(Sfx, '').trim();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(NUMBER, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 题目：/ 题干：/ 【题】/ Q: / 问题： — captures the stem body */
const STEM_MARKER =
  /^(?:【\s*(?:题\s*目|题|干|问题)\s*】|(?:题目|题干|问题|问|Q(?:uestion)?|题)[：:])\s*(.*)$/i;
/** 答案：/ 【答案】/ 正确答案：/ 参考答案：/ 答：/ answer: — a bare `A:` is NOT
 * an answer marker on purpose: in these files it is option A's text. */
const ANSWER_MARKER =
  /^(?:【\s*(?:答\s*案|答)\s*】|(?:正确答?案|参考答案|参照答案|答\s*案|答案|答|ans(?:wer)?)[：:])\s*(.*)$/i;
/** 解析：/ 【解析】/ 思路：/ 解法：/ 题解：/ explanation: */
const EXPLAIN_MARKER =
  /^(?:【\s*(?:解\s*析|过\s*程|思路)\s*】|(?:解析|题解|思路|解法|解释|说明|理由|explanation|solution|why)[：:])\s*(.*)$/i;
/** 标签：a,b,c */
const TAG_MARKER = /^(?:【\s*标\s*签\s*】|标签|分类|知识点|tag|tags|category)[：:]\s*(.*)$/i;
/** an option line: A. xxx / A、xxx / (A) xxx / - A: xxx */
const OPTION = /^[\s(（【]*([A-H甲乙丙丁戊己庚])[\s)）】、．.:：]\s*(.+)$/;
const HEADING = /^\s*#{1,6}\s+\S/;
const STEM_ENDING = /[?？]\s*$/;

/** strip obsidian/inline clutter a stem may carry: [[link]] → link, `#tag`, images */
function cleanStem(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => label || target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // an obsidian #tag is metadata, not part of the question (but leave C# etc.)
    .replace(/(^|\s)#+(?=[\p{Script=Han}])/gu, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn an answer body into (letter, option text). Banks write the same truth in
 * many hands: `B`, `（B）二`, `选 B`, `乙`, or the option text itself. Multi-select
 * keeps every letter so the caller can say "B、D".
 */
function resolveAnswer(
  answer: string,
  options: BankOption[],
): { key?: string; text?: string } {
  const s = answer.trim();
  if (!s) return {};
  const lettersOf = (run: string): string[] =>
    [...run].map((c) => normOptionKey(c)).filter((c) => /[A-H]/.test(c));
  const m = s.match(
    /^[（(【]?\s*(?:选|答案|应|正确的?)?\s*[:：]?\s*([A-Ha-h甲乙丙丁戊己庚](?:\s*[,，、和及或]\s*[A-Ha-h甲乙丙丁戊己庚])*|[A-Ha-h]{2,})\s*(?:[)）】]\s*(.*)|\s+(.*))?$/u,
  );
  if (m) {
    const keys = lettersOf(m[1] ?? '');
    if (keys.length) {
      const rest = cleanStem(m[2] ?? m[3] ?? '');
      const picked = keys
        .map((k) => options.find((o) => o.key === k))
        .filter((o): o is BankOption => !!o);
      if (picked.length) {
        return {
          key: picked.map((o) => o.key).join('、'),
          text: rest || picked.map((o) => o.text).join('；'),
        };
      }
      return { key: keys.join('、'), text: rest || undefined };
    }
  }
  // the answer was written as the option text (maybe with light decoration)
  const flat = (x: string): string => x.replace(/[\s，。.；;：:、]/g, '');
  const exact = options.find((o) => flat(o.text) === flat(s));
  if (exact) return { key: exact.key, text: exact.text };
  const inner = options.find((o) => o.text.length > 1 && flat(s).includes(flat(o.text)));
  if (inner) return { key: inner.key, text: inner.text };
  return { text: s };
}

/**
 * Read ONE captured screen question (题干 + 选项) — the exam path needs this to
 * re-anchor a bank answer onto the letters as the OA page shows them, since
 * those are shuffled per candidate. Deliberately forgiving: no stem marker is
 * required, only a ？-terminated first line or a plain first line.
 */
export function parseSingleQuestion(text: string): { stem: string; options: BankOption[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const options: BankOption[] = [];
  const stemParts: string[] = [];
  for (const line of lines) {
    const om = line.match(OPTION);
    if (om && om[2]) {
      const key = normOptionKey(om[1]);
      const t = cleanStem(om[2]);
      if (t && !options.some((o) => o.key === key)) options.push({ key, text: t });
      continue;
    }
    // an inline run: A. 甲   B. 乙   C. 丙
    for (const m of line.matchAll(new RegExp(OPTION.source, 'g'))) {
      if (!m[2]) continue;
      const key = normOptionKey(m[1]);
      const t = cleanStem(m[2]);
      if (t && !options.some((o) => o.key === key) && !stemParts.length) options.push({ key, text: t });
    }
    if (!options.length) stemParts.push(cleanStem(line));
  }
  const stem = stemParts.join(' ').replace(/\s+/g, ' ').trim().replace(/[?？]+$/, '');
  return { stem, options };
}

/** an accumulating question block (one per stem) */
interface Block {
  stem: string;
  line: number;
  options: BankOption[];
  answer: string;
  explanation: string;
  tags: string[];
  /** which field the plain lines after a marker belong to */
  target: 'stem' | 'answer' | 'explain';
}

/**
 * Split a multi-question markdown/plain-text document.
 *
 * A block opens on a stem signal (heading ending in ？, a 题目/题干/【题】/Q
 * marker, or a bare ？-ending line) and owns every line until the next block.
 * Inside a block, option lines collect, and 答案/解析/标签 markers switch the
 * accumulating target so an answer may span several lines.
 */
export function parseTextBank(text: string, ref: string): BankEntry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries: BankEntry[] = [];
  let cur: Block | null = null;

  // `close`/`newBlock` never assign `cur` — the loop body below owns it, so the
  // state machine (and TypeScript's view of it) stays readable
  const close = (b: Block | null): void => {
    if (!b) return;
    const entry = toEntry(b, ref, entries.length);
    if (entry) entries.push(entry);
  };
  const newBlock = (stem: string, line: number): Block => ({
    stem,
    line,
    options: [],
    answer: '',
    explanation: '',
    tags: [],
    target: 'stem',
  });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw.trim())) {
      // fenced code is part of the current block (a code answer, an example)
      if (cur && cur.target !== 'stem') cur[cur.target === 'answer' ? 'answer' : 'explanation'] += '\n' + raw;
      continue;
    }
    if (cur && cur.target !== 'stem' && /^\s{4,}\S/.test(raw)) {
      cur[cur.target === 'answer' ? 'answer' : 'explanation'] += '\n' + raw.replace(/^\s+/, '');
      continue;
    }
    const body = stripLine(raw);
    if (!body) continue;

    // fenced-code continuation handled above; markers first
    const tm = body.match(TAG_MARKER);
    if (tm) {
      if (cur) cur.tags.push(...splitTags(tm[1] ?? ''));
      continue;
    }
    const am = body.match(ANSWER_MARKER);
    if (am && cur) {
      cur.target = 'answer';
      cur.answer = cleanStem(am[1] ?? '');
      continue;
    }
    const em = body.match(EXPLAIN_MARKER);
    if (em && cur) {
      cur.target = 'explain';
      cur.explanation = cleanStem(em[1] ?? '');
      continue;
    }
    const sm = body.match(STEM_MARKER);
    if (sm) {
      close(cur);
      cur = newBlock(cleanStem(sm[1] ?? ''), i + 1); // an empty body continues on the next line
      continue;
    }
    if (!cur && !body) continue;
    // a bare ？-ending line (or a heading that asks something) opens a block
    if (STEM_ENDING.test(body) || (HEADING.test(raw) && !cur)) {
      close(cur);
      cur = newBlock(cleanStem(body), i + 1);
      continue;
    }
    if (!cur) continue; // prose before the first question
    const om = body.match(OPTION);
    if (om && om[2] && cur.options.length < 12 && !STEM_ENDING.test(om[2])) {
      cur.options.push({ key: normOptionKey(om[1]), text: cleanStem(om[2]) });
      continue;
    }
    if (cur.target === 'answer') cur.answer += (cur.answer ? '\n' : '') + cleanStem(body);
    else if (cur.target === 'explain') cur.explanation += (cur.explanation ? '\n' : '') + cleanStem(body);
    else if (!cur.stem) cur.stem = cleanStem(body);
    else if (cur.options.length === 0) cur.explanation += (cur.explanation ? '\n' : '') + cleanStem(body);
  }
  close(cur);
  return entries;
}

// ---------- answer-anchored documents ----------
//
// A generated PDF bank (北森 / 粉笔 exports) puts the answer INSIDE the flowed
// text: `…A:甲 B:乙 C:丙 D:丁 正确答案:D 解析: …`, with hard line wraps
// anywhere. Line-anchored markers see none of that, so such a file yields a
// handful of entries out of hundreds of questions. Here the reliable signal is
// the answer itself, so the answer is the anchor: every `正确答案:X` cuts a
// record, and the question is what lies between the previous record and it.

/** `正确答案：D` / `答案: A、C` / `参考答案：乙` — mid-line is fine, that is the point */
const INLINE_ANSWER =
  /(?:^|[\s(（【\u3000])(?:本题|上面|下列)?\s*(?:正确答案|标准答案|参考答案|参照答案|答\s*案|答)\s*[::]\s*(?:应?选|为|是|只有)?\s*([A-Ha-h甲乙丙丁戊己庚](?:\s*[,，、;；]\s*[A-Ha-h甲乙丙丁]|[A-Ha-h甲乙丙丁])*|正确|错误|对|错|√|×|是|否|真|假)(?![A-Za-z])/g;
/** the explanation that may follow an answer on the same line */
const INLINE_EXPLAIN = /^[ \t\n\u3000]*(?:本题|下面|该|此)?[ \t\n\u3000]*(?:答案\s*解析|解析|分\s*析|解释|说\s*明|思\s*路|点\s*拨|解题(?:思路|分析|说明|技巧)?)[ \t\n\u3000]*[::][ \t\n\u3000]*/;
/** a line that begins a numbered question (`12 xxx`, `12. xxx`, `（12）xxx`);
 * a Chinese PDF pads with U+3000, which `\s` in JavaScript does NOT match */
const INLINE_NUMBER = /(?:^|\n)[ \t\u3000]*[（(]?(\d{1,4})[)）]?[ \t\u3000．.、)）]+(?=\S)/g;
/** a line holding NOTHING but a number — how a generated PDF puts `2` between
 * the previous 解析 and its own question. Page numbers look identical, which is
 * why the caller takes the last one before each answer rather than the first. */
const INLINE_BARE_NUMBER = /^[ \t\u3000]*(\d{1,4})[ \t\u3000]*$/gm;
/** an option written inline: `A:` `A．` `（A）` `A、` */
const INLINE_OPTION = /(?:^|[\s(（【\u3000])([A-H])[ \t\u3000)*）】]*[::．.、][ \t\u3000]*/g;
/** an explanation that belongs to the PREVIOUS question and is still sitting at
 * the head of this chunk — the flow is `[上一题解析][题号 题干][选项][正确答案]` */
const INLINE_PREV_EXPLAIN =
  /(?:^|[\s(（【\u3000])(?:本题|下面|该|此)?\s*(?:答案\s*解析|解析|分\s*析|解释|说\s*明|思\s*路|点\s*拨|解题(?:思路|分析|说明|技巧)?)\s*[::]/g;
/** how a 行测 explanation signs off: `因此，选择 D 选项。` / `故本题答案为 C。` */
const INLINE_EXPLAIN_END =
  /(?:因此|故|所以|综上(?:所述)?|可见)[^。\n]{0,40}?(?:选择|答案为|正确答案为|答案选|本题答案为|应选|选)[：:]?\s*[A-H][^。\n]{0,14}[。！]/g;
/** the per-option walk-through that follows it: `要点:A 项:…偏离重点。B 项:…无中生有。` */
const INLINE_EXPLAIN_TAIL =
  /(?:要点|解析|总结|考点|答题|技巧)[：:][\s\S]{0,500}?(?:偏离重点|无中生有|表述(?:错误|正确|不当|有误)|不符合|与文段(?:不符|一致)|排除)/g;

function answerLetters(run: string): string {
  return [...run]
    .map((c) => c.toUpperCase())
    .filter((c) => /[A-H]/.test(c))
    .join('、');
}

/** split a flowed question into stem + options; options must start at A and climb */
function splitInlineOptions(chunk: string): { stem: string; options: BankOption[] } {
  const marks: { key: string; start: number; body: number }[] = [];
  const re = new RegExp(INLINE_OPTION.source, 'g');
  for (const m of chunk.matchAll(re)) {
    const key = m[1];
    marks.push({ key, start: m.index, body: m.index + m[0].length });
  }
  const run: typeof marks = [];
  let expect = 'A'.charCodeAt(0);
  for (const m of marks) {
    if (m.key.charCodeAt(0) === expect) {
      run.push(m);
      expect++;
    } else if (run.length >= 2 && m.key.charCodeAt(0) === 'A'.charCodeAt(0)) {
      run.length = 0; // a second A means the first run was prose
      expect = 'A'.charCodeAt(0) + 1;
      run.push(m);
    }
  }
  if (run.length < 2) return { stem: chunk.trim(), options: [] };
  const options: BankOption[] = [];
  for (let i = 0; i < run.length; i++) {
    const body = chunk.slice(run[i].body, run[i + 1]?.start ?? chunk.length);
    const t = cleanStem(body);
    if (t) options.push({ key: run[i].key, text: t });
  }
  if (options.length < 2) return { stem: chunk.trim(), options: [] };
  return { stem: chunk.slice(0, run[0].start).trim(), options };
}

/** page furniture a generated PDF leaves in the text stream */
function stripFlowNoise(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*(?:[·․。]{4,}|P\d+[-–]\d+|\d+\s*\/\s*\d+)\s*/g, ' ')
    .trim();
}

/**
 * Parse a document whose answers are inline. Deliberately conservative: it
 * returns nothing unless the file reads like a flowed answer-key dump, so a
 * hand-written note never gets re-cut by it.
 */
export function parseInlineAnswerBank(text: string, ref: string): BankEntry[] {
  const src = text.replace(/\r\n?/g, '\n');
  const answers = [...src.matchAll(new RegExp(INLINE_ANSWER.source, 'g'))];
  // No size floor here: a five-question PDF is still an answer-anchored file, and
  // `parseBankFile` already refuses to let this parser win unless it reads
  // strictly more of the document than the line-anchored one.
  if (answers.length < 3) return [];
  // `start` is where the question begins (after its number); `head` is where the
  // number itself sits — the previous question's 解析 ends there, not here.
  const numbers = [
    ...[...src.matchAll(new RegExp(INLINE_NUMBER.source, 'g'))].map((m) => {
      const head = m.index + (m[0].length - m[0].trimStart().length);
      return { head, start: head, n: Number(m[1]) };
    }),
    ...[...src.matchAll(new RegExp(INLINE_BARE_NUMBER.source, 'gm'))].map((m) => ({
      head: m.index,
      start: m.index + m[0].length,
      n: Number(m[1]),
    })),
  ].sort((a, b) => a.head - b.head);
  const entries: BankEntry[] = [];
  let lastN = 0;
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    const after = answers[i - 1] ? answers[i - 1].index + answers[i - 1][0].length : 0;
    // The question starts at its number. Page furniture numbers identically, so
    // the sequence decides: the candidate that continues `lastN` is the real one,
    // and only when none does do we fall back to the last number in the window.
    let start = after;
    let picked: (typeof numbers)[number] | undefined;
    let fallback: (typeof numbers)[number] | undefined;
    for (const cand of numbers) {
      if (cand.head >= a.index) break;
      if (cand.start < after) continue;
      fallback = cand;
      if (cand.n === lastN + 1 || (lastN === 0 && cand.n <= 3)) picked = cand;
    }
    const chosen = picked ?? fallback;
    if (chosen) {
      start = chosen.start;
      lastN = chosen.n;
    }
    // Everything before this question is the previous question's 解析 — the
    // marker alone is not the boundary, its body runs on for several lines.
    // 行测 explanations end in a recognisable way (`因此，选择 D 选项。`, and the
    // `要点:A 项…偏离重点。` walk-through that follows it), so cut after the last
    // such ending in the window; the number line already handled most records.
    let region = src.slice(start, a.index);
    const pe = new RegExp(INLINE_PREV_EXPLAIN.source).exec(region);
    if (pe && pe.index + pe[0].length < region.length * 0.6) region = region.slice(pe.index + pe[0].length);
    for (const re of [INLINE_EXPLAIN_END, INLINE_EXPLAIN_TAIL]) {
      let last: RegExpExecArray | null = null;
      for (const m of region.matchAll(new RegExp(re.source, 'g'))) last = m;
      if (last && last.index + last[0].length < region.length * 0.75) {
        region = region.slice(last.index + last[0].length);
      }
    }
    const chunk = stripFlowNoise(region);
    const { stem, options } = splitInlineOptions(chunk);
    const key = answerLetters(a[1] ?? '');
    const word = (a[1] ?? '').trim();
    if (!stem || (!key && !word)) continue;
    // the explanation runs until the next question starts
    const next = answers[i + 1];
    let explEnd = next ? next.index : src.length;
    if (next) {
      for (const cand of numbers) {
        if (cand.head >= explEnd) break;
        if (cand.head > a.index + a[0].length) explEnd = cand.head;
      }
    }
    let tail = src.slice(a.index + a[0].length, explEnd);
    const em = tail.match(INLINE_EXPLAIN);
    if (em) tail = tail.slice(em[0].length);
    tail = stripFlowNoise(tail);
    const block: Block = {
      stem: cleanStem(stem.replace(INLINE_NUMBER, ' ').replace(/[?？]\s*$/, '')),
      line: src.slice(0, start).split('\n').length,
      options,
      // a 判断题 is answered 对/错/√/× in the key, not with a letter: keep the
      // written word so resolveAnswer can anchor it onto the options when there
      // are any ("A:正确 B:错误") and the entry is still usable when there are not
      answer: key || word,
      explanation: tail.slice(0, MAX_ANSWER),
      tags: [],
      target: 'answer',
    };
    const entry = toEntry(block, ref, entries.length);
    if (entry) entries.push(entry);
  }
  return entries;
}

function toEntry(block: Block, ref: string, ordinal: number): BankEntry | null {
  const stem = cleanStem(block.stem).replace(/[?？]\s*$/, '').trim();
  if (!stem || stem.length > MAX_STEM) return null;
  const options = block.options.filter((o) => o.text);
  const kind: BankEntry['kind'] = options.length >= 2 ? 'mc' : 'open';
  let answer = cleanStem(block.answer);
  let answerKey: string | undefined;
  let answerText: string | undefined;

  if (kind === 'mc') {
    const resolved = resolveAnswer(answer, options);
    answerKey = resolved.key;
    answerText = resolved.text;
    if (!answerKey && !answerText) return null; // an MC entry we cannot answer is useless
  } else if (!answer) {
    // an intro/section heading followed by prose is not a question — never store
    // an entry that has nothing to answer with
    return null;
  }
  if (answer.length > MAX_ANSWER) answer = answer.slice(0, MAX_ANSWER) + '…';
  const explanation = cleanStem(block.explanation).slice(0, MAX_ANSWER);
  return {
    id: `${ref}#${ordinal}`,
    stem,
    kind,
    options,
    answer: answerText || answer,
    answerKey,
    answerText,
    explanation: explanation || undefined,
    tags: [...new Set(block.tags)],
    ref,
    line: block.line,
  };
}

function normOptionKey(raw: string): string {
  const map: Record<string, string> = { 甲: 'A', 乙: 'B', 丙: 'C', 丁: 'D', 戊: 'E', 己: 'F', 庚: 'G' };
  const u = raw.toUpperCase();
  return map[raw] ?? (/[A-H]/.test(u) ? u.replace(/[^A-H]/g, '')[0] : 'A');
}

function splitTags(s: string): string[] {
  return s
    .replace(/[[#】]/g, ' ')
    .split(/[,，、;；\s|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 24);
}

// ---------- structured banks ----------

const ALIAS: Record<string, string[]> = {
  stem: ['stem', 'question', 'title', '题干', '题目', '问题', 'content'],
  options: ['options', 'choices', '选项', 'answers'],
  answer: ['answer', 'ans', 'correct', 'key', '答案', '正确答案', '参考答案'],
  explanation: ['explanation', 'analysis', 'solution', 'reason', '解析', '题解', '思路', '解释'],
  tags: ['tags', 'tag', 'category', 'labels', '标签', '分类', '知识点'],
};

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function asOptions(v: unknown): BankOption[] {
  if (Array.isArray(v)) {
    return v.map((item, i) => {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const key = String(o.key ?? o.letter ?? String.fromCharCode(65 + i));
        const text = String(o.text ?? o.value ?? o.content ?? '');
        return { key: normOptionKey(key), text: text.trim() };
      }
      return { key: String.fromCharCode(65 + i), text: String(item).trim() };
    });
  }
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([k, t]) => ({
      key: normOptionKey(k),
      text: String(t).trim(),
    }));
  }
  return [];
}

/**
 * JSON bank: an array of entries, or `{questions:[…]}` / `{data:[…]}`.
 * Field names are matched through ALIAS so an export from any tool works.
 */
export function parseJsonBank(json: string, ref: string): BankEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.questions)
      ? ((data as Record<string, unknown>).questions as unknown[])
      : Array.isArray((data as Record<string, unknown>)?.data)
        ? ((data as Record<string, unknown>).data as unknown[])
        : [];
  const entries: BankEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const block = {
      stem: String(pick(o, ALIAS.stem) ?? '').trim(),
      line: 0,
      options: asOptions(pick(o, ALIAS.options)),
      answer: String(pick(o, ALIAS.answer) ?? '').trim(),
      explanation: String(pick(o, ALIAS.explanation) ?? '').trim(),
      tags: Array.isArray(pick(o, ALIAS.tags))
        ? (pick(o, ALIAS.tags) as unknown[]).map(String)
        : splitTags(String(pick(o, ALIAS.tags) ?? '')),
      target: 'answer' as const,
    };
    const e = toEntry(block, ref, entries.length);
    if (e) entries.push(e);
  }
  return entries;
}

/** CSV/TSV bank with a header row (same aliases as JSON); quoted cells OK. */
export function parseCsvBank(csv: string, ref: string): BankEntry[] {
  const rows = splitCsv(csv);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (keys: string[]): number =>
    header.findIndex((h) => keys.some((k) => h === k || h.startsWith(k)));
  const iStem = col(ALIAS.stem);
  const iAnswer = col(ALIAS.answer);
  if (iStem < 0) return [];
  const iOpt = col(ALIAS.options);
  const iExp = col(ALIAS.explanation);
  const iTags = col(ALIAS.tags);
  const entries: BankEntry[] = [];
  for (const r of rows.slice(1)) {
    const options = iOpt >= 0 ? asOptions(r[iOpt]?.split(/[|｜;；]/).map((s) => s.trim()).filter(Boolean)) : [];
    const block = {
      stem: (r[iStem] ?? '').trim(),
      line: 0,
      options,
      answer: (iAnswer >= 0 ? r[iAnswer] ?? '' : '').trim(),
      explanation: (iExp >= 0 ? r[iExp] ?? '' : '').trim(),
      tags: splitTags(iTags >= 0 ? r[iTags] ?? '' : ''),
      target: 'answer' as const,
    };
    const e = toEntry(block, ref, entries.length);
    if (e) entries.push(e);
  }
  return entries;
}

/** minimal RFC-4180 split (quotes, escaped quotes, CRLF) — enough for exports */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * One entry point for a whole file. A `.json`/`.csv` payload that fails to
 * parse falls back to the text grammar rather than losing the file.
 */
export function parseBankFile(name: string, text: string): BankParseResult {
  const ref = name;
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) {
    const entries = parseJsonBank(text, ref);
    if (entries.length) return { entries, format: 'json' };
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    const entries = parseCsvBank(text, ref);
    if (entries.length) return { entries, format: 'csv' };
  }
  const prose = parseTextBank(text, ref);
  // A flowed answer-key dump beats the line-anchored reader only when it clearly
  // reads more of the file; a hand-written note never gets re-cut by it.
  const inline = parseInlineAnswerBank(text, ref);
  // whichever reader recovers more of the document wins; the line-anchored one
  // stays in charge for anything it already reads well
  const entries = inline.length > prose.length * 1.25 ? inline : prose;
  // 问:/答: notes are prepared answers, and a knowledge-question bank written
  // that way must work too — merge in whatever the text grammar did not
  // already answer (an entry with an empty answer is replaced, not kept).
  // Both parsers must agree on the key, so a leading 题目:/问题: marker is
  // stripped from either side before comparing.
  const stemKey = (s: string): string =>
    s
      .replace(/^\s*(?:题目|题干|问题|问|题|Q(?:uestion)?)\s*[:：]\s*/i, '')
      .replace(/\s/g, '');
  const byStem = new Map<string, BankEntry>();
  for (const e of entries) byStem.set(stemKey(e.stem), e);
  let merged = 0;
  for (const p of extractQaPairs(text)) {
    const key = stemKey(p.question);
    const existing = byStem.get(key);
    if (existing && existing.answer) continue;
    byStem.set(
      key,
      existing
        ? { ...existing, answer: p.answer, explanation: existing.explanation ?? undefined }
        : {
            id: `${ref}#${entries.length + merged}`,
            stem: p.question,
            kind: 'open',
            options: [],
            answer: p.answer,
            tags: [],
            ref,
            line: p.line,
          },
    );
    merged++;
  }
  const flat = [...byStem.values()].sort((a, b) => a.line - b.line);
  const out = flat.map((e, i) => ({ ...e, id: `${ref}#${i}` }));
  return { entries: out, format: 'text' };
}
