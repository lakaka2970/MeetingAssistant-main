/**
 * End-to-end tests over a real socket and a real HTTP port.
 *
 * The unit tests in companion.spec.ts cover the decisions; this covers the
 * plumbing, which is where "the phone shows a blank page" and "it pairs but
 * never receives" actually live: the route table, the file paths the page is
 * served from, the upgrade handling, and the auth state machine wired to the
 * transport.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

import { CompanionServer } from '../electron/companion/server';
import { PairingManager } from '../electron/companion/pairing';
import { FRAME_HEADER_SIZE, buildFrame, parseFrame } from '../electron/companion/protocol';

const CAPS = { transcript: true, interview: true, exam: true, screenshot: true };
/** the same directory the main process uses, so a renamed asset fails here */
const ASSETS = join(__dirname, '..', 'resources', 'companion');
/** same resolution rule as CompanionBridge.katexDir (a directory is not a valid subpath) */
const KATEX = dirname(require.resolve('katex/dist/katex.min.js'));
// a port high enough to avoid the well-known range, with the real fallback in
// place so a busy machine still starts rather than failing the suite
const PORT = 18901;

let dir: string;
let server: CompanionServer;
let pairing: PairingManager;

const open = (path = '/ws'): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

/** next JSON control message, or null if the socket closed first */
function nextJson(ws: WebSocket): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const done = (value: Record<string, unknown> | null): void => {
      ws.off('message', onMsg);
      ws.off('close', onClose);
      resolve(value);
    };
    const onMsg = (data: Buffer, isBinary: boolean): void => {
      if (isBinary) return;
      try {
        done(JSON.parse(String(data)));
      } catch {
        done(null);
      }
    };
    const onClose = (code: number): void => {
      const value = { type: '__closed__', code };
      done(value as unknown as Record<string, unknown>);
    };
    ws.on('message', onMsg);
    ws.once('close', onClose);
  });
}

function closedCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
  });
}

/** the ws *client* close() is fire-and-forget; await the close event itself */
function shut(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
    setTimeout(resolve, 1000).unref?.();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mc-bridge-'));
  pairing = new PairingManager(join(dir, 'devices.json'));
  server = new CompanionServer({
    pairing,
    caps: CAPS,
    assetsDir: ASSETS,
    katexDir: KATEX,
    port: PORT,
    portFallback: 8,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('companion bridge over the wire', () => {
  it('binds the configured port and reports it', () => {
    // the QR encodes this value; a stale configured port points the phone at
    // nothing while still looking correct
    expect(server.port).toBeGreaterThanOrEqual(PORT);
  });

  it('serves the phone page and both scripts', async () => {
    for (const [path, needle] of [
      ['/', 'id="hero"'],
      ['/app.js', 'renderMarkdown'],
      ['/markdown.js', 'window.renderMarkdown = renderMarkdown'],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(needle);
    }
  });

  it('serves KaTeX so answers typeset on the phone', async () => {
    // optional in principle, but if this 404s the phone silently loses all math
    for (const path of ['/vendor/katex/katex.min.css', '/vendor/katex/katex.min.js']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status).toBe(200);
    }
  });

  it('refuses to serve anything outside its asset directory', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/vendor/katex/../../package.json`,
    );
    expect([404, 400]).toContain(res.status);
  });

  it('rejects an unpaired hello with 4001', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'hello', token: 'deadbeef' }));
    expect(await closedCode(ws)).toBe(4001);
  });

  it('walks pairing -> token -> hello -> broadcast', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'pair_request', device: '测试手机' }));
    const ack = await nextJson(ws);
    expect(ack?.type).toBe('pair_request_ok');
    // the code exists on the PC and only on the PC
    const pending = pairing.currentCode();
    expect(pending?.code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(ack)).not.toContain(pending!.code);

    ws.send(JSON.stringify({ type: 'pair_confirm', code: pending!.code }));
    const ok = await nextJson(ws);
    expect(ok?.type).toBe('pair_ok');
    const token = String(ok!.token);
    await shut(ws);

    // reconnect with the token, exactly like the phone does
    const ws2 = await open();
    ws2.send(JSON.stringify({ type: 'hello', token }));
    const hello = await nextJson(ws2);
    expect(hello?.type).toBe('hello_ok');
    expect(hello!.caps).toEqual(CAPS);
    expect(server.authenticatedCount).toBe(1);

    const got = nextJson(ws2);
    expect(server.broadcastJson({ type: 'line', id: 7, speaker: 'them', text: '你好', ts: Date.now() })).toBe(1);
    const msg = await got;
    expect(msg).toMatchObject({ type: 'line', id: 7, text: '你好' });

    // binary frames arrive with an intact 24-byte header
    const binary = new Promise<Buffer | null>((resolve) => {
      const onMsg = (data: Buffer, isBinary: boolean): void => {
        if (!isBinary) return;
        ws2.off('message', onMsg);
        resolve(Buffer.from(data));
      };
      ws2.on('message', onMsg);
      setTimeout(() => resolve(null), 2000);
    });
    const frame = buildFrame(9, Date.now(), 1920, 1080, Buffer.from([0xff, 0xd8, 0x01]));
    server.broadcastFrame(frame);
    const gotFrame = await binary;
    expect(gotFrame).not.toBeNull();
    expect(gotFrame!.length).toBe(frame.length);
    expect(parseFrame(gotFrame!)?.seq).toBe(9);
    expect(gotFrame!.subarray(FRAME_HEADER_SIZE)).toEqual(Buffer.from([0xff, 0xd8, 0x01]));

    await shut(ws2);
  });

  it('answers ping without credentials so latency stays measurable', async () => {
    const ws = await open();
    const t = Date.now();
    ws.send(JSON.stringify({ type: 'ping', t }));
    const pong = await nextJson(ws);
    expect(pong?.type).toBe('pong');
    expect(pong?.t).toBe(t);
    expect(typeof pong?.pc).toBe('number');
    await shut(ws);
  });

  it('counts an authenticated client but not a pending one', async () => {
    // "connections but zero authenticated" and "no connections at all" send the
    // user to completely different troubleshooting, so both must be observable
    const ws = await open();
    expect(server.connectionCount).toBeGreaterThan(server.authenticatedCount);
    await shut(ws);
  });
});
