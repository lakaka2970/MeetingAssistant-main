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

/**
 * Adapters a phone on the same Wi-Fi can never reach: host-only VM NICs,
 * tunnel/VPN adapters, Bluetooth PAN, and the two Windows-generated names that
 * carry an internet connection share (Wi-Fi Direct, and `本地连接* N` /
 * `Local Area Connection* N` — note the star, because the same name without it
 * is a real Ethernet card). Matched by name because `os.networkInterfaces()`
 * gives us nothing else; the ranges that prove unreachable whatever the adapter
 * is called are handled separately by {@link isSelfAssigned}.
 */
const VIRTUAL_ADAPTER =
  /vmware|vmnet|virtualbox|vethernet|hyper-v|loopback|tap|wsl|tailscale|zerotier|wireguard|wintun|wg[0-9]|tun[0-9]|anyconnect|cisco.*vpn|pulse.*secure|juniper|globalprotect|openvpn|nordvpn|mullvad|protonvpn|expressvpn|surfshark|windscribe|checkpoint|sonicwall|sangfor|easyconnect|atrust|inode|bluetooth|蓝牙|wi-?fi direct|network bridge|网络桥|虚拟|本地连接\s*\*|local area connection\s*\*/i;

/**
 * Addresses a host was given without a DHCP server agreeing to it: link-local
 * (APIPA) and the RFC 6598 CGNAT range Tailscale-style meshes live in. Not
 * wrong, but they lose to any real lease, and a phone usually cannot route to
 * them either.
 */
function isSelfAssigned(ip: string): boolean {
  return ip.startsWith('169.254.') || /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(ip);
}

/** How long a probe answer is reused before the panel asks again. */
const PROBE_TTL_MS = 5_000;

/** An adapter that is down never fires 'connect'; do not hold the panel open. */
const PROBE_TIMEOUT_MS = 250;

export interface LanIpFacts {
  /** source address the OS picked for the default route, null when unknown */
  probed: string | null;
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export interface LanIpChoice {
  /** the address to advertise */
  ip: string;
  /** adapter it came from, or null when it is loopback */
  adapter: string | null;
  /** how it was chosen, for the log line and the diagnostics panel */
  via: 'probe' | 'enumeration' | 'self-assigned' | 'virtual' | 'none';
}

/**
 * Choose the address to advertise from what this machine looks like right now.
 *
 * A probe answer only counts when it belongs to a real (non-virtual) adapter —
 * VMware's NAT adapter can own the default route, and that address is exactly
 * as unreachable from a phone as the fallback would be.
 */
export function lanIpSource(facts: LanIpFacts): LanIpChoice {
  const real: { ip: string; name: string }[] = [];
  const selfAssigned: { ip: string; name: string }[] = [];
  const virtual: { ip: string; name: string }[] = [];
  for (const [name, list] of Object.entries(facts.interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const entry = { ip: info.address, name };
      if (VIRTUAL_ADAPTER.test(name)) virtual.push(entry);
      else if (isSelfAssigned(info.address)) selfAssigned.push(entry);
      else real.push(entry);
    }
  }
  const { probed } = facts;
  const hit = (list: { ip: string; name: string }[]) => list.find((e) => e.ip === probed);
  if (probed) {
    const onReal = hit(real);
    if (onReal) return { ip: onReal.ip, adapter: onReal.name, via: 'probe' };
  }
  if (real.length > 0) return { ip: real[0].ip, adapter: real[0].name, via: 'enumeration' };
  if (selfAssigned.length > 0)
    return {
      ip: selfAssigned[0].ip,
      adapter: selfAssigned[0].name,
      via: 'self-assigned',
    };
  if (probed) {
    const onVirtual = hit(virtual);
    if (onVirtual) return { ip: onVirtual.ip, adapter: onVirtual.name, via: 'virtual' };
  }
  if (virtual.length > 0) return { ip: virtual[0].ip, adapter: virtual[0].name, via: 'virtual' };
  return { ip: '127.0.0.1', adapter: null, via: 'none' };
}

export function pickLanIp(facts: LanIpFacts): string {
  return lanIpSource(facts).ip;
}

let probedIp: string | null = null;
let probedAt = 0;
let loggedChoice = '';

/**
 * Destinations for the source-address probe. A UDP connect sends nothing — it
 * only asks the routing table which interface a destination would leave by — so
 * one destination answers for the whole default route. Asking three costs
 * nothing and covers the machines where policy routing or a VPN sends one of
 * those destinations somewhere the phone cannot reach.
 */
const PROBE_TARGETS: readonly [number, string][] = [
  [53, '8.8.8.8'],
  [53, '223.5.5.5'],
  [53, '1.1.1.1'],
];

/**
 * Resolves with the source address, rejects when this destination told us
 * nothing — so `Promise.any` skips it and tries the next target instead of
 * accepting the first fast failure.
 */
function probeOne(port: number, host: string): Promise<string> {
  const sock = createSocket('udp4');
  return new Promise<string>((resolve, reject) => {
    const probeFailed = new Error(`no route via ${host}`);
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      if (value) resolve(value);
      else reject(probeFailed);
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
      sock.connect(port, host);
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), PROBE_TIMEOUT_MS).unref?.();
  });
}

