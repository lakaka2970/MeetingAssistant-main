/**
 * Local, extractive section analysis for imported documents (v1.0.1 ③).
 *
 * Why summaries at all: retrieval runs over ~300-char chunks, so a question
 * that spans a whole deck ("这套方案的评测方法是什么") matches a handful of
 * disconnected lines and never the document's shape. One short record per
 * section gives the index a node that answers at document level.
 *
 * Why extractive and not LLM-written: the analysis has to run on every import,
 * offline, at zero API cost, and it must never state a figure the document
 * does not contain. A heading path plus the section's first sentence satisfies
 * all three; the summary is a locator, and retrieval still caps how many of
 * them may appear so they cannot crowd the source text out.
 */
import type { RagRecord } from './vector-store';

/** a document contributes at most this many section records */
export const MAX_SUMMARY_SECTIONS = 40;
/** … and at most this many of them may appear in one retrieval result */
export const SUMMARIES_PER_RETRIEVAL = 2;
/** a summary is a pointer: keep it well under one chunk */
export const MAX_SUMMARY_CHARS = 160;
/** heading-free documents (docx / pdf text) are grouped into sections this big */
export const SECTION_GROUP_CHARS = 600;
/** `deck.pptx` + section 3 → `deck.pptx#s3`: the ref a citation points at */
export const SECTION_REF_SEP = '#s';

const HEADING = /^(#{1,6})\s+(.*)$/;
/** sentence enders that do not need a following space (CJK + ; / !) */
const HARD_ENDERS = '。！？；!?;';

export interface DocSection {
  /** heading path, ` / ` joined; '' when the document has no headings */
  title: string;
  body: string;
}

export interface DocSummary {
  /** 1-based section ordinal in the document, so refs stay traceable */
  index: number;
  title: string;
  text: string;
}

export function sectionRefOf(docRef: string, index: number): string {
  return `${docRef}${SECTION_REF_SEP}${index}`;
}

/** whether `ref` is one of `docRef`'s section records (not the document itself) */
export function isSectionRefOf(ref: string | undefined, docRef: string): boolean {
  return !!ref && ref.startsWith(`${docRef}${SECTION_REF_SEP}`);
}

/** every index record belonging to one imported document */
export function belongsToDoc(ref: string | undefined, docRef: string): boolean {
  return ref === docRef || isSectionRefOf(ref, docRef);
}

/**
 * Split on markdown ATX headings — the parser already emits `## 第N页` per
 * slide, and md/txt sources carry their own. Without a single heading there is
 * no structure to follow, so blank-line paragraph blocks are packed into
 * sections of up to {@link SECTION_GROUP_CHARS} characters.
 */
export function splitSections(text: string): DocSection[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.some((l) => HEADING.test(l))) return groupParagraphs(text);

  const sections: DocSection[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let body: string[] = [];
  const flush = (title: string): void => {
    sections.push({ title, body: body.join('\n').trim() });
    body = [];
  };
  for (const line of lines) {
    const m = line.match(HEADING);
    if (!m) {
      body.push(line);
      continue;
    }
    if (body.some((l) => l.trim()) || sections.length || stack.length) flush(titlePath(stack));
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: m[2].trim() });
  }
  flush(titlePath(stack));
  return sections.filter((s) => s.body || s.title);
}

function titlePath(stack: Array<{ level: number; title: string }>): string {
  return stack.map((s) => s.title).join(' / ');
}

function groupParagraphs(text: string): DocSection[] {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const sections: DocSection[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > SECTION_GROUP_CHARS) {
      sections.push({ title: '', body: current });
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) sections.push({ title: '', body: current });
  return sections;
}

/**
 * One record per section: its heading path and first sentence. A section with
 * no body gets no record, but keeps its ordinal — `#s7` must keep pointing at
 * the seventh section of the document, not the seventh summary.
 */
export function buildDocSummaries(text: string): DocSummary[] {
  const out: DocSummary[] = [];
  splitSections(text).forEach((section, i) => {
    const body = section.body.trim();
    if (!body || out.length >= MAX_SUMMARY_SECTIONS) return;
    const prefix = section.title ? `${section.title}：` : '';
    out.push({ index: i + 1, title: section.title, text: clamp(`${prefix}${firstSentence(body)}`) });
  });
  return out;
}

/** the first line of a section, cut at its first sentence ender */
function firstSentence(body: string): string {
  const line = body.split('\n')[0].trim();
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (HARD_ENDERS.includes(ch)) return line.slice(0, i + 1);
    if (ch === '.' && (i + 1 === line.length || line[i + 1] === ' ')) return line.slice(0, i + 1);
  }
  return line;
}

function clamp(s: string): string {
  return s.length <= MAX_SUMMARY_CHARS ? s : `${s.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** is this index record one of the section summaries (vs. the document's own chunks)? */
export function isSummaryRecord(record: RagRecord): boolean {
  return (record.metadata as { kind?: unknown } | undefined)?.kind === 'summary';
}
