import type { QaHitView, WebSourceView } from '../../../shared/protocol';

export type TurnKind = 'segment' | 'continuous' | 'free' | 'translate' | 'vision';

export interface AnswerTurn {
  id: string;
  kind: TurnKind;
  label: string;
  text: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
  /** streamed reasoning_content from a thinking model, collapsed above the answer */
  reasoning?: string;
  /** prepared answer the knowledge base matched; shown above the AI text */
  qa?: QaHitView;
  /** web sources behind an answer the knowledge base could not cover */
  web?: WebSourceView[];
  /** ③ web search still running after the main answer ended (runtime-only) */
  webPending?: boolean;
  /** ③ model-written supplement block from the late web search */
  webSup?: string;
}

export interface FocusState {
  /** the turn the prompt card renders; null = empty session */
  focus: AnswerTurn | null;
  /** false only while the user is reading a pinned older turn */
  follow: boolean;
}

/**
 * Which turn the teleprompter shows. Default is the newest turn; clicking an
 * older summary pins it so the interviewee can keep reading it while the next
 * answer finishes. A turn STARTING to stream always releases the pin — a new
 * answer is the moment the prompt card exists for.
 */
export function focusTurn(turns: AnswerTurn[], pinnedId: string | null): FocusState {
  const last = turns[turns.length - 1] ?? null;
  if (!last) return { focus: null, follow: true };
  if (last.status === 'streaming') return { focus: last, follow: true };
  const pinned = pinnedId ? turns.find((x) => x.id === pinnedId) : undefined;
  if (pinned && pinned.id !== last.id) return { focus: pinned, follow: false };
  return { focus: last, follow: true };
}
