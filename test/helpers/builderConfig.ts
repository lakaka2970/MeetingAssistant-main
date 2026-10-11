import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../../electron-builder.yml', import.meta.url);

export function readBuilderSource(): string {
  return readFileSync(CONFIG_URL, 'utf8');
}

function toItem(line: string): string {
  return line.trim().slice(2).trim().replace(/^['"]|['"]$/g, '');
}

/**
 * The lines of a top-level block (`win:`), comments and blanks kept out, ending
 * at the next top-level key. Returns [] when the key is absent.
 */
function topLevelBlock(source: string, name: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  if (start === -1) return [];

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // a comment belongs to whichever block follows it, it never closes one
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^[^\s]/.test(line)) break;
    body.push(line);
  }
  return body;
}

/** The `- ` items of a `name:` list written at `indent` spaces inside `block`. */
function listItems(block: string[], name: string, indent: number): string[] {
  const head = `${' '.repeat(indent)}${name}:`;
  const start = block.findIndex((line) => line.startsWith(head));
  if (start === -1) return [];

  const items: string[] = [];
  for (let i = start + 1; i < block.length; i += 1) {
    const line = block[i];
    if (line.search(/\S/) <= indent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) items.push(toItem(trimmed));
  }
  return items;
}

/** The root `files:` list — its items are the block itself. */
export function globalFileList(source: string): string[] {
  return topLevelBlock(source, 'files')
    .filter((line) => line.trim().startsWith('- '))
    .map(toItem);
}

export function platformFileList(source: string, platform: 'win' | 'linux' | 'mac'): string[] {
  return listItems(topLevelBlock(source, platform), 'files', 2);
}
