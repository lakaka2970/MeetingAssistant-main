import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGS, tokenizeCode, type TokenKind } from '../shared/highlight';

const joined = (src: string, lang: string | undefined): string =>
  tokenizeCode(src, lang).map((t) => t.text).join('');
const kindOf = (src: string, lang: string | undefined, word: string): TokenKind | undefined =>
  tokenizeCode(src, lang).find((t) => t.text === word)?.kind;
// split-agnostic lookup: which kind colours this text, wherever the run is cut
const kindCovering = (src: string, lang: string | undefined, needle: string): TokenKind | undefined =>
  tokenizeCode(src, lang).find((t) => t.text.includes(needle))?.kind;

describe('tokenizeCode', () => {
  it('classifies keywords, numbers and strings in a cpp line', () => {
    const src = 'int x = 123;';
    expect(joined(src, 'cpp')).toBe(src);
    expect(kindOf(src, 'cpp', 'int')).toBe('kw');
    expect(kindOf(src, 'cpp', '123')).toBe('num');
    expect(kindCovering(src, 'cpp', 'x')).toBe('plain');
  });

  it('keeps a whole line comment as one token, keywords inside it included', () => {
    const src = '// return the int\nx';
    expect(joined(src, 'cpp')).toBe(src);
    expect(kindOf(src, 'cpp', '// return the int')).toBe('cmt');
    // `return` inside the comment must not surface as its own keyword token
    expect(tokenizeCode(src, 'cpp').some((t) => t.kind === 'kw' && t.text === 'return')).toBe(false);
  });

  it('does not treat a keyword substring as a keyword', () => {
    expect(joined('printf', 'cpp')).toBe('printf');
    expect(tokenizeCode('printf', 'cpp').some((t) => t.kind === 'kw')).toBe(false);
  });

  it('keeps an escaped quote and a brace inside one string token', () => {
    const src = 'const s = "a\\"b{"';
    expect(joined(src, 'javascript')).toBe(src);
    expect(kindOf(src, 'javascript', '"a\\"b{"')).toBe('str');
  });

  it('marks python triple-quoted strings and cpp preprocessor lines', () => {
    const py = '"""doc\nline"""\nreturn 1';
    expect(joined(py, 'python')).toBe(py);
    expect(kindOf(py, 'python', '"""doc\nline"""')).toBe('str');
    expect(kindCovering('#include <cstring>', 'cpp', '#include')).toBe('pre');
  });

  it('emits only generic tokens for an unknown language, never guesses keywords', () => {
    const src = 'def x = "s" // c';
    expect(joined(src, 'brainfuck')).toBe(src);
    expect(tokenizeCode(src, 'brainfuck').some((t) => t.kind === 'kw')).toBe(false);
    expect(kindOf(src, 'brainfuck', '"s"')).toBe('str');
    expect(kindOf(src, 'brainfuck', '// c')).toBe('cmt');
  });

  it('never produces an empty token', () => {
    const src = 'func main() {\n  a := 1 // one\n}\n';
    expect(tokenizeCode(src, 'go').every((t) => t.text.length > 0)).toBe(true);
    expect(joined(src, 'go')).toBe(src);
  });

  it('survives CRLF and a lone dollar sign', () => {
    const src = 'if ($x -gt 0) {\r\n  echo $((a+b))\r\n}';
    expect(joined(src, 'sh')).toBe(src);
  });

  it('maps common fence aliases onto the canonical language, not onto GENERIC', () => {
    const src = 'function f() {\n  return "s";\n}\n';
    // js is what models actually write; it must classify exactly like javascript
    expect(tokenizeCode(src, 'js')).toEqual(tokenizeCode(src, 'javascript'));
    expect(kindOf(src, 'js', 'function')).toBe('kw');
    expect(kindOf(src, 'js', '"s"')).toBe('str');
    // the other aliases models emit constantly
    expect(tokenizeCode('return 1', 'py')).toEqual(tokenizeCode('return 1', 'python'));
    expect(tokenizeCode('int x = 1;', 'c++')).toEqual(tokenizeCode('int x = 1;', 'cpp'));
    expect(kindOf('let mut x = 1;', 'rs', 'let')).toBe('kw');
    expect(kindOf('func main() {}', 'golang', 'func')).toBe('kw');
  });
});

describe('SUPPORTED_LANGS', () => {
  it('covers every language the answer contract allows', () => {
    for (const lang of ['cpp', 'java', 'python', 'javascript', 'typescript', 'go']) {
      expect(SUPPORTED_LANGS).toContain(lang);
    }
  });
});
