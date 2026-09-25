import { describe, expect, it } from 'vitest';
import {
  DeferredWriter,
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

/** a store that only reports "dirty" — snapshots are taken by hand */
function makeStore(modelKey = 'test-model'): { store: VectorStore; dirty: () => number } {
  let notices = 0;
  const store = new VectorStore(modelKey, () => {
    notices++;
  });
  return { store, dirty: () => notices };
}

/** a clock the test drives, so nothing sleeps and nothing races */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    advance: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pendingTimers: () => timers.size,
  };
}

describe('textHash', () => {
  it('is deterministic and order-sensitive', () => {
    expect(textHash('abc')).toBe(textHash('abc'));
    expect(textHash('abc')).not.toBe(textHash('abd'));
    expect(textHash('')).toBe(textHash(''));
  });
});

describe('DeferredWriter', () => {
  it('serializes once per burst, not once per request', () => {
    const clock = fakeClock();
    let serializations = 0;
    const written: RagIndexFile[] = [];
    const w = new DeferredWriter(
      (f) => written.push(f),
      () => {
        serializations++;
        return emptyFile(serializations);
      },
      400,
      clock,
    );
    for (let i = 0; i < 20; i++) w.request();
    expect(serializations).toBe(0); // the expensive part is deferred
    clock.advance(400);
    expect(serializations).toBe(1);
    expect(written).toHaveLength(1);
  });

  it('re-arms the window on a later request and writes the current state', () => {
    const clock = fakeClock();
    let state = 0;
    const seen: number[] = [];
    const w = new DeferredWriter(
      (f) => seen.push(f.nextId),
      () => emptyFile(state),
      400,
      clock,
    );
    state++;
    w.request();
    clock.advance(200);
    state++;
    w.request(); // still unsettled: the window moves
    clock.advance(200);
    expect(seen).toEqual([]);
    clock.advance(200);
    expect(seen).toEqual([2]);
  });

  it('flush() writes immediately, disarms the timer, and no-ops when clean', () => {
    const clock = fakeClock();
    let writes = 0;
    let serializations = 0;
    const w = new DeferredWriter(
      () => writes++,
      () => {
        serializations++;
        return emptyFile(1);
      },
      400,
      clock,
    );
    w.flush();
    expect(writes).toBe(0); // nothing pending: no empty file lands on disk
    w.request();
    w.flush();
    expect(writes).toBe(1);
    expect(serializations).toBe(1);
    expect(clock.pendingTimers()).toBe(0);
    w.flush();
    expect(writes).toBe(1);
  });

  it('carries an import of N chunks to disk as one file containing all N', () => {
    const clock = fakeClock();
    const written: RagIndexFile[] = [];
    let writer: DeferredWriter | undefined;
    const store = new VectorStore('m', () => writer?.request());
    writer = new DeferredWriter((f) => written.push(f), () => store.serialize(), 400, clock);
    for (let i = 0; i < 5; i++) store.add(chunk({ text: `line ${i}` }));
    expect(written).toHaveLength(0); // five adds, zero disk hits so far
    writer.flush();
    expect(written).toHaveLength(1);
    expect(written[0].records).toHaveLength(5);
  });

  it('keeps the snapshot outstanding so a failed write is retried', () => {
    // A full disk during one meeting must not switch persistence off for the
    // rest of the session: the whole library would be lost on exit.
    const clock = fakeClock();
    let serializations = 0;
    const errors: string[] = [];
    const w = new DeferredWriter(
      () => {
        serializations++;
        throw new Error('ENOSPC: no space left on device');
      },
      () => emptyFile(serializations),
      400,
      clock,
      (msg) => errors.push(msg),
    );
    w.request();
    clock.advance(400);
    expect(serializations).toBe(1);
    expect(errors).toEqual(['ENOSPC: no space left on device']);
    w.flush(); // the next bulk op — or shutdown — gets another shot
    expect(serializations).toBe(2);
  });
});

function emptyFile(nextId = 0): RagIndexFile {
  return { version: 1, nextId, modelKey: 'test', records: [], vectors: {} };
}

describe('VectorStore', () => {
  it('adds records with monotonic ids and dedupes identical text', () => {
    const { store, dirty } = makeStore();
    const a = store.add(chunk({ text: '简历项目：实时转录系统' }))!;
    const dup = store.add(chunk({ text: '简历项目：实时转录系统' }));
    const b = store.add(chunk({ text: 'JD：负责高并发服务' }))!;
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(dup).toBeNull();
    expect(store.size).toBe(2);
    expect(dirty()).toBe(2); // the dup add must not dirty the store
  });

  it('handing a mutation over is a notice, not a serialization', () => {
    const { store, dirty } = makeStore();
    store.add(chunk({ text: 'x' }));
    expect(dirty()).toBe(1);
    // the owner may snapshot whenever it likes and always sees current state
    expect(store.serialize().records).toHaveLength(1);
    store.add(chunk({ text: 'y' }));
    expect(store.serialize().records).toHaveLength(2);
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

  it('removeWhere dirties the store only when something actually went', () => {
    const { store, dirty } = makeStore();
    store.add(chunk({ text: 'keep' }));
    expect(dirty()).toBe(1);
    expect(store.removeWhere((r) => r.text === 'gone')).toBe(0);
    expect(dirty()).toBe(1);
    expect(store.removeWhere((r) => r.text === 'keep')).toBe(1);
    expect(dirty()).toBe(2);
  });

  it('round-trips through serialize/parse with base64 float32 vectors', () => {
    const { store } = makeStore('bge-m3');
    store.add(chunk({ text: 'one', embedding: unit(1, 0), source: 'resume' }));
    store.add(chunk({ text: 'two', embedding: unit(0, 1), source: 'jd' }));

    const file = store.serialize();
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
