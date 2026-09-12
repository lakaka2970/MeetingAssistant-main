/**
 * HTTP + WebSocket endpoint for the LAN companion bridge.
 *
 * Deliberately ignorant of what it is carrying: it knows transcripts and
 * screenshots only as "a JSON message" and "a byte frame". That boundary is
 * inherited from MyTool — capture and server never meet there either, and it is
 * what keeps a slow phone from ever being able to stall transcription.
 *
 * Same here: nothing in this file may block on the desktop UI, and a client
 * that cannot keep up is skipped, never awaited.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  CLOSE_HANDSHAKE_TIMEOUT,
  CLOSE_INVALID_TOKEN,
  isControlMessage,
  type CompanionCaps,
  type CompanionMessage,
} from './protocol';
import type { PairingManager } from './pairing';

/** A phone that connected but never spoke our protocol gets cut off this fast. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * Once a peer proves it is a real client, allow long enough to read a 6-digit
 * code off the PC and type it on glass. 15 s would make pairing look broken.
 */
export const PAIRING_TIMEOUT_MS = 150_000;
/** keepalive interval; also the liveness probe that reaps dead sockets */
const HEARTBEAT_MS = 20_000;
/**
 * A phone whose send queue holds this much has already fallen behind — Wi-Fi
 * roam, backgrounded tab, weak signal. Pushing more only grows the lag, so
 * coalescible traffic is dropped instead. ~6 screenshots' worth.
 */
const MAX_BUFFERED = 512 * 1024;

export interface ClientView {
  authenticated: boolean;
  device: string;
  online: boolean;
}

interface Client {
  ws: WebSocket;
  authenticated: boolean;
  engaged: boolean;
  device: string;
  alive: boolean;
  timer: NodeJS.Timeout | null;
  /** when the last ping went out, so the pong can be turned into an RTT */
  pingAt: number;
}

/**
 * Decide what to do with one control message. Pure: no socket, no timers — so
 * the entire admission path is unit-testable.
 */
