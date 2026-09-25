/**
 * The shape check the two readers of sessions.json share: `SessionStore.load`
 * gets the payload from disk, and the `sessionsSave` IPC hands the same shape
 * straight to the phone-facing snapshot in main. A malformed write must not
 * become a throw in the main process.
 */
import { describe, expect, it } from 'vitest';
import { asSessionsFile } from '../electron/sessions';

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
