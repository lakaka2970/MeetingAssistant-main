/**
 * Self-signed TLS for the companion bridge, plus LAN address discovery.
 *
 * Why bother with HTTPS on a private network: the phone's Screen Wake Lock API
 * only exists in a secure context, so over plain http:// the screen dims
 * mid-meeting and the display goes blank. It also encrypts the LAN hop.
 *
 * Read the residual risk honestly: a self-signed cert has no CA validation, so
 * it stops passive sniffing but not an active man-in-the-middle. Better than
 * plaintext, not equivalent to real HTTPS.
 *
 * Cert generation must never be fatal — returning null makes the bridge fall
 * back to plaintext instead of failing to start.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import * as forge from 'node-forge';

export const CERT_FILE = 'companion-server.crt';
export const KEY_FILE = 'companion-server.key';
const VALID_DAYS = 365;

/**
 * The address the phone should be pointed at.
 *
 * Two facts drove this design, both measured rather than assumed:
 *
 *  - A UDP "connect" asks the OS which source address the default route would
 *    use, but in Node 24 (Electron 41) reading `socket.address()` synchronously
 *    right after `connect()` throws EBADF. The answer only exists on the
 *    'connect' event, so the probe is asynchronous and cached.
 *  - `os.networkInterfaces()` enumerates VMware's host-only adapters before the
 *    Wi-Fi card. Advertising "the first address on this machine" therefore
 *    pointed phones at 192.168.182.1, which no device on the WLAN can reach —
 *    and it did so silently, because the URL looked perfectly plausible.
 */

/** Adapters a phone on the same Wi-Fi can never reach. */
const VIRTUAL_ADAPTER = /vmware|vmnet|virtualbox|vethernet|hyper-v|loopback|tap|wsl/i;

/** How long a probe answer is reused before the panel asks again. */
const PROBE_TTL_MS = 5_000;

/** An adapter that is down never fires 'connect'; do not hold the panel open. */
const PROBE_TIMEOUT_MS = 250;

export interface LanIpFacts {
  /** source address the OS picked for the default route, null when unknown */
  probed: string | null;
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/**
 * Choose the address to advertise from what this machine looks like right now.
 * A probe answer only counts when it belongs to a real (non-virtual) adapter —
 * VMware's NAT adapter can own the default route, and that address is exactly
 * as unreachable from a phone as the fallback would be.
 */
export function pickLanIp(facts: LanIpFacts): string {
  const real: string[] = [];
  const linkLocal: string[] = [];
  const virtual: string[] = [];
  for (const [name, list] of Object.entries(facts.interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (VIRTUAL_ADAPTER.test(name)) virtual.push(info.address);
      else if (info.address.startsWith('169.254.')) linkLocal.push(info.address);
      else real.push(info.address);
    }
  }
  const { probed } = facts;
  if (probed && real.includes(probed)) return probed;
  if (real.length > 0) return real[0];
  if (linkLocal.length > 0) return linkLocal[0];
  if (probed && virtual.includes(probed)) return probed;
  return virtual[0] ?? '127.0.0.1';
}

let probedIp: string | null = null;
let probedAt = 0;

function probeSourceAddress(): Promise<string | null> {
  const sock = createSocket('udp4');
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    sock.once('connect', () => {
      try {
        const bound = sock.address() as AddressInfo;
        finish(bound?.address && bound.address !== '0.0.0.0' ? bound.address : null);
      } catch {
        finish(null);
      }
    });
    sock.once('error', () => finish(null));
    try {
      sock.connect(53, '8.8.8.8');
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), PROBE_TIMEOUT_MS).unref?.();
  });
}

/**
 * The address to show the user, re-probing at most once per {@link PROBE_TTL_MS}.
 * Cheap enough to await on every panel refresh, and self-healing: when the
 * cached answer leaves the interface table (Wi-Fi off, cable unplugged) it stops
 * being trusted without waiting for the next probe.
 */
export async function refreshLanIp(): Promise<string> {
  if (probedIp === null || Date.now() - probedAt >= PROBE_TTL_MS) {
    probedIp = await probeSourceAddress();
    probedAt = Date.now();
  }
  return pickLanIp({ probed: probedIp, interfaces: networkInterfaces() });
}

