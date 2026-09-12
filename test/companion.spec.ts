import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';

import {
  FRAME_HEADER_SIZE,
  buildFrame,
  isControlMessage,
  parseFrame,
} from '../electron/companion/protocol';
import { CODE_TTL_MS, MAX_ATTEMPTS, PairingManager } from '../electron/companion/pairing';
import { handleControlMessage } from '../electron/companion/server';
import { certCovers, ensureCertificate } from '../electron/companion/tls';

const CAPS = { transcript: true, interview: true, exam: true, screenshot: true };
const session = (): { authenticated: boolean; device: string } => ({
  authenticated: false,
  device: '',
});

// ---------- frame protocol ----------

describe('companion frame protocol', () => {
  it('keeps the header at exactly 24 bytes', () => {
    // The phone reads fixed offsets with a DataView; a header that silently
    // changes width breaks every already-paired client.
    expect(FRAME_HEADER_SIZE).toBe(24);
    const frame = buildFrame(1, 2, 3, 4, Buffer.from('x'));
    expect(frame.length).toBe(25);
  });

  it('round-trips seq, timestamp, size and payload', () => {
    const payload = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]);
    // a real epoch-ms timestamp: it does not fit in 32 bits
    const ts = 1_789_100_000_123;
    const f = parseFrame(buildFrame(42, ts, 1920, 1080, payload));
    expect(f).not.toBeNull();
    expect(f!.seq).toBe(42);
    expect(f!.timestampMs).toBe(ts);
    expect(f!.width).toBe(1920);
    expect(f!.height).toBe(1080);
    expect(Buffer.compare(f!.payload, payload)).toBe(0);
  });

  it('rejects a truncated, wrong-magic, wrong-version or non-JPEG frame', () => {
    const good = buildFrame(1, 1, 2, 3, Buffer.from('a'));
    expect(parseFrame(good.subarray(0, FRAME_HEADER_SIZE - 1))).toBeNull();

    const badMagic = Buffer.from(good);
    badMagic.write('XX', 0, 'latin1');
    expect(parseFrame(badMagic)).toBeNull();

    const badVersion = Buffer.from(good);
    badVersion.writeUInt8(9, 2);
    expect(parseFrame(badVersion)).toBeNull();

    const badFlags = Buffer.from(good);
    badFlags.writeUInt8(0, 3);
    expect(parseFrame(badFlags)).toBeNull();
  });

  it('wraps seq past uint32 instead of throwing', () => {
    // desktopCapturer keeps running for days; a throw here would kill the push
    const f = parseFrame(buildFrame(0xffffffff + 5, 1, 2, 3, Buffer.alloc(0)));
    expect(f!.seq).toBeGreaterThanOrEqual(0);
  });
});

// ---------- control-message admission ----------

