/**
 * One-click knowledge-base builder: batch files/folders → structural chunks →
 * optional LLM-assisted keywords/aliases (uses the already-configured chat key;
 * no embeddings API needed) → a pre-chunked `991_index.jsonl` the lexical
 * retrieval channel consumes directly. The curated KB stays untouched on disk;
 * building binds the new index, and the existing bind button switches back.
 *
 * Chunking preserves author boundaries (## sections / numbered questions) the
 * same way tools/build-interview-kb.py does — never a blind sliding window.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { createHash } from 'crypto';

import { extractDocText, isLibraryExtension } from '../docparse';
import { walkLibraryDir } from './library';
import { chatOnce } from '../llm/adapter';
import type { ChatMessage } from '../llm/adapter';
import type { AutoKbProgress, AutoKbResult } from '../../shared/protocol';

export type { AutoKbProgress, AutoKbResult };

export interface AutoKbDeps {
  paths: string[];
  /** output root, e.g. <userData>/auto-kb */
  outRoot: string;
  /** configured chat endpoint; null = skip the assist pass */
  llm?: { baseUrl: string; model: string; apiKey: string } | null;
  onProgress?: (p: AutoKbProgress) => void;
  signal?: AbortSignal;
}

const MAX_FILES = 300;
const MAX_LLM_DOCS = 30;
const FALLBACK_CHUNK_CHARS = 1200;

export interface RawChunk {
  section: string;
  text: string;
}

const QUESTION = /^(\d+)[\.、]\s*(\S.*)$/;

function isQuestionTitle(t: string): boolean {
  if (/[。；，、：]$/.test(t)) return false;
  if (/[？?]$/.test(t)) return true;
  return /(什么|为什么|如何|怎么|哪些|区别|吗|呢|能否|是否|多少)/.test(t);
}

