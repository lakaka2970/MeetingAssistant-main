/**
 * What is inside app.asar, by package and by extension, plus the largest single
 * files. Read-only: parses the asar header, extracts nothing.
 *
 *   node tools/asar-report.mjs [path/to/app.asar]
 *
 * Sizes are the logical file sizes from the header, so entries that
 * electron-builder unpacked (onnxruntime-node) are counted here but live in
 * app.asar.unpacked on disk.
 */
import { openSync, readSync, closeSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? join(root, 'release', 'linux-unpacked', 'resources', 'app.asar');

// asar header: 16-byte pickle prefix, then UInt32LE length, then the JSON
const fd = openSync(target, 'r');
const prefix = Buffer.alloc(16);
readSync(fd, prefix, 0, 16, 0);
const jsonSize = prefix.readUInt32LE(12);
const json = Buffer.alloc(jsonSize);
readSync(fd, json, 0, jsonSize, 16);
closeSync(fd);
const header = JSON.parse(json.toString('utf8'));

const files = [];
(function walk(node, prefixPath) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefixPath ? `${prefixPath}/${name}` : name;
    if (entry.files) walk(entry, path);
    else files.push({ path, size: Number(entry.size ?? 0), unpacked: !!entry.unpacked });
  }
})(header, '');

const mb = (n) => (n / 1048576).toFixed(1);
const total = files.reduce((s, f) => s + f.size, 0);
console.log(
  `${target}\nentries=${files.length}  logical=${mb(total)} MB (includes unpacked entries)`,
);

const group = (keyOf, label, limit) => {
  const map = new Map();
  for (const f of files) map.set(keyOf(f), (map.get(keyOf(f)) ?? 0) + f.size);
  console.log(`\n--- ${label} ---`);
  for (const [k, v] of [...map].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    console.log(`${mb(v).padStart(8)} MB  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
};

group(
  (f) => f.path.match(/^(node_modules\/(@[^/]+\/[^/]+|[^/]+))/)?.[1] ?? f.path.split('/')[0],
  'by package (top 15)',
  15,
);
group(
  (f) => `.${(f.path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '(none)').toLowerCase()}`,
  'by extension (top 12)',
  12,
);
files.sort((a, b) => b.size - a.size);
console.log('\n--- largest files (top 20) ---');
for (const f of files.slice(0, 20)) console.log(`${mb(f.size).padStart(8)} MB  ${f.path}`);