describe('companion admission', () => {
  let dir: string;
  let pairing: PairingManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-pair-'));
    pairing = new PairingManager(join(dir, 'devices.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses an unknown token with 4001', () => {
    const res = handleControlMessage({ type: 'hello', token: 'nope' }, session(), pairing, CAPS);
    expect(res.closeCode).toBe(4001);
  });

  it('never sends the pairing code to the device that asked for it', () => {
    // The trust anchor is physical presence. If the code went back over the
    // socket, any device on the LAN could pair itself unattended — MyTool's E7.
    const res = handleControlMessage(
      { type: 'pair_request', device: 'iPhone' },
      session(),
      pairing,
      CAPS,
    );
    expect(res.reply).toEqual({ type: 'pair_request_ok' });
    expect(JSON.stringify(res.reply)).not.toMatch(/\d{6}/);
    // ...and the code is genuinely pending on the PC side
    expect(pairing.currentCode()?.code).toMatch(/^\d{6}$/);
  });

  it('pairs, issues a token, and admits a later hello with it', () => {
    const s1 = session();
    const code = pairing.startPairing();
    const ok = handleControlMessage({ type: 'pair_confirm', code }, s1, pairing, CAPS);
    expect(ok.reply?.type).toBe('pair_ok');
    const token = (ok.reply as { token: string }).token;
    expect(token).toHaveLength(64);

    const s2 = session();
    const hello = handleControlMessage({ type: 'hello', token }, s2, pairing, CAPS);
    expect(hello.closeCode).toBeUndefined();
    expect(s2.authenticated).toBe(true);
    expect(hello.reply?.type).toBe('hello_ok');
  });

  it('rejects a bad code and a non-string token without throwing', () => {
    pairing.startPairing();
    const bad = handleControlMessage({ type: 'pair_confirm', code: '000000x' }, session(), pairing, CAPS);
    expect(bad.reply?.type).toBe('pair_fail');
    // a remote peer may send anything: an int must not reach the comparison and throw
    expect(() =>
      handleControlMessage({ type: 'hello', token: 12345 }, session(), pairing, CAPS),
    ).not.toThrow();
    expect(handleControlMessage({ type: 'hello', token: 12345 }, session(), pairing, CAPS).closeCode).toBe(4001);
  });

  it('labels a device that skips pair_request', () => {
    // pair_confirm alone is legal over the wire; without a fallback the paired
    // list gets a blank row indistinguishable from a real name
    const code = pairing.startPairing();
    const s = session();
    const res = handleControlMessage({ type: 'pair_confirm', code }, s, pairing, CAPS);
    expect(res.reply?.type).toBe('pair_ok');
    expect(pairing.list().map((d) => d.name)).toContain('未知设备');
  });

  it('closes any other message type from an unauthenticated peer', () => {
    const res = handleControlMessage({ type: 'line', text: 'hi' }, session(), pairing, CAPS);
    expect(res.closeCode).toBe(4001);
  });

  it('answers ping before authentication, so the phone can calibrate latency', () => {
    const t = 1_789_100_000_000;
    const res = handleControlMessage({ type: 'ping', t }, session(), pairing, CAPS);
    expect(res.reply?.type).toBe('pong');
    expect((res.reply as { t: number }).t).toBe(t);
    expect(res.closeCode).toBeUndefined();
  });

  it('only treats known control types as proof of a real client', () => {
    expect(isControlMessage({ type: 'hello' })).toBe(true);
    expect(isControlMessage({ type: 'pair_request' })).toBe(true);
    // garbage from a port scan must not buy the long pairing window
    expect(isControlMessage({ type: 'line' })).toBe(false);
    expect(isControlMessage({})).toBe(false);
    expect(isControlMessage(null)).toBe(false);
    expect(isControlMessage('hello')).toBe(false);
  });
});

// ---------- pairing store ----------

describe('PairingManager', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-pair2-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('expires the code after its TTL', () => {
    let now = 1_000;
    const p = new PairingManager(join(dir, 'd.json'), () => now);
    const code = p.startPairing();
    now += CODE_TTL_MS + 1;
    expect(p.confirm(code, 'phone')).toBeNull();
    expect(p.currentCode()).toBeNull();
  });

  it('burns the code after MAX_ATTEMPTS wrong guesses', () => {
    const p = new PairingManager(join(dir, 'd.json'));
    const code = p.startPairing();
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) expect(p.confirm(wrong, 'x')).toBeNull();
    // the budget is spent: even the right code is now refused
    expect(p.confirm(code, 'x')).toBeNull();
  });

  it('persists tokens across a restart and survives a corrupt file', () => {
    const file = join(dir, 'd.json');
    const p1 = new PairingManager(file);
    const code = p1.startPairing();
    const token = p1.confirm(code, 'Pixel')!;
    const p2 = new PairingManager(file);
    expect(p2.verify(token)?.name).toBe('Pixel');

    writeFileSync(file, '{not json', 'utf8');
    const p3 = new PairingManager(file);
    expect(p3.list()).toEqual([]);
    expect(p3.verify(token)).toBeNull();
  });

  it('reads the MyTool on-disk shape (token -> name)', () => {
    const file = join(dir, 'legacy.json');
    const token = 'a'.repeat(64);
    writeFileSync(file, JSON.stringify({ [token]: '旧手机' }), 'utf8');
    const p = new PairingManager(file);
    expect(p.verify(token)?.name).toBe('旧手机');
  });

  it('revokes by name or by token', () => {
    const p = new PairingManager(join(dir, 'd.json'));
    const token = p.confirm(p.startPairing(), 'Phone A')!;
    expect(p.revoke('Phone A')).toBe(true);
    expect(p.verify(token)).toBeNull();
    const token2 = p.confirm(p.startPairing(), 'Phone B')!;
    expect(p.revoke(token2)).toBe(true);
    expect(p.list()).toHaveLength(0);
  });
});

