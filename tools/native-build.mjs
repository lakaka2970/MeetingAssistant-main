/**
 * Optional native audio build (upgrade P1.5): compiles rust/ into
 * resources/native/meeting-copilot-audio.node via @napi-rs/cli.
 *
 * Explicitly best-effort: no Rust toolchain or any build failure prints a
 * clear message and exits 0 UNLESS --strict is passed. The app runs fine
 * without the artifact (Web Audio fallback), so CI without Rust must not
 * turn red over an optional enhancement.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const strict = process.argv.includes('--strict');
const root = process.cwd();
const rustDir = join(root, 'rust');
const outDir = join(root, 'resources', 'native');

function hasCargo(): boolean {
  try {
    execSync('cargo --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, opts: Record<string, unknown> = {}): void {
  execSync(cmd, { stdio: 'inherit', cwd: rustDir, ...opts });
}

if (!existsSync(join(rustDir, 'Cargo.toml'))) {
  console.error('[native] rust/ not found — nothing to build');
  process.exit(strict ? 1 : 0);
}
if (!hasCargo()) {
  console.warn('[native] Rust toolchain not found (cargo). Skipping the OPTIONAL native audio build.');
  console.warn('[native] Install via https://rustup.rs and re-run `npm run native:build` to enable it.');
  process.exit(strict ? 1 : 0);
}

try {
  mkdirSync(outDir, { recursive: true });
  console.log('[native] installing @napi-rs/cli (rust/)...');
  run('npm install --no-audit --no-fund');
  console.log('[native] napi build --release --platform ...');
  run('npx napi build --release --platform --output-dir ../resources/native');
  // the CLI also emits a JS loader/d.ts; the app loads the .node directly
  for (const junk of ['index.js', 'index.d.ts']) {
    const p = join(outDir, junk);
    if (existsSync(p)) rmSync(p);
  }
  const artifact = join(outDir, 'meeting-copilot-audio.node');
  if (!existsSync(artifact)) {
    throw new Error('build finished but meeting-copilot-audio.node is missing');
  }
  console.log(`[native] built ${artifact}`);
} catch (e) {
  console.error(`[native] build FAILED: ${(e instanceof Error ? e.message : String(e))}`);
  console.error('[native] the app will keep using the Web Audio path — this failure is non-fatal');
  process.exit(strict ? 1 : 0);
}
