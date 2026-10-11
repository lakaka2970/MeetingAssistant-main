import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { globalFileList, platformFileList, readBuilderSource } from './helpers/builderConfig';

const source = readBuilderSource();
const PLATFORMS = ['win', 'linux'] as const;
const ORT_BIN = 'node_modules/onnxruntime-node/bin/napi-v3';
const REPO = new URL('../', import.meta.url);
const onDisk = (relative: string): boolean => existsSync(fileURLToPath(new URL(relative, REPO)));

/**
 * Does an electron-builder `files` entry swallow this path? Only the shapes the
 * config actually uses are handled: a directory prefix ending in `/**`, or a
 * bare directory/file path.
 */
function entryCovers(entry: string, path: string): boolean {
  const pattern = entry.startsWith('!') ? entry.slice(1) : entry;
  if (!pattern.startsWith('node_modules/')) return false;
  const prefix = pattern.endsWith('/**') ? pattern.slice(0, -'/**'.length) : pattern;
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

// electron-builder does not merge `files` per platform — a platform-level list
// replaces the global one — so each platform block has to carry the whole
// contract itself. onnxruntime-node ships every platform's native binaries in
// one tarball, so the paths below exist on whichever host runs this suite.
describe('electron-builder files lists', () => {
  it('re-lists the positive patterns in every platform block', () => {
    for (const platform of PLATFORMS) {
      const items = platformFileList(source, platform);
      expect(items, `${platform}.files`).toContain('out/**');
      expect(items, `${platform}.files`).toContain('package.json');
    }
  });

  it('carries every global exclusion into every platform block', () => {
    const globalExclusions = globalFileList(source).filter((item) => item.startsWith('!'));
    expect(globalExclusions.length).toBeGreaterThan(10);

    for (const platform of PLATFORMS) {
      const items = new Set(platformFileList(source, platform));
      expect([...items]).not.toContain('src/**');
      const missing = globalExclusions.filter((item) => !items.has(item));
      expect(missing, `${platform}.files drops global exclusions`).toEqual([]);
    }
  });

  it('drops the onnxruntime binaries the Windows build cannot load', () => {
    const items = platformFileList(source, 'win');

    // dist/binding.js resolves `../bin/napi-v3/${process.platform}/${process.arch}/`,
    // so on win32/x64 every other directory under there is unreachable: 65 MB of
    // darwin, 404 MB of linux (CUDA and TensorRT included) and 34 MB of win32/arm64.
    expect(items).toContain(`!${ORT_BIN}/darwin/**`);
    expect(items).toContain(`!${ORT_BIN}/linux/**`);
    expect(items).toContain(`!${ORT_BIN}/win32/arm64/**`);
  });

  it('names paths that really exist in the install tree', () => {
    const checked: string[] = [];
    for (const platform of PLATFORMS) {
      for (const item of platformFileList(source, platform)) {
        if (!item.startsWith(`!${ORT_BIN}/`)) continue;
        checked.push(item);
        expect(onDisk(item.slice(1).replace(/\/\*\*$/, '')), `${item} matches nothing on disk`).toBe(true);
      }
    }
    expect(checked.length).toBeGreaterThan(0);
  });

  it('never excludes the binding its own platform loads', () => {
    // Each block is judged against the tree that target actually resolves at
    // runtime — win.files is supposed to drop the linux tree, after all. The arch
    // is the one declared under win/linux `target`, not the host's.
    const loadedBy = { win: 'win32/x64', linux: 'linux/x64' } as const;

    for (const platform of PLATFORMS) {
      const binding = `${ORT_BIN}/${loadedBy[platform]}/onnxruntime_binding.node`;
      expect(onDisk(binding), `${binding} is not in the install tree`).toBe(true);

      for (const item of platformFileList(source, platform)) {
        if (!item.startsWith('!')) continue;
        expect(entryCovers(item, binding), `${platform}.files excludes ${binding}`).toBe(false);
      }
    }
  });

  it('keeps the DLLs the Windows binding links against', () => {
    const items = platformFileList(source, 'win');
    const dir = `${ORT_BIN}/win32/x64/`;

    for (const file of ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll']) {
      for (const item of items) {
        expect(entryCovers(item, dir + file), `win.files excludes ${file}`).toBe(false);
      }
    }
  });
});
