import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DOC_EXTENSIONS, extractDocText, normalizeDocText } from '../electron/docparse';

const FIX = join(__dirname, 'fixtures');

describe('extractDocText (deterministic resume/JD parsing)', () => {
  // mammoth/pdf-parse cold-load can exceed vitest default; observed 43 s+ on slow GitHub Windows runners
  it('reads a .docx via mammoth (zh + en)', { timeout: 120_000 }, async () => {
    const text = await extractDocText(join(FIX, 'sample.docx'));
    expect(text).toContain('Docx fixture resume');
    expect(text).toContain('项目经历：实时转录 whisper DirectML');
  });

  it('reads a .pdf via pdf-parse without page-number artifacts', { timeout: 120_000 }, async () => {
    const text = await extractDocText(join(FIX, 'sample.pdf'));
    expect(text).toContain('Resume PDF fixture: Python and SQL');
    expect(text).not.toContain('-- 1 of 1 --');
  });

  it('reads plain .md/.txt as utf8', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-doc-'));
    const p = join(dir, 'kb.md');
    writeFileSync(p, '# 简历\n\n项目：MeetingAssistant', 'utf8');
    expect(await extractDocText(p)).toBe('# 简历\n\n项目：MeetingAssistant');
  });

  it('advertised extensions match parse support', () => {
    expect(DOC_EXTENSIONS).toEqual(['md', 'markdown', 'txt', 'docx', 'pdf']);
  });
});

describe('normalizeDocText', () => {
  it('collapses CRLF, trailing spaces and 3+ newlines', () => {
    expect(normalizeDocText('a  \r\n\r\n\r\n\r\nb\t\n')).toBe('a\n\nb');
  });
  it('empty input (scanned pdf) stays empty', () => {
    expect(normalizeDocText('  \n \n')).toBe('');
  });
});

/** XML namespace decls every pptx part carries */
const PML_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/**
 * Build a throwaway .pptx (pure XML parts in a zip — no Office toolchain) so a
 * test can control exactly which slides have notes. Table cells and the
 * slide-number placeholder are emitted the way PowerPoint writes them.
 */
async function writePptx(
  dir: string,
  deck: Array<{ paras: string[]; table?: string[][]; notes?: string; raw?: string }>,
): Promise<string> {
  const mod: any = await import('jszip');
  const Zip = mod.default ?? mod;
  const zip = new Zip();
  const para = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  const tableXml = (rows: string[][]) =>
    `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
    rows
      .map(
        (cells) =>
          `<a:tr>` +
          cells.map((c) => `<a:tc><a:txBody>${para(c)}</a:txBody></a:tc>`).join('') +
          `</a:tr>`,
      )
      .join('') +
    `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const shape = (body: string) => `<p:sp><p:txBody>${body}</p:txBody></p:sp>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

  deck.forEach((slide, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `${header}<p:sld ${PML_NS}><p:cSld><p:spTree>` +
        slide.paras.map((t) => shape(para(t))).join('') +
        (slide.table ? tableXml(slide.table) : '') +
        (slide.raw ?? '') +
        `</p:spTree></p:cSld></p:sld>`,
    );
    if (slide.notes !== undefined) {
      zip.file(
        `ppt/notesSlides/notesSlide${i + 1}.xml`,
        `${header}<p:notes ${PML_NS}><p:cSld><p:spTree>` +
          `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${para(slide.notes)}</p:txBody></p:sp>` +
          // PowerPoint also stores the page number in the notes slide; it is not content
          `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr>` +
          `<p:txBody><a:p><a:fld type="slidenum"><a:t>${i + 1}</a:t></a:fld></a:p></p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:notes>`,
      );
    }
  });
  zip.file(
    '[Content_Types].xml',
    `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
  );
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const path = join(dir, `deck-${deck.length}-${Date.now()}-${Math.random().toString(36).slice(2)}.pptx`);
  writeFileSync(path, buf);
  return path;
}

describe('extractDocText .pptx (slide boundaries, speaker notes, tables)', () => {
  it('extracts the real fixture slide by slide', { timeout: 120_000 }, async () => {
    const text = await extractDocText(join(FIX, 'sample.pptx'));
    expect(text).toBe(
      [
        '## 第1页',
        '项目背景',
        '离线转录，无需联网',
        '指标 | 数值',
        '延迟 | 320ms',
        '备注：这里要强调离线运行',
        '## 第2页',
        '评测方法',
      ].join('\n'),
    );
  });

  it('attaches notes to the slide they belong to and skips empty slides', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-pptx-'));
    const p = await writePptx(dir, [
      { paras: ['第一页'] },
      { paras: [] },
      { paras: ['第三页'], notes: '只在第三页' },
    ]);
    expect(await extractDocText(p)).toBe(['## 第1页', '第一页', '## 第3页', '第三页', '备注：只在第三页'].join('\n'));
  });

  it('renders a table row as one line of cells without xml leftovers', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-pptx-'));
    const p = await writePptx(dir, [
      { paras: ['概览'], table: [['姓名', '岗位', '城市'], ['张三', '后端', '上海']] },
    ]);
    expect(await extractDocText(p)).toBe(['## 第1页', '概览', '姓名 | 岗位 | 城市', '张三 | 后端 | 上海'].join('\n'));
  });

  it('drops auto-filled slide-number fields from the extracted text', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-pptx-'));
    const p = await writePptx(dir, [
      {
        paras: ['正文'],
        raw: '<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>',
      },
    ]);
    expect(await extractDocText(p)).toBe(['## 第1页', '正文'].join('\n'));
  });
});