// ---------- self-signed certificate ----------

describe('companion certificate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mc-tls-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('covers every address it was asked for and no others', () => {
    const ips = ['192.168.10.231', '10.0.0.5'];
    const made = ensureCertificate(dir, ips);
    expect(made).not.toBeNull();
    const [cert] = made!;
    expect(certCovers(cert, ips)).toBe(true);
    expect(certCovers(cert, ['192.168.10.99'])).toBe(false);
    // the SAN is built from an IP, not a hostname — a browser compares what it
    // typed and reports ERR_CERT_COMMON_NAME_INVALID otherwise
    const text = readFileSync(cert, 'utf8');
    expect(text).toContain('BEGIN CERTIFICATE');
  }, 30_000);

  it('writes IP SANs as real 4-byte addresses, not dotted strings', () => {
    // The pre-fix code passed { type: 7, value: '192.168.10.231' }. node-forge
    // only converts when `ip` is set, so it emitted a 14-byte GeneralName that
    // Chrome cannot parse — and Chrome answers NET::ERR_CERT_INVALID for that,
    // which (unlike ERR_CERT_AUTHORITY_INVALID) offers no "proceed" link at all.
    // The phone therefore could not open the page with no way past the screen.
    const ips = ['192.168.10.231', '10.0.0.5'];
    const made = ensureCertificate(dir, ips);
    expect(made).not.toBeNull();
    const san = new X509Certificate(readFileSync(made![0], 'utf8')).subjectAltName ?? '';
    expect(san).not.toMatch(/invalid/i);
    for (const ip of ips) expect(san).toContain(`IP Address:${ip}`);
    expect(san).toContain('DNS:localhost');
  }, 30_000);

  it('marks the cert as a TLS server cert, not a CA', () => {
    const made = ensureCertificate(dir, ['192.168.10.231']);
    expect(made).not.toBeNull();
    // read back with forge here: this asserts what was written, and Node's
    // keyUsage getter is unreliable (it reports ABSENT for a present extension)
    const cert = forge.pki.certificateFromPem(readFileSync(made![0], 'utf8'));
    const ku = cert.getExtension('keyUsage') as
      | { digitalSignature?: boolean; keyEncipherment?: boolean }
      | undefined;
    expect(ku).toBeTruthy();
    expect(ku!.digitalSignature).toBe(true);
    expect(ku!.keyEncipherment).toBe(true);
    expect((cert.getExtension('basicConstraints') as { cA?: boolean }).cA).toBe(false);
  }, 30_000);

  it('rejects a legacy malformed cert so it gets regenerated on next boot', () => {
    // The upgrade path: anyone who already has a pre-fix certificate on disk
    // must not be stuck with it. This also pins the reason certCovers parses
    // with Node rather than node-forge — forge reads its own broken encoding
    // back as a matching dotted string and would call the dead cert valid.
    const legacy = join(dir, 'legacy.crt');
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 86_400_000);
    const subject = [{ name: 'commonName', value: '192.168.10.231' }];
    cert.setSubject(subject);
    cert.setIssuer(subject);
    cert.setExtensions([
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, { type: 7, value: '192.168.10.231' }],
      },
      { name: 'basicConstraints', cA: false },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    writeFileSync(legacy, forge.pki.certificateToPem(cert), 'utf8');

    expect(certCovers(legacy, ['192.168.10.231'])).toBe(false);
  }, 60_000);

  it('reuses a still-valid cert instead of regenerating on every boot', () => {
    const ips = ['192.168.10.231'];
    const first = ensureCertificate(dir, ips);
    expect(first).not.toBeNull();
    const pem = readFileSync(first![0], 'utf8');
    const again = ensureCertificate(dir, ips);
    // key generation costs ~1s on the main thread, so a churn bug is a real
    // stall on every launch, not just wasted work
    expect(readFileSync(again![0], 'utf8')).toBe(pem);
  }, 30_000);

  it('treats an unparseable cert as not covering', () => {
    const bogus = join(dir, 'bogus.crt');
    writeFileSync(bogus, 'garbage', 'utf8');
    expect(certCovers(bogus, ['1.2.3.4'])).toBe(false);
    expect(certCovers(join(dir, 'missing.crt'), ['1.2.3.4'])).toBe(false);
  });
});
