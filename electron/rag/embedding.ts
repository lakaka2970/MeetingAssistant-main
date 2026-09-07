/**
 * Embedding model registry re-export + main/worker-only helpers.
 * The shared pure-data registry lives in shared/embeddingModels.ts so the
 * renderer can read it; this module adds the node-flavoured wire format and
 * the cloud (zhipu) fallback used by the main process.
 */
import { getEmbeddingModel as getSharedModel } from '../../shared/embeddingModels';
import type { EmbeddingModelDescriptor } from '../../shared/embeddingModels';
export { EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL } from '../../shared/embeddingModels';
export type { EmbeddingModelDescriptor } from '../../shared/embeddingModels';

export function getEmbeddingModel(key: string | undefined): EmbeddingModelDescriptor {
  return getSharedModel(key);
}

// ---------- vector wire format (base64 float32) ----------

export function vectorToB64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

export function vectorFromB64(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------- cloud embedding (zhipu embedding-3) ----------

export interface CloudEmbedResult {
  embedding: Float32Array;
  dim: number;
  latencyMs: number;
}

/**
 * 智谱 embedding-3 via the OpenAI-compatible embeddings endpoint. Kept as the
 * cloud fallback for machines that cannot afford the local model download.
 * `dimensions` pins the output to 1024 so a cloud-embedded index stays
 * compatible with the bge-m3 descriptor.
 */
export async function cloudEmbed(
  texts: string[],
  opts: { apiKey: string; baseUrl?: string; model?: string; signal?: AbortSignal },
): Promise<CloudEmbedResult[]> {
  const t0 = Date.now();
  const base = (opts.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? 'embedding-3',
      input: texts,
      dimensions: 1024,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`cloud embed HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
  const rows = j.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(`cloud embed returned ${rows.length} rows for ${texts.length} inputs`);
  }
  const latencyMs = Date.now() - t0;
  return rows.map((r) => ({
    embedding: new Float32Array(r.embedding),
    dim: r.embedding.length,
    latencyMs,
  }));
}
