import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The packaging half of the in-app installer, asserted from the files CI reads.
 *
 * None of this is testable from a unit test of the app: a missing `publish`
 * block means no `latest.yml` in the release and no `app-update.yml` in the
 * package, and the app only discovers that when someone clicks 下载并安装 on a
 * machine that can build neither the manifest nor the installer. So the config
 * is read here, on every CI run, on any host.
 */
const root = new URL('../', import.meta.url);
/**
 * CRLF-normalized: `.gitattributes` says `* text=auto`, so a checked-out yml
 * carries CRLF on Windows while every multi-line literal below is written with
 * LF. The first version of this file matched nothing and the failure looked like
 * a missing config — normalize once, at the read, so the assertions below are
 * about the configuration and not about the checkout.
 */
const read = (rel: string): string => readFileSync(new URL(rel, root), 'utf8').replace(/\r\n/g, '\n');
const builder = read('electron-builder.yml');
const workflow = read('.github/workflows/release.yml');
const pkg = JSON.parse(read('package.json'));

/**
 * The lines of a top-level block (`nsis:`, `portable:`), comments and blanks
 * kept out, ending at the next top-level key. Indentation is the only thing that
 * distinguishes these blocks, so this is a scanner rather than a regex over the
 * whole file.
 */
function topLevelBlock(source: string, name: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start === -1) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (/^[^\s]/.test(line)) break;
    body.push(line);
  }
  return body;
}

const text = (source: string, name: string): string => topLevelBlock(source, name).join('\n');

/**
 * The `path: |` block of a given upload-artifact step, as its own lines.
 * Scanned by indentation for the same reason as topLevelBlock: a `#` is only a
 * comment OUTSIDE a block scalar, so a test about comments has to know which one
 * it is looking at.
 */
function uploadArtifactPath(source: string, artifactName: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `name: ${artifactName}`);
  if (start === -1) return [];
  const pathStart = lines.findIndex((l, i) => i > start && l.trim() === 'path: |');
  if (pathStart === -1) return [];
  const indent = lines[pathStart].search(/\S/);
  const out: string[] = [];
  for (let i = pathStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.search(/\S/) <= indent) break;
    out.push(line);
  }
  return out;
}

/** The `- target: <name>` entries of the `win:` block, in order. */
function winTargetNames(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('win:'));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) break; // next top-level block
    const m = line.trim().match(/^- target: (\S+)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

describe('electron-builder publish', () => {
  /**
   * The feed lives on the nsis block. That is both the shape electron-builder
   * 26.15.3's schema accepts — a `publish` inside `win.target[n]` was rejected
   * outright ("configuration.win.target.0 should be one of these: string"),
   * which is how this file ended up here the hard way — and the only artifact
   * electron-updater can install on this app.
   */
  it('puts the github feed on the nsis target', () => {
    const nsis = text(builder, 'nsis');
    expect(nsis).toMatch(/publish:/);
    expect(nsis).toMatch(/provider:\s*github/);
    expect(nsis).toMatch(/owner:\s*lakaka2970/);
    expect(nsis).toMatch(/repo:\s*MeetingAssistant-main/);
  });

  it('does not put a global feed on every target', () => {
    // a top-level publish would make the Linux job emit a latest-linux.yml for
    // an updater the app never runs
    expect(builder).not.toMatch(/^publish:/m);
  });

  /**
   * portable was dropped for v1.0.4: 2 downloads against the installer's 5
   * across v1.0.0-v1.0.3, 118 MB per release, no capability the per-user NSIS
   * install does not already cover, and the one Windows shape electron-updater
   * cannot update. A second Windows artifact needs a reason, not a habit.
   */
  it('builds exactly one Windows artifact', () => {
    expect(winTargetNames(builder)).toEqual(['nsis']);
    // the scanner has to be able to see a second target, or this is decoration
    expect(
      winTargetNames(builder.replace('    - target: nsis', '    - target: portable\n    - target: nsis')),
    ).toEqual(['portable', 'nsis']);
  });

  /**
   * Proof the publish-placement assertion can actually fail: the feed is moved
   * from the nsis block to the linux block in memory — the file on disk is
   * untouched — and both halves must flip. Without this a scanner that simply
   * read nothing would pass forever, which is the same trap as an always-green
   * check.
   */
  it('tells the two blocks apart (in-memory mutation, the real file is untouched)', () => {
    const feed = `  publish:
    provider: github
    owner: lakaka2970
    repo: MeetingAssistant-main
`;
    expect(builder).toContain(feed);
    const moved = builder.replace(feed, '').replace('linux:\n', `linux:\n${feed}`);
    expect(moved).not.toBe(builder);
    expect(text(moved, 'nsis')).not.toMatch(/publish:/);
    expect(text(moved, 'linux')).toMatch(/publish:/);
  });
});

describe('release workflow', () => {
  /**
   * The bug this pins: without tag_name, softprops published v1.0.3 untagged,
   * its `tag_name` came back as `untagged-<sha>`, every installed app answered
   * 检查失败, and there was no /releases/download/<tag>/latest.yml for the
   * installer to read. Both halves of the update feature depend on that path.
   */
  it('names the release after the tag it was cut from', () => {
    expect(workflow).toMatch(/tag_name:\s*\$\{\{\s*github\.ref_name\s*\}\}/);
    expect(workflow).toMatch(/^ {10}name:\s*\$\{\{\s*github\.ref_name\s*\}\}/m);
  });

  /**
   * Not merely "the string appears somewhere": `path: |` is a YAML block scalar,
   * so a comment written inside it turns into a search pattern instead of
   * documentation — which is exactly how this line first went wrong. Assert the
   * manifest is an entry of the windows upload step's own `path` block, and that
   * nothing inside that block is a comment.
   */
  it('ships the install manifest alongside the exe', () => {
    const block = uploadArtifactPath(workflow, 'windows-installers');
    expect(block).toContain('            release/latest.yml');
    expect(block).toContain('            release/*.exe');
    expect(block.filter((l) => l.trim().startsWith('#'))).toEqual([]);
    // the scanner itself must be able to fail, or this is an always-green check
    expect(uploadArtifactPath('name: x\n  with:\n    path: |\n      a\n', 'x')).toEqual(['      a']);
    expect(uploadArtifactPath(workflow, 'no-such-artifact')).toEqual([]);
  });
});

describe('electron-updater as a runtime dependency', () => {
  it('is in dependencies, so electron-builder puts it in the package', () => {
    expect(pkg.dependencies['electron-updater']).toBeTruthy();
    // a devDependency would bundle an import that cannot resolve at runtime,
    // and the failure would only show up when a user clicked install
    expect(pkg.devDependencies?.['electron-updater']).toBeUndefined();
  });
});
