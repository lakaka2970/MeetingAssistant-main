/**
 * Answer text → prose segments + code segments.
 *
 * The answer pane used to be one pre-wrap blob, so a model-emitted ``` fence
 * showed its own backticks and the code inside lost every monospace property
 * (shared/markdownLite.ts:8-11 declares block structure out of scope). This
 * splits the block out BEFORE any inline markup runs, which also keeps a shell
 * `$((a+b))` from reaching the math splitter (shared/mathSplit.ts:23).
 *
 * Deliberately generates no HTML: escaping stays the job of each renderer, so
 * nothing here can be double-escaped. Pure, no DOM.
 */

export type AnswerSeg =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; lang?: string; body: string };

/** ` ```lang ` / `~~~lang` at line start, up to 3 leading spaces like CommonMark */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]*)[ \t]*$/;

const LANG_EXT: Record<string, string> = {
  cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'hpp',
  c: 'c', h: 'h',
  java: 'java',
  python: 'py', python3: 'py', py: 'py',
  javascript: 'js', js: 'js', jsx: 'jsx',
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  go: 'go', golang: 'go',
  rust: 'rs', rs: 'rs',
  sql: 'sql', sh: 'sh', bash: 'sh', shell: 'sh',
};

/** the file extension a downloaded snippet should get; unknown tags are not an error */
export function codeFileExt(lang: string | undefined, fallback = 'txt'): string {
  const key = (lang ?? '').trim().toLowerCase();
  return LANG_EXT[key] ?? fallback;
}

function trimBlankEdges(lines: string[]): string {
  let from = 0;
  let to = lines.length;
  while (from < to && !lines[from].trim()) from++;
  while (to > from && !lines[to - 1].trim()) to--;
  return lines.slice(from, to).join('\n');
}

export function splitCodeFences(text: string): AnswerSeg[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const segs: AnswerSeg[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    // whitespace-only runs between two blocks carry no information; a real
    // paragraph keeps its blank lines untouched so pre-wrap still lays it out
    if (prose.some((l) => l.trim())) segs.push({ kind: 'prose', text: prose.join('\n') });
    prose = [];
  };

  // one cursor, advanced by both loops: a `for` whose body also moves `i` is how
  // an unterminated fence turns into an infinite loop
  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      i++;
      continue;
    }
    flushProse();
    const marker = open[1];
    const lang = open[2] ? open[2].toLowerCase() : undefined;
    const body: string[] = [];
    for (i++; i < lines.length; i++) {
      const close = FENCE.exec(lines[i]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length && close[2] === '') {
        i++;
        break;
      }
      body.push(lines[i]);
    }
    segs.push({ kind: 'code', lang, body: trimBlankEdges(body) });
  }
  flushProse();
  return segs;
}
