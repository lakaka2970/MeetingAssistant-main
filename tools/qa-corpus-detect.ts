/**
 * Run the REAL detector (shared/qaPairs.ts) over a directory of prep notes and
 * report how many prepared answers it finds, per grammar, with a few short
 * question samples — the check that the auto-detection actually covers the way
 * the library is written. Read-only; prints question headers only.
 *
 *   npx vite-node tools/qa-corpus-detect.ts -- "D:\path\to\notes"
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { extractQaPairs, questionSimilarity } from '../shared/qaPairs';

const root = process.argv[2];
if (!root) {
  console.error('usage: npx vite-node tools/qa-corpus-detect.ts -- <dir> [probe] | <file> --trace');
  process.exit(2);
}
const probe = process.argv[3] ?? 'Kafka 怎么保证消息不丢';

/** single-file trace: every detected pair with its raw source line */
if (process.argv.includes('--trace')) {
  const text = readFileSync(root, 'utf8');
  const src = text.replace(/\r\n?/g, '\n').split('\n');
  const pairs = extractQaPairs(text);
  console.log(`# ${root}\n# ${pairs.length} pairs\n`);
  for (const p of pairs) {
    console.log(`[${p.via}] L${p.line}  Q(${p.question.length}): ${p.question.slice(0, 60)}`);
    console.log(`         raw: ${(src[p.line - 1] ?? '').trim().slice(0, 100)}`);
    console.log(`         A(${p.answer.length}): ${p.answer.slice(0, 60)}\n`);
  }
  process.exit(0);
}

const files: string[] = [];
const walk = (dir: string, depth = 0): void => {
  if (depth > 12) return;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) files.push(full);
  }
};
walk(root);

let total = 0;
let totalChars = 0;
const byVia = { marker: 0, question: 0, table: 0 };
const perFile: { f: string; n: number; chars: number }[] = [];
const allQuestions: { q: string; f: string }[] = [];
const started = Date.now();

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const pairs = extractQaPairs(text);
  total += pairs.length;
  totalChars += text.length;
  for (const p of pairs) {
    byVia[p.via]++;
    allQuestions.push({ q: p.question, f });
  }
  perFile.push({ f: f.slice(root.length), n: pairs.length, chars: statSync(f).size });
}

console.log(`scanned ${files.length} files (${(totalChars / 1e6).toFixed(2)} MB) in ${Date.now() - started}ms`);
console.log(`prepared answers detected: ${total}   per-grammar: ${JSON.stringify(byVia)}`);
console.log(`files with >=1 pair: ${perFile.filter((p) => p.n > 0).length} / ${files.length}`);

console.log('\n=== top 10 files by detected pairs ===');
for (const p of [...perFile].sort((a, b) => b.n - a.n).slice(0, 10)) {
  console.log(`${String(p.n).padStart(4)}  ${p.f.slice(-58)}`);
}

console.log('\n=== shortest / longest detected questions (sanity) ===');
const sorted = [...allQuestions].sort((a, b) => a.q.length - b.q.length);
for (const s of sorted.slice(0, 5)) console.log(`  short(${s.q.length}) ${s.q}   ← ${s.f.slice(-28)}`);
for (const s of sorted.slice(-3)) console.log(`  long (${s.q.length}) ${s.q.slice(0, 60)}…`);

// the retrieval gate is lexical-first here (no embedding model needed): how many
// prepared questions would a real spoken query be able to reach?
console.log(`\n=== lexical reachability for probe: 「${probe}」 ===`);
const scored = allQuestions
  .map((x) => ({ ...x, s: questionSimilarity(probe, x.q) }))
  .sort((a, b) => b.s - a.s)
  .slice(0, 6);
for (const x of scored) {
  console.log(`  ${x.s.toFixed(3)}  ${x.q.slice(0, 46)}   ← ${x.f.slice(-26)}`);
}
const reachable = allQuestions.filter((x) => questionSimilarity(probe, x.q) >= 0.62).length;
console.log(`  literal-strength matches (>=0.62): ${reachable}`);
