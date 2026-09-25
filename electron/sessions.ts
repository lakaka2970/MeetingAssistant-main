/**
 * Multi-session store: persists the right-pane conversations to a plain JSON
 * file (never DOM storage). Each session = one meeting/interview with its own
 * turns and knowledge base.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { SessionsFile } from '../shared/protocol';

const EMPTY: SessionsFile = { sessions: [], currentId: null };

/**
 * The strict gate for the `sessionsSave` IPC. The renderer hands us the whole
 * file in one payload, and the phone-facing snapshot dereferences `sessions`,
 * each session's `turns` and `currentId` on every state echo — so a half
 * written patch has to be refused here rather than throw later. Nothing on this
 * path can be salvaged silently: the writer believes what it just sent.
 */
export function asSessionsFile(value: unknown): SessionsFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const { sessions, currentId } = value as Partial<SessionsFile>;
  if (!Array.isArray(sessions)) return null;
  for (const s of sessions) {
    if (typeof s !== 'object' || s === null) return null;
    if (typeof s.id !== 'string' || !Array.isArray(s.turns)) return null;
  }
  return { sessions, currentId: typeof currentId === 'string' && currentId ? currentId : null };
}

/**
 * The tolerant reader for sessions.json on disk, which we do not own: another
 * install, a hand edit or a torn write can put anything in it. Refusing the
 * file whole would be the worse bug, because the renderer saves whatever
 * `load()` returned — one entry with a missing `turns` array would cost every
 * other meeting and then be persisted. So this repairs entry by entry:
 * a session needs a string `id`, and a `turns` that is not an array becomes an
 * empty one (the name and dates are still the user's).
 */
export function salvageSessionsFile(value: unknown): SessionsFile {
  if (typeof value !== 'object' || value === null) return { ...EMPTY };
  const { sessions, currentId } = value as Partial<SessionsFile>;
  if (!Array.isArray(sessions)) return { ...EMPTY };
  const kept = sessions.flatMap((s) => {
    if (typeof s !== 'object' || s === null || typeof s.id !== 'string') return [];
    return [Array.isArray(s.turns) ? s : { ...s, turns: [] }];
  });
  const id = typeof currentId === 'string' && currentId ? currentId : '';
  // a pointer to an entry we just dropped must not survive: callers resolve it
  return { sessions: kept, currentId: kept.some((s) => s.id === id) ? id : null };
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  load(): SessionsFile {
    try {
      if (!existsSync(this.filePath)) return { ...EMPTY };
      return salvageSessionsFile(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch (e) {
      console.warn('[sessions] load failed, starting empty:', (e as Error).message);
      return { ...EMPTY };
    }
  }

  save(data: SessionsFile): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (e) {
      console.error('[sessions] save failed:', (e as Error).message);
    }
  }
}
