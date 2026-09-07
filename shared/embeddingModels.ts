/**
 * Embedding model registry (upgrade P0): shared pure data so the renderer
 * (knowledge panel) and the main-process embed worker read ONE source of
 * truth. No node/electron imports.
 *
 * Pooling is CLS for the BGE family (matching the official
 * sentence-transformers usage); outputs are L2-normalised so cosine == dot.
 */

export interface EmbeddingModelDescriptor {
  /** settings-facing stable key, persisted in rag.index.json */
  key: string;
  /** HuggingFace repo id (also the on-disk cache directory name) */
  hfId: string;
  dim: number;
  pooling: 'cls' | 'mean';
  /** dtype for the ONNX graph (transformers.js v3 pipeline option) */
  dtype: 'q8' | 'fp32';
  /** UI hint: approximate on-disk size, so the download prompt is honest */
  sizeHintMb: number;
  labelZh: string;
  labelEn: string;
}

export const DEFAULT_EMBEDDING_MODEL = 'bge-m3';

export const EMBEDDING_MODELS: Record<string, EmbeddingModelDescriptor> = {
  'bge-m3': {
    key: 'bge-m3',
    hfId: 'Xenova/bge-m3',
    dim: 1024,
    pooling: 'cls',
    dtype: 'q8',
    sizeHintMb: 620,
    labelZh: 'BGE-M3（多语·质量优先）',
    labelEn: 'BGE-M3 (multilingual · quality)',
  },
  // light alternative: 24 MB q8, 512-dim — one click away in settings
  'bge-small-zh-v1.5': {
    key: 'bge-small-zh-v1.5',
    hfId: 'Xenova/bge-small-zh-v1.5',
    dim: 512,
    pooling: 'cls',
    dtype: 'q8',
    sizeHintMb: 24,
    labelZh: 'BGE-small-zh（轻量·24MB）',
    labelEn: 'BGE-small-zh (light · 24MB)',
  },
};

export function getEmbeddingModel(key: string | undefined): EmbeddingModelDescriptor {
  return EMBEDDING_MODELS[key ?? ''] ?? EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL];
}