/** md → ## sections; extracted PDF/txt text → numbered questions; else paragraphs */
export function structuralChunks(name: string, text: string): RawChunk[] {
  const body = text.replace(/\f/g, '\n').trim();
  if (!body) return [];
  if (/\.md$|\.markdown$/i.test(name)) {
    const parts = body.split(/^(##\s+.+)$/m);
    const out: RawChunk[] = [];
    const pre = parts[0].trim();
    if (pre.length >= 80) out.push({ section: '_preamble', text: pre });
    for (let i = 1; i < parts.length - 1; i += 2) {
      const section = parts[i].replace(/^##\s+/, '').trim();
      const t = parts[i + 1].trim();
      if (t.length >= 40) out.push({ section, text: `${section}\n${t}` });
    }
    if (out.length) return out;
  }
  // numbered-question split (面试 PDF 提取文本的常见形态)
  const lines = body.split('\n');
  const qs: RawChunk[] = [];
  let cur: { section: string; body: string[] } | null = null;
  for (const ln of lines) {
    const m = QUESTION.exec(ln.trim());
    if (m && m[1] !== '0' && isQuestionTitle(m[2].trim())) {
      if (cur) qs.push({ section: cur.section, text: `${cur.section}\n${cur.body.join('\n')}`.trim() });
      cur = { section: `${m[1]}. ${m[2].trim()}`.slice(0, 80), body: [] };
    } else if (cur) {
      cur.body.push(ln);
    }
  }
  if (cur) qs.push({ section: cur.section, text: `${cur.section}\n${cur.body.join('\n')}`.trim() });
  if (qs.length >= 3) return qs;
  // fallback: paragraph groups under a char budget
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: RawChunk[] = [];
  let buf = '';
  let n = 0;
  for (const p of paras) {
    if (buf && buf.length + p.length > FALLBACK_CHUNK_CHARS) {
      out.push({ section: `片段${++n}`, text: buf });
      buf = '';
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) out.push({ section: `片段${++n}`, text: buf });
  return out;
}

export function asciiTerms(s: string): string[] {
  return s.match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? [];
}

interface LlmMeta {
  keywords: string[];
  aliases: Record<string, string[]>;
}

/** one bounded chat call per document; failures degrade to no-assist, never abort */
async function llmDocMeta(
  llm: NonNullable<AutoKbDeps['llm']>,
  title: string,
  chunks: RawChunk[],
  signal?: AbortSignal,
): Promise<LlmMeta> {
  const head = chunks.map((c) => c.section).join(' / ').slice(0, 800);
  const sample = chunks.map((c) => c.text).join('\n').slice(0, 1500);
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        `文档《${title}》的小节：${head}\n内容摘录：\n${sample}\n\n` +
        '为这份文档生成检索辅助信息，只输出一个 JSON 对象，不要其它文字：' +
        '{"keywords":["核心术语",...最多12个],"aliases":{"中文术语":["英文/缩写/同义词",...]最多8组}}',
    },
  ];
  try {
    const r = await chatOnce(llm, messages, { maxTokens: 400, temperature: 0, signal });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return { keywords: [], aliases: {} };
    const j = JSON.parse(m[0]) as { keywords?: unknown; aliases?: unknown };
    const keywords = Array.isArray(j.keywords) ? j.keywords.filter((x): x is string => typeof x === 'string').slice(0, 12) : [];
    const aliases: Record<string, string[]> = {};
    if (j.aliases && typeof j.aliases === 'object') {
      for (const [k, v] of Object.entries(j.aliases as Record<string, unknown>)) {
        if (typeof k !== 'string' || k.length < 2 || !Array.isArray(v)) continue;
        const targets = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
        if (targets.length) aliases[k.toLowerCase()] = targets;
      }
    }
    return { keywords, aliases };
  } catch {
    return { keywords: [], aliases: {} };
  }
}

function sha(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export async function buildAutoKb(deps: AutoKbDeps): Promise<AutoKbResult> {
  const dir = join(deps.outRoot, '99_元数据与检索');
  const fail = (error: string): AutoKbResult => ({ ok: false, dir: deps.outRoot, chunks: 0, docs: 0, skipped: 0, llmAssisted: false, error });
  // 1. collect files
  const files: string[] = [];
  for (const p of deps.paths) {
    try {
      if (statSync(p).isDirectory()) walkLibraryDir(p, files);
      else if (isLibraryExtension(p)) files.push(p);
    } catch {
      /* unreadable entry: skip */
    }
  }
  const unique = [...new Set(files)].slice(0, MAX_FILES);
  if (!unique.length) return fail('没有可处理的文件（支持 md/txt/docx/pdf/pptx）');

  // 2. extract + chunk
  const docs: { title: string; path: string; chunks: RawChunk[] }[] = [];
  let skipped = 0;
  for (let i = 0; i < unique.length; i++) {
    deps.onProgress?.({ done: i, total: unique.length, stage: 'extract', file: basename(unique[i]) });
    if (deps.signal?.aborted) return fail('已取消');
    try {
      const text = await extractDocText(unique[i]);
      const chunks = structuralChunks(basename(unique[i]), text);
      if (!chunks.length) {
        skipped++;
        continue;
      }
      docs.push({ title: basename(unique[i]), path: unique[i], chunks });
    } catch {
      skipped++;
    }
  }
  if (!docs.length) return fail('所有文件都未能提取出文本');

  // 3. optional LLM assist (bounded, best-effort)
  const aliases: Record<string, string[]> = {};
  const docKeywords = new Map<string, string[]>();
  let llmAssisted = false;
  if (deps.llm?.apiKey) {
    const assist = docs.slice(0, MAX_LLM_DOCS);
    for (let i = 0; i < assist.length; i++) {
      deps.onProgress?.({ done: i, total: assist.length, stage: 'llm', file: assist[i].title });
      if (deps.signal?.aborted) return fail('已取消');
      const meta = await llmDocMeta(deps.llm, assist[i].title, assist[i].chunks, deps.signal);
      if (meta.keywords.length || Object.keys(meta.aliases).length) llmAssisted = true;
      docKeywords.set(assist[i].path, meta.keywords);
      for (const [k, v] of Object.entries(meta.aliases)) {
        aliases[k] = [...new Set([...(aliases[k] ?? []), ...v])];
      }
    }
  }

  // 4. write index
  deps.onProgress?.({ done: 0, total: 1, stage: 'write' });
  const rows: string[] = [];
  let chunkCount = 0;
  docs.forEach((d, di) => {
    const docId = `AUTO-${String(di + 1).padStart(2, '0')}`;
    const kw = docKeywords.get(d.path) ?? [];
    for (const c of d.chunks) {
      const text = c.text.trim();
      const h = sha(text).slice(0, 10);
      rows.push(JSON.stringify({
        chunk_id: `${docId}-${h}`,
        doc_id: docId,
        title: d.title,
        path: d.path,
        section: c.section.slice(0, 80),
        doc_type: '自动构建',
        job_primary: '面试',
        job_secondary: [],
        layer: '通用基础层',
        domain: extname(d.path).replace('.', '') || '文档',
        scenarios: [...asciiTerms(c.section), ...kw].slice(0, 16),
        evidence: [d.path],
        priority: 'P1',
        status: 'ready',
        breadcrumb: [d.title, c.section],
        text,
        n_chars: text.length,
        hash: sha(text).slice(0, 16),
      }));
      chunkCount++;
    }
  });
  try {
    mkdirSync(join(dir, '_rag', 'index'), { recursive: true });
    writeFileSync(join(dir, '991_index.jsonl'), rows.join('\n') + '\n', 'utf8');
    writeFileSync(join(dir, '_rag', 'index', 'bm25_meta.json'), JSON.stringify({ aliases }, null, 1), 'utf8');
  } catch (e) {
    return fail(`写入索引失败：${(e as Error).message}`);
  }
  deps.onProgress?.({ done: 1, total: 1, stage: 'write' });
  return { ok: true, dir: deps.outRoot, chunks: chunkCount, docs: docs.length, skipped, llmAssisted };
}

/** true when a previously built auto index exists (UI hint) */
export function autoKbExists(outRoot: string): boolean {
  return existsSync(join(outRoot, '99_元数据与检索', '991_index.jsonl'));
}

export function readAutoKbAliases(outRoot: string): Record<string, string[]> {
  try {
    const j = JSON.parse(readFileSync(join(outRoot, '99_元数据与检索', '_rag', 'index', 'bm25_meta.json'), 'utf8')) as { aliases?: Record<string, string[]> };
    return j.aliases ?? {};
  } catch {
    return {};
  }
}