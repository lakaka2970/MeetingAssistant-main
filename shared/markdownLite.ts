/**
 * Minimal inline-Markdown -> HTML for answer bodies.
 *
 * The answer pane is a plain-text surface: the teleprompter persona tells the
 * model not to emit Markdown, and free-ask answers arrive with `**bold**`,
 * `*italic*`, `` `code` `` and `### 标题` markers that would otherwise be shown
 * verbatim (the "raw Markdown" the user sees when a formula answer comes back).
 * This covers exactly those inline constructs plus line headings; block
 * structure (tables, nested lists, quotes) is deliberately out of scope — list
 * bullets and `-`/`1.` markers stay as they are because they already read fine
 * as text.
 *
 * Everything is escaped before any markup is generated and only the fixed tags
 * <b>/<i>/<code>/<span class="md-h"> are ever produced, so the output is safe
 * for dangerouslySetInnerHTML. Pure function — unit-testable without a DOM.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => HTML_ESCAPES[c] as string);
}

/** `#{1,6} ` at line start -> a bolded heading span (the #s are consumed) */
const HEADING = /^(\s{0,3})#{1,6}[ \t]+(.+?)[ \t]*$/gm;
/** `**bold**` — no newline, no nested `*` in the body */
const BOLD = /\*\*([^\n*]+?)\*\*/g;
/**
 * `*italic*` — the lookarounds keep `2*3*4` products and leftovers of a
 * `**bold**` pass from being eaten.
 */
const ITALIC = /(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g;
/** `` `code` `` — extracted first so its content never gets emphasised */
const CODE = /`([^`\n]+)`/g;

export function renderMarkdownLite(text: string): string {
  if (!text) return '';
  let out = escapeHtml(text);

  // 1. code spans -> sentinel placeholders (their bodies stay escaped and are
  //    never touched by the emphasis passes below)
  const spans: string[] = [];
  out = out.replace(CODE, (_m, body: string) => {
    spans.push(`<code class="md-c">${body}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  // 2. line headings, then inline emphasis
  out = out.replace(HEADING, (_m, indent: string, body: string) => `${indent}<span class="md-h">${body}</span>`);
  out = out.replace(BOLD, '<b>$1</b>');
  out = out.replace(ITALIC, '$1<i>$2</i>');

  // 3. restore code spans
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? '');
  return out;
}
