/**
 * RAG pipeline smoke (upgrade P0): chunk → index → retrieve against the PURE
 * modules with a deterministic mock embedder — no electron, no model, no
 * network. Verifies the data path end-to-end and prints retrieval timing.
 *
 *   npm run smoke:rag
 *
 * (Query-embedding quality obviously needs the real bge model; use the
 * knowledge panel's 检索试玩 for the live check.)
 */
import { chunkText } from '../electron/rag/chunker';
import { VectorStore, type RagUpsert } from '../electron/rag/vector-store';

/** deterministic toy embedder: bag-of-3gram hashes → normalized 256-dim */
const DIM = 256;
function hashTo(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % DIM;
}
function embed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const t = text.toLowerCase();
  for (let i = 0; i + 2 < t.length; i++) v[hashTo(t.slice(i, i + 3), 1)] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

const RESUME = [
  '项目经历：实时会议转录系统。基于 ONNX Runtime 与 DirectML 构建 Whisper 推理管线，',
  ' encoder 在 GPU 上达到 117 毫秒，相比 CPU 提速 62 倍。负责音频采集、VAD 分段、',
  ' 流式推理与会话状态管理，端到端延迟 0.94 秒。',
  '项目经历：分布式缓存平台。设计 Redis 集群与布隆过滤器方案解决缓存穿透，',
  ' 通过热点 key 本地缓存将峰值 QPS 提升 3 倍，p99 延迟下降 45%。',
  '实习经历：负责网关限流模块，实现令牌桶与自适应限流，拦截恶意流量 99.2%。',
].join('');

const JD = [
  '岗位职责：负责高并发后端服务的设计与优化，熟悉 Redis、Kafka、分布式事务，',
  '有缓存架构、限流熔断、链路追踪经验优先。',
].join('');

const NOTES = '我擅长讲高并发优化案例，习惯先给结论再展开，面试时强调量化结果。';

const QUESTION = '讲一下你做缓存优化的项目，QPS 提升了多少？';

async function main(): Promise<void> {
  console.log('== RAG pipeline smoke ==\n');

  // 1. chunk
  const t0 = Date.now();
  const resumeChunks = chunkText(RESUME);
  const jdChunks = chunkText(JD);
  const noteChunks = chunkText(NOTES);
  console.log(`[chunk] resume=${resumeChunks.length} jd=${jdChunks.length} notes=${noteChunks.length} (${Date.now() - t0}ms)`);

  // 2. index (session-scoped material + global layers)
  const store = new VectorStore('mock-embedder');
  const sessionId = 'smoke-session';
  const ingest = (source: RagUpsert['source'], chunks: string[], sid?: string, ref?: string) => {
    for (const [i, text] of chunks.entries()) {
      store.add({ source, sessionId: sid, ref, text, metadata: { chunk_index: i }, embedding: embed(text) });
    }
  };
  ingest('resume', resumeChunks, sessionId, 'resume.pdf');
  ingest('jd', jdChunks, sessionId, 'jd.docx');
  ingest('custom_note', noteChunks, undefined, 'notes');
  console.log(`[index] ${store.size} chunks, bySource=${JSON.stringify(store.countsBySource())}`);

  // 3. retrieve (session material + global layers; facts excluded)
  const qvec = embed(QUESTION);
  const t1 = Date.now();
  const hits = store.search(qvec, { topK: 3, minScore: 0.1, sessionId, excludeSources: ['fact'] });
  const searchMs = Date.now() - t1;
  console.log(`[search] "${QUESTION}" -> ${hits.length} hits in ${searchMs}ms`);
  for (const h of hits) {
    console.log(`  ${h.score.toFixed(3)} [${h.record.source}${h.record.ref ? '|' + h.record.ref : ''}] ${h.record.text.slice(0, 60)}…`);
  }
  if (hits.length === 0) throw new Error('smoke failed: no hits');
  if (!hits.some((h) => h.record.source === 'resume')) throw new Error('smoke failed: resume not recalled');

  // 4. session isolation: another session must see only global layers
  const otherHits = store.search(qvec, { topK: 3, minScore: 0.1, sessionId: 'other' });
  if (otherHits.some((h) => h.record.source === 'resume')) {
    throw new Error('smoke failed: session material leaked across sessions');
  }
  console.log('[isolation] other session sees only global layers ✓');

  // 5. persistence round-trip
  const file = JSON.parse(
    JSON.stringify({
      version: 1,
      nextId: store.size + 1,
      modelKey: 'mock-embedder',
      records: store.allRecords(),
      vectors: Object.fromEntries(store.allRecords().map((r) => [String(r.id), Buffer.from(embed('x').buffer).toString('base64')])),
    }),
  );
  const restored = VectorStore.fromFile(file);
  if (restored.size !== store.size) throw new Error('smoke failed: persistence round-trip lost records');
  console.log('[persist] index round-trip ✓');

  console.log('\nRAG smoke PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
