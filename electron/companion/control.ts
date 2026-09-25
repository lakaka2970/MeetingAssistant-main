/**
 * Remote control from a paired phone (v1.0.1 ⑦): the decisions, kept away from
 * sockets and Electron so they can be tested at all.
 *
 * The command surface is six named operations — not a `SettingsPatch` the phone
 * shapes freely (R8). That is why `authorizeControl` answers `unknown_op`: a
 * device naming a settings key it was never granted is a bug or an attack, and
 * both deserve the same refusal.
 *
 * Pure: no network, no Electron, no fs.
 */
import type { AnswerExpertise, AnswerRichness } from '../../shared/answerStyle';
import type { CompanionControlItems, StoredTurn } from '../../shared/protocol';
import type { HistoryMessage, StateMessage } from './protocol';

/** the six things a phone may do; `history` is the one read-only member */
export type ControlOp = 'richness' | 'expertise' | 'capture' | 'continuous' | 'ask' | 'history';

const CONTROL_OPS: readonly ControlOp[] = [
  'richness',
  'expertise',
  'capture',
  'continuous',
  'ask',
  'history',
];

/** the two style ladders, exactly as the settings file accepts them */
const RICHNESS_STEPS: readonly AnswerRichness[] = ['concise', 'standard', 'detailed'];
const EXPERTISE_STEPS: readonly AnswerExpertise[] = ['casual', 'professional', 'technical'];

/** a typed question, not a lecture — beyond this the phone meant to send less */
export const ASK_MAX_CHARS = 500;
/** wire budget for one history replay */
export const HISTORY_ITEMS = 60;
export const HISTORY_TEXT_CHARS = 4000;
/** per connection: a person tapping a switch cannot generate 5 commands a second */
export const CMD_LIMIT = 5;
export const CMD_WINDOW_MS = 1000;

/** the two settings keys that decide this, read straight off the companion block */
export interface ControlGrants {
  allowControl?: boolean;
  allowItems?: Partial<CompanionControlItems>;
}

export type Verdict = 'ok' | 'control_disabled' | 'item_disabled' | 'unknown_op';

export function isControlOp(value: string): value is ControlOp {
  return (CONTROL_OPS as readonly string[]).includes(value);
}

/**
 * Master switch first, then the per-item grant. Both default to allowed, which
 * is what the settings screen shows and what `getPublic()` expands to — the
 * bridge must not be stricter than the box the user just looked at.
 */
export function authorizeControl(op: string, grants: ControlGrants): Verdict {
  if (!isControlOp(op)) return 'unknown_op';
  if (grants.allowControl === false) return 'control_disabled';
  if (grants.allowItems?.[op] === false) return 'item_disabled';
  return 'ok';
}

export type ArgParse = { ok: true; value: string | boolean | undefined } | { ok: false };

/**
 * Validate one command argument against its op. A rejected argument never
 * reaches `applyPatch`, so no wire message can write a value the ladder does
 * not have or flip a switch with a string.
 */
export function parseControlArg(op: ControlOp, arg: unknown): ArgParse {
  switch (op) {
    case 'richness':
    case 'expertise': {
      const ladder: readonly string[] = op === 'richness' ? RICHNESS_STEPS : EXPERTISE_STEPS;
      return typeof arg === 'string' && ladder.includes(arg) ? { ok: true, value: arg } : { ok: false };
    }
    case 'capture':
    case 'continuous':
      return typeof arg === 'boolean' ? { ok: true, value: arg } : { ok: false };
    case 'ask': {
      if (typeof arg !== 'string') return { ok: false };
      const text = arg.trim();
      // refused rather than truncated: half a question comes back as a
      // confident answer to something nobody asked
      if (!text || text.length > ASK_MAX_CHARS) return { ok: false };
      return { ok: true, value: text };
    }
    case 'history':
      return arg === undefined ? { ok: true, value: undefined } : { ok: false };
  }
}

/** one command that passed every check, with its argument already parsed */
export interface ControlCommand {
  id: string;
  op: ControlOp;
  value: string | boolean | undefined;
}

/** why a command was refused — the phone shows this, so each needs its own words */
export type Refusal = Verdict | 'bad_arg' | 'rate_limited';

export type CommandDecision =
  | { accept: true; command: ControlCommand }
  | { accept: false; id: string; reason: Refusal };

/**
 * The whole admission decision for one `cmd` frame: grant, then argument, then
 * this connection's budget.
 *
 * The budget is spent last on purpose. A command that was never going to run
 * must not eat the window — otherwise one disabled or malformed client can
 * lock a shared connection out, and the only thing the limiter protects is the
 * work `run()` does downstream.
 */
export function acceptCommand(
  msg: { id?: unknown; op?: unknown; arg?: unknown },
  grants: ControlGrants,
  limiter: { allow: () => boolean },
): CommandDecision {
  const id = typeof msg.id === 'string' ? msg.id : '';
  const op = typeof msg.op === 'string' ? msg.op : '';
  const verdict = authorizeControl(op, grants);
  if (verdict !== 'ok') return { accept: false, id, reason: verdict };
  // `verdict === 'ok'` means op is one of the six, which is what narrows it
  const parsed = parseControlArg(op as ControlOp, msg.arg);
  if (!parsed.ok) return { accept: false, id, reason: 'bad_arg' };
  if (!limiter.allow()) return { accept: false, id, reason: 'rate_limited' };
  return { accept: true, command: { id, op: op as ControlOp, value: parsed.value } };
}

/** Sliding-window limiter for one connection's upstream commands. */export class CmdRateLimiter {
  private hits: number[] = [];
  private readonly now: () => number;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(opts: { now?: () => number; limit?: number; windowMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.limit = opts.limit ?? CMD_LIMIT;
    this.windowMs = opts.windowMs ?? CMD_WINDOW_MS;
  }

  /** refusals are not banked: only commands that went through cost budget */
  allow(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}

export function buildStatePayload(src: Omit<StateMessage, 'type'>): StateMessage {
  return { type: 'st', ...src };
}

/** shallow compare so a repeated state costs no send (`st` only fires on change) */
export function sameState(a: StateMessage, b: StateMessage): boolean {
  return (
    a.capturing === b.capturing &&
    a.continuous === b.continuous &&
    a.richness === b.richness &&
    a.expertise === b.expertise &&
    sameSession(a.session, b.session)
  );
}

function sameSession(x: StateMessage['session'], y: StateMessage['session']): boolean {
  if (x === null || y === null) return x === y;
  return x.id === y.id && x.name === y.name && x.answers === y.answers;
}

/**
 * This session's answers, newest first. Turns still streaming are left out: the
 * phone is watching those arrive as `a delta`, and a snapshot that repeated
 * them would look like a second answer.
 *
 * `StoredTurn` carries no timestamp, so order is array order and the item has
 * no fake `ts` of its own.
 */
export function buildHistoryPayload(turns: StoredTurn[]): HistoryMessage {
  const eligible = turns.filter((t) => t.status !== 'streaming');
  const picked = eligible.slice(-HISTORY_ITEMS).reverse();
  let truncated = eligible.length > picked.length;
  const items = picked.map((t) => {
    const text = clampText(t.text);
    if (text.length !== t.text.length) truncated = true;
    return {
      id: t.id,
      kind: t.kind,
      label: t.label,
      text,
      qaRef: t.qa?.ref,
      error: t.error,
    };
  });
  return { type: 'hx', items, total: eligible.length, truncated };
}

function clampText(text: string): string {
  if (text.length <= HISTORY_TEXT_CHARS) return text;
  return `${text.slice(0, HISTORY_TEXT_CHARS - 1)}…`;
}
