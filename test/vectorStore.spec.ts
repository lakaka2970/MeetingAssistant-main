import { describe, expect, it } from 'vitest';
import {
  VectorStore,
  serializeIndex,
  parseIndex,
  textHash,
  type RagIndexFile,
  type RagUpsert,
} from '../electron/rag/vector-store';

const dim = 8;

function vec(...xs: number[]): Float32Array {
  const v = new Float32Array(dim);
  v.set(xs);
  return v;
}

/** unit vectors for clean cosine scores */
function unit(...xs: number[]): Float32Array {
  const v = vec(...xs);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm) as Float32Array;
}

function chunk(over: Partial<RagUpsert> = {}): RagUpsert {
  return {
    source: 'knowledge',
    text: 'some text',
    embedding: unit(1, 0),
    ...over,
  };
}

let persistCalls = 0;
function makeStore(modelKey = 'test-model'): { store: VectorStore; files: RagIndexFile[] } {
  const files: RagIndexFile[] = [];
  const store = new VectorStore(modelKey, (f) => {
    persistCalls++;
    files.push(f);
  });
  return { store, files };
}

describe('textHash', () => {
  it('is deterministic and order-sensitive', () => {
    expect(textHash('abc')).toBe(textHash('abc'));
    expect(textHash('abc')).not.toBe(textHash('abd'));
    expect(textHash('')).toBe(textHash(''));
  });
});

describe('VectorStore', () => {
  it('adds records with monotonic ids and dedupes identical text', () => {
    const { store } = makeStore();
    const a = store.add(chunk({ text: '简历项目：实时转录系统' }))!;
    const dup = store.add(chunk({ text: '简历项目：实时转录系统' }));
    const b = store.add(chunk({ text: 'JD：负责高并发服务' }))!;
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(dup).toBeNull();
    expect(store.size).toBe(2);
    expect(persistCalls).toBe(2); // dup add must not persist
  });

  it('dedupe is scoped per source/ref/session, not global', () => {
    const { store } = makeStore();
    const first = store.add(chunk({ text: '同文', source: 'resume', sessionId: 's1' }))!;
    const otherSession = store.add(chunk({ text: '同文', source: 'resume', sessionId: 's2' }))!;
    const otherRef = store.add(chunk({ text: '同文', source: 'resume', sessionId: 's1', ref: 'b.pdf' }))!;
    expect([first.id, otherSession.id, otherRef.id]).toEqual([1, 2, 3]);
  });

  it('searches by cosine similarity and respects topK', () => {
    const { store } = makeStore();
    store.add(chunk({ text: 'x', embedding: unit(1, 0) }))!; // id 1
    store.add(chunk({ text: 'y', embedding: unit(0, 1) }))!; // id 2
    store.add(chunk({ text: 'z', embedding: unit(0.9, 0.1) }))!; // id 3
    const hits = store.search(unit(1, 0), { topK: 2, minScore: 0 });
    expect(hits.map((h) => h.record.id)).toEqual([1, 3]);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('scope: no session = global only; a session = that session + global', () => {
    const { store } = makeStore();
    store.add(chunk({ text: '全局知识', source: 'knowledge' })); // global
    store.add(chunk({ text: 's1 简历', source: 'resume', sessionId: 's1' }));
    store.add(chunk({ text: 's2 简历', source: 'resume', sessionId: 's2' }));

    const globalOnly = store.search(unit(1, 0), { minScore: 0 });
    expect(globalOnly.map((h) => h.record.source)).toEqual(['knowledge']);

    const s1 = store.search(unit(1, 0), { minScore: 0, sessionId: 's1' });
    expect(s1.map((h) => h.record.text).sort()).toEqual(['s1 简历', '全局知识']);
  });

  it('filters by sources', () => {
    const { store } = makeStore();
    store.add(chunk({ text: 'note', source: 'custom_note' }));
    store.add(chunk({ text: 'fact', source: 'fact' }));
    const hits = store.search(unit(1, 0), { minScore: 0, sources: ['fact'] });
    expect(hits.map((h) => h.record.source)).toEqual(['fact']);
  });

  it('removeWhere drops matching records and their vectors', () => {
    const { store } = makeStore();
    store.add(chunk({ text: 'keep', sessionId: 's1' }));
    store.add(chunk({ text: 'drop', sessionId: 's1' }));
    store.add(chunk({ text: 'keep-global' }));
    const removed = store.removeWhere((r) => r.sessionId === 's1' && r.text === 'drop');
    expect(removed).toBe(1);
    expect(store.size).toBe(2);
    // the dropped vector can no longer be found
    const hits = store.search(unit(1, 0), { minScore: 0, sessionId: 's1' });
    expect(hits.map((h) => h.record.text).sort()).toEqual(['keep', 'keep-global']);
  });

  it('round-trips through serialize/parse with base64 float32 vectors', () => {
    const { store, files } = makeStore('bge-m3');
    store.add(chunk({ text: 'one', embedding: unit(1, 0), source: 'resume' }));
    store.add(chunk({ text: 'two', embedding: unit(0, 1), source: 'jd' }));

    const file = files.at(-1)!;
    expect(file.modelKey).toBe('bge-m3');
    expect(file.nextId).toBe(3);

    const restored = VectorStore.fromFile(file);
    expect(restored.size).toBe(2);
    const hits = restored.search(unit(1, 0), { minScore: 0 });
    expect(hits[0].record.text).toBe('one');
    expect(hits[0].score).toBeCloseTo(1, 5);
    // new adds continue the id sequence
    const added = restored.add(chunk({ text: 'three' }))!;
    expect(added.id).toBe(3);
  });

  it('reports per-source counts for the status UI', () => {
    const { store } = makeStore();
    store.add(chunk({ text: 'a', source: 'resume', sessionId: 's' }));
    store.add(chunk({ text: 'b', source: 'resume', sessionId: 's' }));
    store.add(chunk({ text: 'c', source: 'knowledge' }));
    expect(store.countsBySource()).toEqual({ resume: 2, knowledge: 1 });
  });
});
