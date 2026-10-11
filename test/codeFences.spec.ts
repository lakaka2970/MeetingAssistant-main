import { describe, expect, it } from 'vitest';
import { codeFileExt, splitCodeFences } from '../shared/codeFences';

describe('splitCodeFences', () => {
  it('returns nothing for empty text', () => {
    expect(splitCodeFences('')).toEqual([]);
  });

  it('leaves fence-free text as one prose segment, byte for byte', () => {
    const text = '先给结论：B\n\n依据有两点\n- 一\n- 二';
    expect(splitCodeFences(text)).toEqual([{ kind: 'prose', text }]);
  });

  it('splits prose around a fenced block and keeps the language tag', () => {
    const segs = splitCodeFences('思路一句话\n```cpp\nint main(){}\n```\n复杂度 O(n)');
    expect(segs).toEqual([
      { kind: 'prose', text: '思路一句话' },
      { kind: 'code', lang: 'cpp', body: 'int main(){}' },
      { kind: 'prose', text: '复杂度 O(n)' },
    ]);
  });

  it('preserves indentation and blank lines inside the block, trimming block edges', () => {
    const segs = splitCodeFences('```python\n\ndef f(x):\n    return x\n\n```');
    expect(segs[0]).toEqual({ kind: 'code', lang: 'python', body: 'def f(x):\n    return x' });
  });

  it('treats an unterminated fence as code all the way to the end', () => {
    const segs = splitCodeFences('```java\nclass A {\n  int x;');
    expect(segs).toEqual([{ kind: 'code', lang: 'java', body: 'class A {\n  int x;' }]);
  });

  it('accepts tilde fences and requires the same marker to close', () => {
    expect(splitCodeFences('~~~go\npackage main\n~~~')).toEqual([
      { kind: 'code', lang: 'go', body: 'package main' },
    ]);
    // a backtick fence is not closed by tildes: the tildes are part of the code
    expect(splitCodeFences('```\n~~~\n```')).toEqual([{ kind: 'code', lang: undefined, body: '~~~' }]);
  });

  it('keeps a fence marker and dollar signs inside the block out of the prose passes', () => {
    const segs = splitCodeFences('```\necho $((a+b))\n```` not a close\n```');
    expect(segs[0]).toEqual({ kind: 'code', lang: undefined, body: 'echo $((a+b))\n```` not a close' });
  });

  it('handles CRLF and multiple blocks', () => {
    const segs = splitCodeFences('a\r\n```py\r\nx=1\r\n```\r\nb\r\n```py\r\ny=2\r\n```');
    expect(segs.map((s) => s.kind)).toEqual(['prose', 'code', 'prose', 'code']);
    expect((segs[1] as { body: string }).body).toBe('x=1');
  });
});

describe('codeFileExt', () => {
  it('maps the languages the answer contract allows', () => {
    expect(codeFileExt('cpp')).toBe('cpp');
    expect(codeFileExt('C++')).toBe('cpp');
    expect(codeFileExt('typescript')).toBe('ts');
    expect(codeFileExt('python3')).toBe('py');
  });

  it('falls back to txt for an unknown or missing tag', () => {
    expect(codeFileExt('brainfuck')).toBe('txt');
    expect(codeFileExt(undefined)).toBe('txt');
  });

  it('never walks the prototype chain for a tag that names an Object member', () => {
    // models do not always obey the six-tag contract and revisions are model
    // output: LANG_EXT is an object literal, so a bare LANG_EXT[key] would hit
    // Object.prototype for `constructor` and name the download
    // answer.function Object() { [native code] }… — the phone twin
    // (resources/companion/markdown.js) has the same own-property guard.
    expect(codeFileExt('constructor')).toBe('txt');
    expect(codeFileExt('toString')).toBe('txt');
    expect(codeFileExt('__proto__')).toBe('txt');
  });
});
