/**
 * Checks on the files served to the phone.
 *
 * The page is plain JavaScript outside the type-checked bundle, so the two
 * failure modes that a build would normally catch are invisible here: a null
 * from a mistyped element id (which kills the whole script and leaves a blank
 * screen), and a markdown renderer that stops escaping (which turns every
 * model answer into HTML the phone browser executes).
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'resources', 'companion');
const html = readFileSync(join(DIR, 'index.html'), 'utf8');
const appJs = readFileSync(join(DIR, 'app.js'), 'utf8');
const markdownJs = readFileSync(join(DIR, 'markdown.js'), 'utf8');

describe('phone page wiring', () => {
  it('every element app.js looks up exists in the page', () => {
    const ids = [...appJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(8);
    const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html));
    expect(missing).toEqual([]);
  });

  it('every element app.js queries by class exists in the page', () => {
    const classes = [...appJs.matchAll(/querySelectorAll\('\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    const missing = classes.filter((c) => !new RegExp(`class="${c}`).test(html));
    expect(missing).toEqual([]);
  });

  it('loads every script the page references from a route the server serves', () => {
    const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    // the two local scripts are ours; the vendor ones come from node_modules
    for (const s of srcs.filter((x) => !x.startsWith('/vendor/'))) {
      expect(['/markdown.js', '/app.js']).toContain(s);
    }
    expect(srcs).toContain('/app.js');
  });

  it('never renders the screenshot as an image', () => {
    // deliberate: the answer text is the payload, an <img> is an unshrinkable
    // element that wrecks the zoom-reflow layout on a narrow screen
    expect(appJs).not.toMatch(/createElement\('img'\)/);
    expect(appJs).not.toMatch(/createObjectURL/);
  });
});

/** Evaluate the shipped renderer with a stand-in `window`. */
function loadMarkdown(): (src: string) => string {
  const win = {} as { renderMarkdown?: (s: string) => string };
  const ctx = createContext({
    window: win,
    String,
    Number,
    RegExp,
    Array,
    Object,
    JSON,
    console,
    undefined,
  });
  runInContext(markdownJs, ctx, { filename: 'markdown.js' });
  if (typeof win.renderMarkdown !== 'function') throw new Error('renderer did not export');
  return win.renderMarkdown;
}

describe('phone markdown renderer', () => {
  const md = loadMarkdown();

  it('escapes before parsing, so model output cannot inject HTML', () => {
    const img = md('<img src=x onerror=alert(1)>');
    // wrapped in a paragraph, but the tag itself never survives as a tag
    expect(img).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(img).not.toContain('<img');
    expect(md('<script>alert(1)</script>')).not.toContain('<script');
    expect(md('a</p><p>b')).not.toContain('</p><p>');
    // an injected closing tag must not be able to escape the wrapper either
    expect(md('x\n</div><script>alert(1)</script>')).not.toContain('<script');
  });

  it('refuses non-http links', () => {
    expect(md('[x](javascript:alert(1))')).not.toContain('href');
    expect(md('[x](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain('href');
    expect(md('[x](https://ok.example/a)')).toContain('href="https://ok.example/a"');
  });

  it('keeps code fences out of inline processing', () => {
    const out = md('```\nnot **bold** <b>tag</b>\n```');
    expect(out).toContain('<pre><code>not **bold** &lt;b&gt;tag&lt;/b&gt;</code></pre>');
  });

  it('renders the shapes real answers use', () => {
    expect(md('**答案：B**')).toContain('<strong>答案：B</strong>');
    const ul = md('- 甲\n- 乙');
    expect(ul).toContain('<ul>');
    expect(ul).toContain('<li>甲</li>');
    expect(ul).toContain('<li>乙</li>');
    const ol = md('1. 一\n2. 二');
    expect(ol).toContain('<ol>');
    expect(ol).toContain('<li>一</li>');
    expect(md('# 标题')).toContain('<h1>标题</h1>');
    expect(md('> 引用')).toContain('<blockquote>');
    expect(md('`x=1`')).toContain('<code>x=1</code>');
  });

  it('does not let inline code leak into bold parsing', () => {
    // the masking step exists precisely for this case
    expect(md('`a**b**`')).toBe('<p><code>a**b**</code></p>');
  });

  it('survives empty and non-string input', () => {
    expect(md('')).toBe('');
    expect(md(null as unknown as string)).toBe('');
    expect(md(undefined as unknown as string)).toBe('');
  });
});