/** Every non-internal IPv4 on this machine — all of them go into the SAN. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && !out.includes(info.address)) {
        out.push(info.address);
      }
    }
  }
  return out;
}

/** True when `ip` is one of this machine's own addresses (loopback included). */
export function isLocalAddress(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === 'localhost' ||
    lanAddresses().includes(ip)
  );
}

/**
 * Build one SAN entry.
 *
 * IP addresses MUST go in as `{ type: 7, ip }`, not `{ type: 7, value }`.
 * node-forge only runs `bytesFromIP()` when `ip` is present; with just `value`
 * it writes the dotted string verbatim into the GeneralName, producing a
 * 14-byte "IP Address" instead of a 4-byte one. Chrome cannot parse that and
 * answers **NET::ERR_CERT_INVALID — which, unlike ERR_CERT_AUTHORITY_INVALID,
 * has no "Advanced → proceed" escape at all**, so the phone simply cannot open
 * the page. Verified against Node's own X509 parser (tools/cert-inspect.ts).
 */
function sanName(value: string): { type: number; value?: string; ip?: string } {
  return isIpv4(value) ? { type: 7, ip: value, value } : { type: 2, value };
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
  );
}

/**
 * Whether the stored cert still covers every current LAN address.
 *
 * "The cert exists" is not "the cert works": browsers validate the IP they
 * typed against the SAN, so after a DHCP lease moves, the old cert produces an
 * error the user cannot interpret. Any parse failure counts as "does not cover"
 * so the caller regenerates.
 *
 * Parsed with Node's own X509 implementation, deliberately NOT with node-forge:
 * a pre-fix certificate wrote IP SANs as a 14-character dotted string instead
 * of 4 bytes, and node-forge reads its own broken encoding straight back as the
 * matching string — so validating with the same library that produced the bug
 * reports a dead cert as fine. Node renders the malformed entry as
 * `IP Address:<invalid length=14>`, which is exactly the signal needed to force
 * a regeneration.
 */
export function certCovers(certPath: string, ips: string[]): boolean {
  if (!existsSync(certPath)) return false;
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    const now = new Date();
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) <= now) return false;
    const san = cert.subjectAltName ?? '';
    // malformed by construction (the pre-fix encoding) — must be replaced
    if (/invalid/i.test(san)) return false;
    return ips.every((ip) => san.includes(`IP Address:${ip}`)) && san.includes('DNS:localhost');
  } catch {
    return false;
  }
}

/**
 * Ensure a usable cert exists covering `ips`, regenerating when the addresses
 * moved. Returns [certPath, keyPath], or null when HTTPS is unavailable.
 */
export function ensureCertificate(dir: string, ips: string[]): [string, string] | null {
  const certPath = `${dir}/${CERT_FILE}`;
  const keyPath = `${dir}/${KEY_FILE}`;
  if (certCovers(certPath, ips) && existsSync(keyPath)) return [certPath, keyPath];

  try {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);
    // backdate by 5 minutes: a phone whose clock is slightly behind would
    // otherwise reject a certificate that is "not yet valid"
    cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
    cert.validity.notAfter = new Date(Date.now() + VALID_DAYS * 86_400_000);
    const subject = [{ name: 'commonName', value: ips[0] ?? hostname() }];
    cert.setSubject(subject);
    // self-signed: issuer is the subject
    cert.setIssuer(subject);
    const altNames: { type: number; value?: string; ip?: string }[] = [
      { type: 2, value: 'localhost' },
      sanName('127.0.0.1'),
      ...ips.map(sanName),
    ];
    const host = hostname();
    if (host) altNames.push({ type: 2, value: host });
    cert.setExtensions([
      { name: 'subjectAltName', altNames },
      // Chrome wants a TLS-server-shaped certificate, not a bare key pair with
      // a name on it: digitalSignature + keyEncipherment, and explicitly not a
      // CA. Missing these is a plausible contributor to a hard cert rejection.
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'basicConstraints', cA: false },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    mkdirSync(dir, { recursive: true });
    writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    writeFileSync(certPath, forge.pki.certificateToPem(cert), 'utf8');
    return [certPath, keyPath];
  } catch {
    return null;
  }
}
