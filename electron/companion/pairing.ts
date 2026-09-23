/**
 * Pairing codes and device tokens for the LAN companion bridge.
 *
 * Ported from MyTool's `pairing.py`, including its central rule: **the pairing
 * code is only ever shown on this machine**. It is never sent back to the
 * device that asked, because that would let any device on the LAN complete
 * pairing unattended. The trust anchor is physical presence — whoever pairs can
 * see the PC screen and hold the phone at the same time.
 *
 * Pure logic (fs only), no sockets, so the whole admission path is testable
 * without a network.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CODE_TTL_MS = 120_000;
export const MAX_ATTEMPTS = 5;
const TOKEN_BYTES = 32;

interface RecordedDevice {
  name: string;
  addedAt: number;
  lastSeen: number;
}

interface Pending {
  code: string;
  expiresAt: number;
  attempts: number;
}

/** Constant-time compare that tolerates mismatched lengths and non-strings. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export class PairingManager {
  private pending: Pending | null = null;
  private devices = new Map<string, RecordedDevice>();

  constructor(
    private readonly storePath: string,
    /** injectable so expiry is testable without sleeping */
    private readonly clock: () => number = Date.now,
  ) {
    this.load();
  }

  // ---- pairing ----

  /** Issue a fresh 6-digit code, invalidating any unfinished one. */
  startPairing(): string {
    // randomInt is the CSPRNG-backed uniform range; % on randomBytes would bias
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pending = { code, expiresAt: this.clock() + CODE_TTL_MS, attempts: 0 };
    return code;
  }

  /**
   * Arm pairing for a LAN-initiated request without ever rotating a live code:
   * pair_request carries no auth, so an attacker must not be able to keep
   * invalidating the code a real user is mid-entry on the PC screen.
   */
  ensurePairing(): string {
    return this.currentCode()?.code ?? this.startPairing();
  }

  /** Verify a submitted code; returns the token (persisted) or null. */
  confirm(code: string, deviceName: string): string | null {
    const pending = this.pending;
    if (!pending) return null;

    if (this.clock() >= pending.expiresAt) {
      this.pending = null;
      return null;
    }
    pending.attempts += 1;
    if (pending.attempts > MAX_ATTEMPTS) {
      this.pending = null;
      return null;
    }
    if (!safeEqual(pending.code, String(code))) return null;

    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.devices.set(token, { name: deviceName, addedAt: this.clock(), lastSeen: this.clock() });
    this.pending = null;
    this.save();
    return token;
  }

  // ---- admission ----

  /** Look up a token; on a hit, stamp lastSeen and return the device. */
  verify(token: string): RecordedDevice | null {
    if (typeof token !== 'string' || !token) return null;
    for (const [known, device] of this.devices) {
      if (safeEqual(token, known)) {
        device.lastSeen = this.clock();
        this.save();
        return device;
      }
    }
    return null;
  }

  list(): { token: string; name: string; addedAt: number; lastSeen: number }[] {
    return [...this.devices.entries()].map(([token, d]) => ({ token, ...d }));
  }

  revoke(nameOrToken: string): boolean {
    for (const [token, device] of [...this.devices]) {
      if (token === nameOrToken || safeEqual(device.name, nameOrToken)) {
        this.devices.delete(token);
        this.save();
        return true;
      }
    }
    return false;
  }

  /** The code currently awaiting entry ('' = none pending / already dead). */
  currentCode(): { code: string; expiresAt: number } | null {
    if (!this.pending) return null;
    if (this.clock() >= this.pending.expiresAt) {
      this.pending = null;
      return null;
    }
    return { code: this.pending.code, expiresAt: this.pending.expiresAt };
  }

  // ---- persistence ----

  private load(): void {
    if (!existsSync(this.storePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
    } catch {
      // An unreadable record must not stop the bridge booting; the user just
      // re-pairs. The broken file is left alone so it can be inspected.
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [token, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        // MyTool's on-disk shape: token -> name
        this.devices.set(token, { name: value, addedAt: 0, lastSeen: 0 });
      } else if (value && typeof value === 'object') {
        const d = value as Partial<RecordedDevice>;
        this.devices.set(token, {
          name: typeof d.name === 'string' ? d.name : '未知设备',
          addedAt: typeof d.addedAt === 'number' ? d.addedAt : 0,
          lastSeen: typeof d.lastSeen === 'number' ? d.lastSeen : 0,
        });
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const out: Record<string, RecordedDevice> = {};
      for (const [token, device] of this.devices) out[token] = device;
      writeFileSync(this.storePath, JSON.stringify(out, null, 2), 'utf8');
    } catch {
      // Never let a read-only profile break a live session: pairing still works
      // in memory for this run, it just will not survive a restart.
    }
  }
}
