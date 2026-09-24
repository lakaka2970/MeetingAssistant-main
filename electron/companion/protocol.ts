/**
 * Wire protocol for the LAN companion bridge (phone display).
 *
 * Frame layout is carried over unchanged from MyTool's `protocol.py` (24-byte
 * fixed header + JPEG payload), only the magic differs. It stays a
 * cross-language contract: the phone parses it with a DataView, so a field
 * width must never be tweaked here without touching `parseFrame` there.
 *
 *   offset  len  field
 *   0       2    magic 'MC'
 *   2       1    version
 *   3       1    flags (bit0 = JPEG)
 *   4       4    seq        (uint32 BE)
 *   8       8    ts (ms)    (uint64 BE)
 *   16      4    width      (uint32 BE)
 *   20      4    height     (uint32 BE)
 *   24      N    JPEG data
 *
 * Pure logic: no network, no Electron, no fs — so it is unit-testable and can
 * never be the reason the bridge fails to start.
 */

import type { AnswerExpertise, AnswerRichness } from '../../shared/answerStyle';
import type { CompanionControlItems } from '../../shared/protocol';
import type { ControlOp } from './control';

export const FRAME_MAGIC = 'MC';
export const FRAME_VERSION = 1;
export const FRAME_FLAG_JPEG = 0x01;
/** derived from the layout, never hand-written — a literal drifts silently */
export const FRAME_HEADER_SIZE = 2 + 1 + 1 + 4 + 8 + 4 + 4;

export interface Frame {
  seq: number;
  timestampMs: number;
  width: number;
  height: number;
  payload: Buffer;
}

export function buildFrame(
  seq: number,
  timestampMs: number,
  width: number,
  height: number,
  payload: Buffer,
): Buffer {
  const head = Buffer.alloc(FRAME_HEADER_SIZE);
  head.write(FRAME_MAGIC, 0, 'latin1');
  head.writeUInt8(FRAME_VERSION, 2);
  head.writeUInt8(FRAME_FLAG_JPEG, 3);
  head.writeUInt32BE(seq >>> 0, 4);
  head.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(timestampMs))), 8);
  head.writeUInt32BE(width >>> 0, 16);
  head.writeUInt32BE(height >>> 0, 20);
  return Buffer.concat([head, payload]);
}

/** Returns null instead of throwing: a malformed frame arrives from the network. */
export function parseFrame(data: Buffer): Frame | null {
  if (data.length < FRAME_HEADER_SIZE) return null;
  if (data.toString('latin1', 0, 2) !== FRAME_MAGIC) return null;
  if (data.readUInt8(2) !== FRAME_VERSION) return null;
  if (!(data.readUInt8(3) & FRAME_FLAG_JPEG)) return null;
  return {
    seq: data.readUInt32BE(4),
    // ms since epoch exceeds int32 and comfortably fits double precision, so a
    // JS number is exact here; the phone reads the same 8 bytes as BigInt
    timestampMs: Number(data.readBigUInt64BE(8)),
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    payload: data.subarray(FRAME_HEADER_SIZE),
  };
}

// ---------- JSON control messages (both directions) ----------

/** what the phone may expect to receive, gated per stream by settings */
export interface CompanionCaps {
  transcript: boolean;
  interview: boolean;
  exam: boolean;
  screenshot: boolean;
  /**
   * ⑦ remote control. A phone that predates this simply ignores the extra keys
   * and renders no control panel; the desktop refuses its commands anyway.
   */
  control: boolean;
  /** which operations `control` actually covers (master switch already on) */
  controlItems: CompanionControlItems;
}

/**
 * ⑦ The desktop's live control surface, echoed to every paired phone. The phone
 * colours its controls from this message and never from its own click, so a
 * command that was refused shows up as the switch not moving.
 */
export interface StateMessage {
  type: 'st';
  /** transcript capture running on the desktop */
  capturing: boolean;
  /** continuous answering on */
  continuous: boolean;
  richness: AnswerRichness;
  expertise: AnswerExpertise;
  /** the interview whose answers the phone is looking at */
  session: { id: string; name: string; answers: number } | null;
}

/** ⑦ one answer from this session's history, newest first */
export interface HistoryItemView {
  id: string;
  kind: string;
  /** the question it answers */
  label: string;
  text: string;
  /** prepared-answer hit this came from, so the phone can badge it */
  qaRef?: string;
  error?: string;
}

/** ⑦ answer history replay for `cmd: history` */
export interface HistoryMessage {
  type: 'hx';
  items: HistoryItemView[];
  /** how many answers the session really has, before the cap */
  total: number;
  /** items were dropped or shortened to fit the wire budget */
  truncated: boolean;
}

export type CompanionMessage =
  // phone -> bridge
  | { type: 'hello'; token: string }
  | { type: 'pair_request'; device: string }
  | { type: 'pair_confirm'; code: string }
  | { type: 'ping'; t: number }
  /** one remote command; `op` is one of six names, never a settings key */
  | { type: 'cmd'; id: string; op: ControlOp; arg?: string | boolean }
  // bridge -> phone
  | { type: 'hello_ok'; caps: CompanionCaps }
  | { type: 'pair_request_ok' }
  | { type: 'pair_ok'; token: string }
  | { type: 'pair_fail'; reason: string }
  | { type: 'pong'; t: number; pc: number }
  /** `id` set when the failure answers a `cmd`, so the phone can un-spin it */
  | { type: 'error'; reason: string; id?: string }
  /** a command was accepted and queued — the effect shows up in `st` */
  | { type: 'ack'; id: string; op: ControlOp }
  | StateMessage
  | HistoryMessage
  /** ASR engine state, so the phone can show whether words are coming at all */
  | { type: 'asr'; state: string }
  /** transient in-flight line; replaced by the next partial or by `line` */
  | { type: 'partial'; speaker: string; text: string }
  /** one finished transcript line */
  | { type: 'line'; id: number; speaker: string; text: string; ts: number }
  /** an interview answer: a = answer */
  | { type: 'a'; phase: 'qa'; id: string; question: string; answer: string; ref?: string }
  | { type: 'a'; phase: 'web'; id: string; sources: { title: string; url: string }[] }
  | { type: 'a'; phase: 'delta'; id: string; text: string }
  | { type: 'a'; phase: 'done'; id: string; text: string; ms: number }
  | { type: 'a'; phase: 'error'; id: string; message: string }
  /** an exam answer: x = 做题 */
  | { type: 'x'; phase: 'stage'; id: string; stage: string }
  | { type: 'x'; phase: 'question'; id: string; text: string; via: string }
  | { type: 'x'; phase: 'bank'; id: string; answer: string; letter?: string; ref: string; stem?: string }
  /** something the phone cannot act on but must show: ambiguous candidates etc. */
  | { type: 'x'; phase: 'note'; id: string; text: string }
  | { type: 'x'; phase: 'delta'; id: string; text: string }
  | { type: 'x'; phase: 'done'; id: string; text: string; origin: string; ms: number }
  | { type: 'x'; phase: 'error'; id: string; message: string };

export const CLOSE_INVALID_TOKEN = 4001;
export const CLOSE_HANDSHAKE_TIMEOUT = 4002;

/** Control types that prove the peer speaks this protocol. */
const CONTROL_TYPES = new Set(['hello', 'pair_request', 'pair_confirm']);

export function isControlMessage(msg: unknown): boolean {
  return (
    !!msg &&
    typeof msg === 'object' &&
    CONTROL_TYPES.has(String((msg as { type?: unknown }).type))
  );
}