export function handleControlMessage(
  msg: unknown,
  session: { authenticated: boolean; device: string },
  pairing: PairingManager,
  caps: CompanionCaps,
): { reply?: CompanionMessage; closeCode?: number } {
  if (!msg || typeof msg !== 'object') return { reply: { type: 'error', reason: 'malformed' } };
  const kind = String((msg as { type?: unknown }).type ?? '');

  if (kind === 'hello') {
    // String() at the boundary: a non-string token must be rejected, not
    // reach the compare and throw there.
    const device = pairing.verify(String((msg as { token?: unknown }).token ?? ''));
    if (!device) return { closeCode: CLOSE_INVALID_TOKEN };
    session.authenticated = true;
    session.device = device.name;
    return { reply: { type: 'hello_ok', caps } };
  }

  if (kind === 'pair_request') {
    session.device = String((msg as { device?: unknown }).device || '未知设备');
    // The code goes to the PC only (log + settings panel). Echoing it here
    // would let any LAN device pair itself.
    pairing.startPairing();
    return { reply: { type: 'pair_request_ok' } };
  }

  if (kind === 'pair_confirm') {
    // A client may send pair_confirm without ever sending pair_request, in which
    // case there is no label — record something, or the device list shows a
    // blank row the user cannot tell apart from a real name.
    const token = pairing.confirm(
      String((msg as { code?: unknown }).code ?? ''),
      session.device || '未知设备',
    );
    if (!token) return { reply: { type: 'pair_fail', reason: 'bad_code' } };
    session.authenticated = true;
    return { reply: { type: 'pair_ok', token } };
  }

  if (kind === 'ping') {
    // Echo the client's own timestamp with our wall clock so it can estimate
    // clock skew. Without this, "latency" measured against a frame header is
    // really the offset between two unsynchronised machines — MyTool measured
    // a bogus 906 ms this way where the true cost was ~71 ms.
    // Stateless and leaks nothing, so it is allowed pre-auth.
    return {
      reply: { type: 'pong', t: Number((msg as { t?: unknown }).t ?? 0), pc: Date.now() },
    };
  }

  if (!session.authenticated) return { closeCode: CLOSE_INVALID_TOKEN };
  return { reply: { type: 'error', reason: `unknown_type:${kind}` } };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export interface CompanionServerOptions {
  pairing: PairingManager;
  caps: CompanionCaps;
  /** directory holding index.html / app.js / markdown.js */
  assetsDir: string;
  /** absolute path to node_modules/katex/dist, for typesetting math on the phone */
  katexDir?: string;
  host?: string;
  port?: number;
  portFallback?: number;
  /** PEM cert/key; when both are absent the bridge serves plaintext http */
  tls?: { cert: string; key: string };
  onPairingCode?: (code: string) => void;
  /**
   * Fired the moment a device completes authentication. The connect window
   * closes itself on it: its only job was to get a phone onto this network,
   * and leaving a QR on screen afterwards is what people share on screen.
   */
  onAuthenticated?: () => void;
}

export class CompanionServer {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Client[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private beat = 0;
  private _port: number;
  private sentEvents = 0;
  private droppedEvents = 0;
  /** recent WebSocket ping/pong round trips in ms (half of it is the wire) */
  private rtts: number[] = [];
  /** most recent authenticated handshake time per device name */
  private lastSeen = new Map<string, number>();

  constructor(private readonly opts: CompanionServerOptions) {
    this._port = opts.port ?? 18765;
  }

  get port(): number {
    return this._port;
  }
  get https(): boolean {
    return !!this.opts.tls;
  }
  get authenticatedCount(): number {
    return this.clients.filter((c) => c.authenticated).length;
  }
  get connectionCount(): number {
    return this.clients.length;
  }
  get stats(): { sentEvents: number; droppedEvents: number } {
    return { sentEvents: this.sentEvents, droppedEvents: this.droppedEvents };
  }
  /**
   * Mean one-way wire latency (RTT/2) over the last few keepalive probes, or -1
   * when nothing has answered yet. This is the number that tells the user
   * whether the phone is lagging because of the network or because of the model.
   */
  get lagMs(): number {
    const live = this.rtts.slice(-6);
    if (!live.length) return -1;
    return Math.round(live.reduce((a, b) => a + b, 0) / live.length / 2);
  }
  get views(): ClientView[] {
    return this.clients
      .filter((c) => c.authenticated)
      .map((c) => ({ authenticated: true, device: c.device, online: true }));
  }

  seen(name: string): number {
    return this.lastSeen.get(name) ?? 0;
  }

  async start(): Promise<void> {
    const base = this.opts.port ?? 18765;
    const fallback = this.opts.portFallback ?? 5;
    let lastError: unknown = null;
    for (let offset = 0; offset <= fallback; offset += 1) {
      const candidate = base + offset;
      try {
        await this.bind(candidate);
        this._port = candidate;
        this.startHeartbeat();
        return;
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(
      `端口 ${base}–${base + fallback} 均被占用（${(lastError as Error)?.message ?? '未知原因'}）`,
    );
  }

  private bind(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.opts.tls
        ? createHttpsServer(
            { cert: readFileSync(this.opts.tls.cert), key: readFileSync(this.opts.tls.key) },
            (req, res) => this.route(req, res),
          )
        : createHttpServer((req, res) => this.route(req, res));

      server.once('error', (e) => {
        server.close();
        reject(e);
      });
      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = (req.url ?? '/').split('?')[0];
        if (path !== '/ws') {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
      });
      server.listen(port, this.opts.host ?? '0.0.0.0', () => {
        server.removeListener('error', reject);
        this.server = server;
        this.wss = wss;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) {
      if (c.timer) clearTimeout(c.timer);
      try {
        c.ws.terminate();
      } catch {
        /* already gone */
      }
    }
    this.clients = [];
    await new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.closeAllConnections?.();
      this.server.close(() => r());
      // an idle keep-alive socket would otherwise hold close() open forever
      setTimeout(r, 500).unref();
    });
    this.server = null;
    this.wss = null;
  }

  /**
   * Send to every authenticated phone. A client that is behind is skipped
   * rather than queued, because every message on this channel is either
   * idempotent (a full line, a final answer) or superseded by the next one
   * (partials, deltas). Returning the delivery count lets the caller log
   * "nothing was sent" without guessing.
   */
  private sendEach(data: string | Buffer, coalescible: boolean): number {
    const targets = this.clients.filter((c) => c.authenticated);
    if (!targets.length) return 0;
    let sent = 0;
    for (const c of targets) {
      if (coalescible && c.ws.bufferedAmount > MAX_BUFFERED) {
        this.droppedEvents += 1;
        continue;
      }
      try {
        c.ws.send(data);
        sent += 1;
      } catch {
        this.drop(c);
      }
    }
    this.sentEvents += sent;
    return sent;
  }

  broadcastJson(msg: CompanionMessage): number {
    return this.sendEach(JSON.stringify(msg), false);
  }

  /** Partials and streamed deltas: droppable when a phone falls behind. */
  broadcastLossy(msg: CompanionMessage): number {
    return this.sendEach(JSON.stringify(msg), true);
  }

  broadcastFrame(frame: Buffer): number {
    return this.sendEach(frame, true);
  }

  // ---- wiring ----

  private accept(ws: WebSocket): void {
    const client: Client = {
      ws,
      authenticated: false,
      engaged: false,
      device: '',
      alive: true,
      pingAt: 0,
      timer: setTimeout(() => {
        try {
          ws.close(CLOSE_HANDSHAKE_TIMEOUT, 'handshake timeout');
        } catch {
          ws.terminate();
        }
      }, HANDSHAKE_TIMEOUT_MS),
    };
    this.clients.push(client);

    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return; // the phone never uploads
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        this.send(ws, JSON.stringify({ type: 'error', reason: 'bad_json' }));
        return;
      }
      if (isControlMessage(parsed)) {
        client.engaged = true;
        this.rearm(client);
      }
      const session = { authenticated: client.authenticated, device: client.device };
      const { reply, closeCode } = handleControlMessage(parsed, session, this.opts.pairing, this.opts.caps);
      const justAuthenticated = !client.authenticated && session.authenticated;
      client.authenticated = session.authenticated;
      client.device = session.device;
      if (reply) this.send(ws, JSON.stringify(reply));
      if (justAuthenticated) this.opts.onAuthenticated?.();
      if (reply?.type === 'pair_request_ok') {
        const pending = this.opts.pairing.currentCode();
        if (pending) this.opts.onPairingCode?.(pending.code);
      }
      if (closeCode !== undefined) {
        try {
          ws.close(closeCode);
        } catch {
          ws.terminate();
        }
        return;
      }
      if (client.authenticated) this.rearm(client);
    });

    ws.on('pong', () => {
      client.alive = true;
      if (client.pingAt) {
        const rtt = Date.now() - client.pingAt;
        client.pingAt = 0;
        if (rtt >= 0 && rtt < 60_000) {
          this.rtts.push(rtt);
          if (this.rtts.length > 12) this.rtts.shift();
        }
      }
    });
    ws.on('close', () => this.drop(client));
    ws.on('error', () => this.drop(client));
  }

  /**
   * Replace the short handshake timer: unauthenticated but engaged means a
   * human is typing a code, which needs minutes, not seconds. Authenticated
   * means no idle timer at all — the heartbeat reaps what is actually dead.
   */
  private rearm(client: Client): void {
    if (client.timer) clearTimeout(client.timer);
    client.timer = client.authenticated
      ? null
      : setTimeout(() => {
          try {
            client.ws.close(CLOSE_HANDSHAKE_TIMEOUT, 'pairing timeout');
          } catch {
            client.ws.terminate();
          }
        }, PAIRING_TIMEOUT_MS);
    if (client.authenticated && client.device) {
      this.lastSeen.set(client.device, Date.now());
    }
  }

  private drop(client: Client): void {
    const at = this.clients.indexOf(client);
    if (at >= 0) this.clients.splice(at, 1);
    if (client.timer) clearTimeout(client.timer);
    client.timer = null;
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      this.beat += 1;
      for (const c of this.clients) {
        if (!c.alive) {
          try {
            c.ws.terminate();
          } catch {
            this.drop(c);
          }
          continue;
        }
        c.alive = false;
        try {
          c.pingAt = Date.now();
          c.ws.ping(String(this.beat));
        } catch {
          this.drop(c);
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private send(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      /* socket already dying; the close handler cleans up */
    }
  }

  // ---- static routes ----

  private route(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];
    const serve = (body: Buffer | string, type: string, download?: string) => {
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        ...(download ? { 'Content-Disposition': `attachment; filename="${download}"` } : {}),
      });
      res.end(body);
    };
    const missing = () => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    };

    try {
      if (path === '/' || path === '/index.html') {
        const file = join(this.opts.assetsDir, 'index.html');
        if (!existsSync(file)) return missing();
        return serve(readFileSync(file, 'utf8'), MIME['.html'] as string);
      }
      if (path === '/app.js' || path === '/markdown.js') {
        const file = join(this.opts.assetsDir, path.slice(1));
        if (!existsSync(file)) return missing();
        return serve(readFileSync(file, 'utf8'), MIME['.js'] as string);
      }
      if (path === '/server.crt') {
        // The cert is public material — handing it out lets the phone install
        // it and drop the warning for good. The key is never routed here.
        if (!this.opts.tls || !existsSync(this.opts.tls.cert)) return missing();
        return serve(readFileSync(this.opts.tls.cert), 'application/x-x509-ca-cert', 'MeetingAssistant.crt');
      }
      if (path.startsWith('/vendor/katex/') && this.opts.katexDir) {
        // Math on the phone's answers is not optional: 数量关系 and technical
        // questions come back in $…$ and raw LaTeX is unreadable on 5 inches.
        const rel = path.slice('/vendor/katex/'.length);
        if (/[\\]|\.\./.test(rel)) return missing();
        const file = join(this.opts.katexDir, rel);
        if (!file.startsWith(this.opts.katexDir) || !existsSync(file)) return missing();
        const ext = extname(file).toLowerCase();
        return serve(readFileSync(file), MIME[ext] ?? 'application/octet-stream');
      }
      return missing();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`server error: ${(e as Error).message}`);
    }
  }
}