/** First adapter the OS would route through, across {@link PROBE_TARGETS}. */
function probeSourceAddress(): Promise<string | null> {
  return Promise.any(PROBE_TARGETS.map(([port, host]) => probeOne(port, host))).catch(() => null);
}

/**
 * The address to show the user, re-probing at most once per {@link PROBE_TTL_MS}.
 * Cheap enough to await on every panel refresh, and self-healing: when the
 * cached answer leaves the interface table (Wi-Fi off, cable unplugged) it stops
 * being trusted without waiting for the next probe.
 *
 * The choice is logged whenever it changes, because every one of these paths
 * produces a URL that looks fine — "which adapter did we pick and why" is the
 * only clue that separates a working pairing from a phone that spins forever.
 */
export async function refreshLanIp(): Promise<string> {
  // "no route" is a cached answer too: without this the panel re-opened three
  // sockets every second on a machine that has no route at all.
  if (Date.now() - probedAt >= PROBE_TTL_MS) {
    probedIp = await probeSourceAddress();
    probedAt = Date.now();
  }
  const choice = lanIpSource({ probed: probedIp, interfaces: networkInterfaces() });
  const line = `${choice.ip} (${choice.adapter ?? 'no adapter'}, ${choice.via})`;
  if (line !== loggedChoice) {
    loggedChoice = line;
    console.log(`[companion] pairing address: ${line}`);
  }
  return choice.ip;
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
    // bounded match: a plain substring test lets 10.0.0.5 be satisfied by a
    // cert holding 10.0.0.55, and reuse is now decided by one address only
    const covered = (ip: string): boolean =>
      new RegExp(`IP Address:${ip.replace(/\./g, '\\.')}(?![\\d.])`).test(san);
    return ips.every((ip) => covered(ip)) && san.includes('DNS:localhost');
  } catch {
    return false;
  }
}

export interface CertRequest {
  /** every address to bake into the SAN, so a manually typed one still works */
  san: string[];
  /** the address the phone is being told to open; only this decides reuse */
  mustCover: string[];
}

/**
 * Reuse the stored key when there is one. RSA-2048 costs ~1 s on the main
 * thread, and a re-issue is exactly what happens when the lease moves — the key
 * is not what changed, so regenerating it buys nothing and stalls the meeting.
 */
function loadOrGenerateKeys(
  keyPath: string,
): { keys: { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey }; generated: boolean } {
  if (existsSync(keyPath)) {
    try {
      const privateKey = forge.pki.privateKeyFromPem(readFileSync(keyPath, 'utf8'));
      return {
        keys: { privateKey, publicKey: forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e) },
        generated: false,
      };
    } catch {
      /* unreadable or not a PEM key pair: make a fresh one below */
    }
  }
  return {
    keys: forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 }),
    generated: true,
  };
}

/**
 * Ensure a usable cert exists. Re-issued only when the address we are actually
 * advertising is not covered — an adapter appearing or disappearing (start a
 * VM, plug in a phone over USB) must not throw away the certificate every phone
 * already trusted.
 */
export function ensureCertificate(dir: string, req: CertRequest): [string, string] | null {
  const certPath = `${dir}/${CERT_FILE}`;
  const keyPath = `${dir}/${KEY_FILE}`;
  if (certCovers(certPath, req.mustCover) && existsSync(keyPath)) return [certPath, keyPath];

  try {
    const { keys, generated } = loadOrGenerateKeys(keyPath);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);
    // backdate by 5 minutes: a phone whose clock is slightly behind would
    // otherwise reject a certificate that is "not yet valid"
    cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
    cert.validity.notAfter = new Date(Date.now() + VALID_DAYS * 86_400_000);
    const sanList = [...new Set([...req.mustCover, ...req.san])];
    const subject = [{ name: 'commonName', value: sanList[0] ?? hostname() }];
    cert.setSubject(subject);
    // self-signed: issuer is the subject
    cert.setIssuer(subject);
    const altNames: { type: number; value?: string; ip?: string }[] = [
      { type: 2, value: 'localhost' },
      sanName('127.0.0.1'),
      ...sanList.map(sanName),
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
    if (generated) writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    writeFileSync(certPath, forge.pki.certificateToPem(cert), 'utf8');
    return [certPath, keyPath];
  } catch {
    return null;
  }
}
