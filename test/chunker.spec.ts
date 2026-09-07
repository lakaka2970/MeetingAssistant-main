import { describe, expect, it } from 'vitest';
import { chunkText, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from '../electron/rag/chunker';

describe('chunkText (sentence-boundary sliding window)', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('你好，我是候选人。熟悉后端开发。')).toEqual([
      '你好，我是候选人。熟悉后端开发。',
    ]);
  });

  it('returns no chunks for empty/whitespace text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n  ')).toEqual([]);
  });

  it('respects the chunk budget while keeping whole sentences', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `这是第${i}句话，描述一个项目经历。`).join('');
    const chunks = chunkText(sentences, { chunkSize: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    // reassembly covers all sentences (no content loss, overlap 0)
    expect(chunks.join('')).toBe(sentences);
  });

  it('keeps an overlap tail so boundaries stay semantically continuous', () => {
    const text = Array.from({ length: 8 }, (_, i) => `第${i}句，内容关于分布式缓存一致性协议。`).join('');
    const chunks = chunkText(text, { chunkSize: 120, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    // overlap: chunk[n] starts with the tail of chunk[n-1]
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-30);
      expect(chunks[i].startsWith(tail)).toBe(true);
    }
  });

  it('hard-slices a single oversized sentence instead of looping forever', () => {
    const giant = '长'.repeat(1000) + '。';
    const chunks = chunkText(giant, { chunkSize: 300, overlap: 50 });
    expect(chunks.length).toBe(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });

  it('splits on latin sentence enders followed by whitespace', () => {
    const text = 'I built a streaming ASR system. It used ONNX Runtime. Then I optimized it!';
    const chunks = chunkText(text, { chunkSize: 40, overlap: 0 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe('I built a streaming ASR system.');
  });

  it('uses sane defaults (300 chars / 50 overlap) and ignores blank lines', () => {
    const text = `第一段。\n\n第二段。\n\n\n第三段。`;
    const chunks = chunkText(text);
    expect(chunks.join('')).toBe('第一段。第二段。第三段。');
    expect(DEFAULT_CHUNK_SIZE).toBe(300);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(50);
  });
});
