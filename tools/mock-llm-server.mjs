/**
 * Zero-dependency OpenAI-compatible SSE mock, used to isolate the app's own
 * pipeline overhead from provider/network latency: answer with a known first-token
 * delay and a known per-chunk cadence, then subtract.
 *
 *   node tools/mock-llm-server.mjs --port=8788 --firstTokenMs=0 --chunkMs=0
 */
import { createServer } from 'http';

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};

const port = Number(arg('port', 8788));
const firstTokenMs = Number(arg('firstTokenMs', 0));
const chunkMs = Number(arg('chunkMs', 0));
const chunks = Number(arg('chunks', 12));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end('{}');
    return;
  }
  let body = '';
  for await (const c of req) body += c;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (firstTokenMs) await sleep(firstTokenMs);
  const word = '好的';
  for (let i = 0; i < chunks; i++) {
    const payload = {
      id: `mock-${i}`,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: word }, finish_reason: i === chunks - 1 ? 'stop' : null }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (chunkMs && i < chunks - 1) await sleep(chunkMs);
  }
  res.write('data: [DONE]\n\n');
  res.end();
  console.log(`[mock] streamed ${chunks} chunks (firstTokenMs=${firstTokenMs} chunkMs=${chunkMs})`);
}).listen(port, '127.0.0.1', () => console.log(`[mock] listening on http://127.0.0.1:${port}/v1`));
