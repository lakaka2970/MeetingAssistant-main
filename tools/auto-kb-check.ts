/**
 * Headless check of the one-click KB pipeline (no Electron, no GUI):
 *   npx vite-node tools/auto-kb-check.ts -- <fileOrDir> [outRoot]
 * Extracts + structural-chunks the given paths and writes a 991_index.jsonl,
 * then re-parses it with the app's own loader. LLM assist is off here (the
 * chat-key pass runs in-app); this verifies the deterministic pipeline.
 */
import { readFileSync } from 'fs';
import { buildAutoKb } from '../electron/rag/autoKb';
import { parseKbIndex } from '../electron/rag/kbIndex';

const target = process.argv[2];
const outRoot = process.argv[3] ?? '/tmp/auto-kb-test';
if (!target) {
  console.error('usage: npx vite-node tools/auto-kb-check.ts -- <fileOrDir> [outRoot]');
  process.exit(1);
}
const r = await buildAutoKb({ paths: [target], outRoot, llm: null });
console.log('[result]', JSON.stringify(r));
if (r.ok) {
  const rep = parseKbIndex(readFileSync(`${r.dir}/99_元数据与检索/991_index.jsonl`, 'utf8'));
  console.log(`[parse] ${rep.chunks.length} chunks, ${rep.docs} docs, skipped lines: ${rep.skipped}`);
  process.exit(rep.chunks.length > 0 && rep.skipped === 0 ? 0 : 1);
}
process.exit(1);