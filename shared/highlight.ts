/**
 * A ~100-line tokenizer for the handful of languages a live-coding answer
 * actually arrives in. Chosen over highlight.js because that would mean
 * vendoring third-party code into the phone page (which is served as a plain
 * script), a size cost this branch has been actively shaving, and a library
 * that emits its own HTML. Every token here is handed to the renderer as raw
 * text — the caller escapes it (spec §7.2).
 *
 * Accuracy is capped on purpose: nested template angle brackets or an f-string
 * may colour slightly wrong, which is a cosmetic miss, not a broken answer.
 */

export type TokenKind = 'kw' | 'str' | 'num' | 'cmt' | 'pre' | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
}

export const SUPPORTED_LANGS = ['cpp', 'c', 'java', 'python', 'javascript', 'typescript', 'go', 'rust'] as const;

const KW: Record<string, string> = {
  cpp: 'alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while true false null',
  python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while yield with True False None self',
  javascript: 'async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield true false null undefined',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota make new len cap append copy delete panic recover',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct trait true type unsafe use where while async await dyn let mod pub ref self',
};
KW.c = KW.cpp;
KW.typescript = `${KW.javascript} type interface enum namespace declare readonly public private protected abstract implements any string number boolean never unknown`;

interface LangSpec {
  keywords: Set<string>;
  line: string[];
  block?: [string, string];
  hashBang: boolean;
  preproc: boolean;
  triple: boolean;
}

const SPECS: Record<string, LangSpec> = {};
for (const lang of SUPPORTED_LANGS) {
  SPECS[lang] = {
    keywords: new Set(KW[lang].split(' ')),
    line: lang === 'python' ? ['#'] : ['//'],
    block: lang === 'python' ? undefined : ['/*', '*/'],
    hashBang: lang === 'python',
    preproc: lang === 'cpp' || lang === 'c',
    triple: lang === 'python',
  };
}

/** the generic spec used when the fence tag is not one of ours: no keyword guessing */
const GENERIC: LangSpec = { keywords: new Set(), line: ['//', '#'], block: ['/*', '*/'], hashBang: false, preproc: false, triple: false };

/**
 * Fence tags arrive as model prose, not as canonical names: ` ```js `, ` ```py `,
 * ` ```c++ ` show up as often as the full language. The SPECS lookup is exact-key,
 * so an unmapped alias silently degrades to GENERIC — no crash, just no keyword
 * colouring nobody would notice. codeFences' LANG_EXT serves download filenames,
 * a different purpose, so the alias table lives here instead.
 */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  golang: 'go',
  rs: 'rust',
};

function normalizeLang(lang: string | undefined): string {
  const key = (lang ?? '').trim().toLowerCase();
  return LANG_ALIAS[key] ?? key;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

function matchAt(src: string, i: number, needle: string): boolean {
  return src.startsWith(needle, i);
}

function scanLineComment(src: string, i: number): number {
  const nl = src.indexOf('\n', i);
  return nl === -1 ? src.length : nl;
}

function scanBlockComment(src: string, i: number, open: string, close: string): number {
  const end = src.indexOf(close, i + open.length);
  return end === -1 ? src.length : end + close.length;
}

/** returns the index just past the string literal, or -1 if this quote does not open one */
function scanString(src: string, i: number, spec: LangSpec): number {
  const ch = src[i];
  if (spec.triple && (ch === '"' || ch === "'") && src[i + 1] === ch && src[i + 2] === ch) {
    const fence = ch.repeat(3);
    const end = src.indexOf(fence, i + 3);
    return end === -1 ? src.length : end + 3;
  }
  if (ch !== '"' && ch !== "'" && ch !== '`') return -1;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === ch) return j + 1;
    // an unterminated single-quote run ends at the newline: treating it as a
    // string to the end of file would colour the rest of the answer
    if (src[j] === '\n' && ch !== '`') return -1;
    j++;
  }
  return ch === '`' ? src.length : -1;
}

function scanNumber(src: string, i: number): number {
  let j = i;
  while (j < src.length && /[0-9a-fA-FxXoObB._]/.test(src[j])) j++;
  return j;
}

export function tokenizeCode(code: string, lang: string | undefined): Token[] {
  const spec = SPECS[normalizeLang(lang)] ?? GENERIC;
  const out: Token[] = [];
  let plain = '';
  const pushPlain = (): void => {
    if (plain) {
      out.push({ kind: 'plain', text: plain });
      plain = '';
    }
  };
  const emit = (kind: TokenKind, text: string): void => {
    pushPlain();
    out.push({ kind, text });
  };

  let i = 0;
  if (spec.hashBang && code.startsWith('#!')) {
    const end = scanLineComment(code, 0);
    emit('cmt', code.slice(0, end));
    i = end;
  }
  while (i < code.length) {
    const ch = code[i];

    if (spec.preproc && ch === '#' && (i === 0 || code[i - 1] === '\n')) {
      const end = scanLineComment(code, i);
      emit('pre', code.slice(i, end));
      i = end;
      continue;
    }
    const lineHit = spec.line.find((m) => matchAt(code, i, m));
    if (lineHit) {
      const end = scanLineComment(code, i);
      emit('cmt', code.slice(i, end));
      i = end;
      continue;
    }
    if (spec.block && matchAt(code, i, spec.block[0])) {
      const end = scanBlockComment(code, i, spec.block[0], spec.block[1]);
      emit('cmt', code.slice(i, end));
      i = end;
      continue;
    }
    const strEnd = scanString(code, i, spec);
    if (strEnd > i) {
      emit('str', code.slice(i, strEnd));
      i = strEnd;
      continue;
    }
    if (isDigit(ch)) {
      const end = scanNumber(code, i);
      emit('num', code.slice(i, end));
      i = end;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < code.length && isIdentPart(code[j])) j++;
      const word = code.slice(i, j);
      if (spec.keywords.has(word)) emit('kw', word);
      else plain += word;
      i = j;
      continue;
    }
    plain += ch;
    i++;
  }
  pushPlain();
  return out;
}
