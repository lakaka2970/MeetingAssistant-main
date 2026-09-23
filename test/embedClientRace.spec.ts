/**
 * Regression: switching embedding models must not let the OLD worker's 'exit'
 * event sabotage the freshly forked one. The old handler used to null out
 * this.child (orphaning the new process), failAll() the new pending requests
 * and flip the state to 'error' mid-load.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { forkSpy } = vi.hoisted(() => ({ forkSpy: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: forkSpy } }));

import { EmbedClient } from '../electron/rag/embedClient';

class FakeChild extends EventEmitter {
  messages: Record<string, unknown>[] = [];
  exited = false;
  postMessage(msg: Record<string, unknown>): void {
    this.messages.push(msg);
  }
  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', 0);
  }
  /** simulate the worker answering an init with a ready message */
  goReady(modelKey: string): void {
    this.emit('message', { type: 'ready', modelKey, dim: 4, source: 'local' });
  }
}

function nextChild(): FakeChild {
  const c = new FakeChild();
  forkSpy.mockReturnValue(c);
  return c;
}

describe('EmbedClient model-switch race', () => {
  beforeEach(() => {
    forkSpy.mockReset();
  });

  it('keeps serving from the new worker when the old one exits after the switch', async () => {
    const client = new EmbedClient();
    const a = nextChild();
    const pA = client.ensure({ modelKey: 'm1', modelsDir: 'x' });
    a.goReady('m1');
    await pA;
    expect(client.state).toBe('ready');

    const b = nextChild();
    const pB = client.ensure({ modelKey: 'm2', modelsDir: 'x' });
    // the old worker lands its exit AFTER the new fork — this is the race
    a.exited = true;
    a.emit('exit', 0);
    b.goReady('m2');
    await pB;

    expect(client.state).toBe('ready');
    const embedP = client.embed(['hello'], 1000);
    // embed() serialises through a promise chain — let the queue drain first
    await new Promise((r) => setImmediate(r));
    const req = b.messages.find((m) => m.type === 'embed') as { reqId: number };
    expect(req).toBeTruthy();
    const vec = new Float32Array([1, 2, 3, 4]);
    b.emit('message', {
      type: 'embedResult',
      reqId: req.reqId,
      vectors: [Buffer.from(vec.buffer).toString('base64')],
      ms: 1,
    });
    const [v] = await embedP;
    expect(Array.from(v)).toEqual([1, 2, 3, 4]);
  });
});
