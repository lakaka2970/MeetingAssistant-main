/**
 * The two shape checks over sessions.json: `asSessionsFile` is the strict gate
 * on the `sessionsSave` IPC (a half-written payload from the renderer must not
 * reach the phone-facing snapshot), and `salvageSessionsFile` is what the disk
 * reader uses — a file we did not write gets repaired per entry, never refused
 * whole, because whatever load() returns is what the next save persists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, asSessionsFile, salvageSessionsFile } from '../electron/sessions';

const session = (over = {}) => ({ id: 's1', name: '某厂二面', createdAt: 1, turns: [], ...over });

describe('asSessionsFile', () => {
  it('keeps a well-formed file as-is', () => {
    const file = { sessions: [session()], currentId: 's1' };
    expect(asSessionsFile(file)).toEqual(file);
  });

  it('reads a missing, empty or non-string currentId as no session', () => {
    for (const currentId of [undefined, '', 7, {}]) {
      expect(asSessionsFile({ sessions: [session()], currentId })?.currentId).toBeNull();
    }
  });

  it('refuses anything the phone-facing readers would dereference', () => {
    // each of these used to reach `ctlCurrentSession()` and throw in main while
    // a phone was waiting for its `st` echo
    const bad: unknown[] = [
      null,
      undefined,
      'sessions',
      42,
      {},
      { sessions: null, currentId: null },
      { sessions: {}, currentId: null },
      { sessions: [{ id: 's1' }], currentId: 's1' }, // no turns array
      { sessions: [{ id: 1, turns: [] }], currentId: 's1' }, // id not a string
      { sessions: [null], currentId: 's1' },
    ];
    for (const value of bad) expect(asSessionsFile(value)).toBeNull();
  });
});

describe('salvageSessionsFile', () => {
  it('keeps the good entries when one is broken, and repairs a missing turns', () => {
    const repaired = { id: 's2', name: 'B', createdAt: 2, turns: [] };
    const file = {
      sessions: [
        { id: 's1', name: 'A', createdAt: 1, turns: [{}] },
        { id: 's2', name: 'B', createdAt: 2 }, // no turns at all
        { id: 3, name: 'C', createdAt: 3, turns: [] }, // id not a string
        null,
      ],
      currentId: 's1',
    };
    expect(salvageSessionsFile(file)).toEqual({
      sessions: [file.sessions[0], repaired],
      currentId: 's1',
    });
  });

  it('nulls a currentId that pointed at an entry it dropped', () => {
    const out = salvageSessionsFile({ sessions: [{ id: 7, turns: [] }], currentId: 'gone' });
    expect(out).toEqual({ sessions: [], currentId: null });
  });

  it('reads garbage as an empty library', () => {
    for (const value of [null, undefined, 42, 'x', {}, { sessions: null }]) {
      expect(salvageSessionsFile(value)).toEqual({ sessions: [], currentId: null });
    }
  });
});

describe('SessionStore.load reads a foreign file without losing the good half', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-sessions-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('salvages the sessions that are readable instead of returning empty', () => {
    // the whole reason load() is not the strict gate: the renderer saves back
    // whatever load() returned, so a wholesale refusal is a delete
    const file = join(dir, 'sessions.json');
    writeFileSync(
      file,
      JSON.stringify({
        sessions: [
          { id: 's1', name: 'A', createdAt: 1, turns: [{}] },
          { id: 's2', name: 'B', createdAt: 2 }, // turns missing entirely
        ],
        currentId: 's1',
      }),
      'utf8',
    );
    expect(new SessionStore(file).load()).toEqual({
      sessions: [
        { id: 's1', name: 'A', createdAt: 1, turns: [{}] },
        { id: 's2', name: 'B', createdAt: 2, turns: [] },
      ],
      currentId: 's1',
    });
  });
});
