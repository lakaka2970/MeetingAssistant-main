import { describe, expect, it } from 'vitest';
import { asciiTerms, structuralChunks } from '../electron/rag/autoKb';

describe('structuralChunks', () => {
  it('splits markdown on ## sections, keeping author boundaries', () => {
    const md = '# 标题\n\n引言太短不算。\n\n## 第一节\n\n' + '甲'.repeat(60) + '\n\n## 第二节\n\n' + '乙'.repeat(60);
    const chunks = structuralChunks('note.md', md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].section).toBe('第一节');
    expect(chunks[0].text).toContain('甲');
    expect(chunks[1].text).toContain('乙');
  });

  it('splits extracted interview text on numbered questions, not body list items', () => {
    const txt = [
      '1. shared_ptr 是线程安全的吗？',
      '核心答案：计数安全，对象不安全。',
      '1. 递归要有基准条件。',
      '2. 大对象放堆上。',
      '2. TCP 为什么三次握手？',
      '防止历史 SYN。',
      '3. 死锁的必要条件有哪些？',
      '互斥、占有并等待。',
    ].join('\n');
    const chunks = structuralChunks('book.pdf', txt);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toContain('递归要有基准条件'); // list items stay inside Q1
    expect(chunks[1].section).toContain('三次握手');
  });

  it('falls back to paragraph groups for unstructured text', () => {
    const txt = Array.from({ length: 6 }, (_, i) => `段落${i}。` + '内容'.repeat(150)).join('\n\n');
    const chunks = structuralChunks('plain.txt', txt);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1400)).toBe(true);
  });

  it('returns nothing for empty text', () => {
    expect(structuralChunks('x.md', '   ')).toEqual([]);
  });
});

describe('asciiTerms', () => {
  it('extracts identifier-like tokens for the lexical stem', () => {
    expect(asciiTerms('shared_ptr 与 weak_ptr 的区别')).toEqual(['shared_ptr', 'weak_ptr']);
  });
});