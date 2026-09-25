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
 * Validate the file shape from an `unknown`. Both readers take it from outside
 * main's own code — disk JSON, and the `sessionsSave` payload the renderer
 * pushes at us — and the phone-facing snapshot dereferences `sessions`, each
 * session's `turns` and `currentId` on every state echo, so a half-written
 * payload has to be refused here rather than throw later.
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

export class SessionStore {
  constructor(private readonly filePath: string) {}

  load(): SessionsFile {
    try {
      if (!existsSync(this.filePath)) return { ...EMPTY };
      const parsed = asSessionsFile(JSON.parse(readFileSync(this.filePath, 'utf8')));
      if (!parsed) return { ...EMPTY };
      return parsed;
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
