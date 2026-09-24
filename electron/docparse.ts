/**
 * Deterministic document→text extraction for session material (resume / JD)
 * and the document library. NO LLM / function calling — parsing is a pure I/O
 * task and the main answer path is latency-first (HANDOFF §5 P0-2).
 * Scanned/image-only PDFs have no text layer and yield '' — the renderer
 * surfaces that as a warning.
 */
import { readFileSync } from 'fs';
import { extname } from 'path';

/**
 * Extensions offered in the single-file pick dialogs (resume / JD / global
 * knowledge). Parse support below must match, and `extractDocText` must be able
 * to read everything listed here.
 */
export const DOC_EXTENSIONS = ['md', 'markdown', 'txt', 'docx', 'pdf', 'pptx'];

/**
 * Extensions the document library accepts (multi-file / directory import).
 * .doc/.ppt (legacy 97-2003 OLE binaries) are deliberately excluded: there is
 * no reliable pure-JS parser for them — the importer skips them with a
 * "convert to .docx/.pptx" hint instead of ingesting garbage.
 */
export const LIBRARY_EXTENSIONS = ['md', 'markdown', 'txt', 'docx', 'pdf', 'pptx'];

/** plain-text extensions read verbatim as UTF-8 */
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.text']);

/** collapse parser artifacts: CRLF, trailing spaces, 3+ consecutive newlines */
export function normalizeDocText(t: string): string {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** whether the library import should attempt this path (extension whitelist) */
export function isLibraryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase().replace(/^\./, '');
  return LIBRARY_EXTENSIONS.includes(ext);
}

/** decode the handful of XML entities that show up in pptx <a:t> runs */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** <a:t> run, tolerant of attributes; strict enough not to swallow <a:txBody> */
const TEXT_RUN = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;

/** <a:tbl> … </a:tbl>, then its <a:tr> rows and <a:tc> cells */
const TABLE_BLOCK = /<a:tbl(?:\s[^>]*)?>([\s\S]*?)<\/a:tbl>/g;
const TABLE_ROW = /<a:tr(?:\s[^>]*)?>([\s\S]*?)<\/a:tr>/g;
const TABLE_CELL = /<a:tc(?:\s[^>]*)?>([\s\S]*?)<\/a:tc>/g;

/** auto-filled slide number / date fields: presentation chrome, not content */
const FIELD_BLOCK = /<a:fld(?:\s[^>]*)?>[\s\S]*?<\/a:fld>/g;

const textOf = (xml: string): string =>
  [...xml.matchAll(TEXT_RUN)].map((m) => decodeXmlEntities(m[1])).join('').trim();

const cellText = (xml: string): string =>
  xml
    .split(/<\/a:tc>/)
    .map(textOf)
    .filter(Boolean)
    .join(' ');

/**
 * Slide text as lines: one line per paragraph, table rows rendered as
 * `cell | cell`. Tables are lifted out first so their cells keep row structure
 * instead of dissolving into the surrounding paragraph stream.
 */
function slideLines(xml: string): string[] {
  const body = xml.replace(FIELD_BLOCK, '');
  const lines: string[] = [];
  const paragraphs = (fragment: string): void => {
    for (const line of fragment.split(/<\/a:p>/).map(textOf).filter(Boolean)) lines.push(line);
  };
  let cursor = 0;
  for (const match of body.matchAll(TABLE_BLOCK)) {
    paragraphs(body.slice(cursor, match.index));
    for (const row of match[1].replace(FIELD_BLOCK, '').matchAll(TABLE_ROW)) {
      const cells = [...row[1].matchAll(TABLE_CELL)].map((c) => cellText(c[1])).filter(Boolean);
      if (cells.length) lines.push(cells.join(' | '));
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  paragraphs(body.slice(cursor));
  return lines;
}

/** .pptx: `## 第N页` per slide, its paragraphs/tables, then speaker notes */
async function extractPptxText(filePath: string): Promise<string> {
  const mod: any = await import('jszip');
  const JSZip = mod.default ?? mod;
  const zip = await JSZip.loadAsync(new Uint8Array(readFileSync(filePath)));
  const partNames = Object.keys(zip.files);
  const slideNames = partNames
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));
  /**
   * notesSlideN.xml maps to slideN.xml by number: that is how PowerPoint names
   * them, and reading the .rels chain would need a real XML parser.
   */
  const notesNames = new Map(
    partNames
      .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n))
      .map((n) => [slideNumberOf(n), n] as const),
  );
  const parts: string[] = [];
  for (const name of slideNames) {
    const file = zip.file(name);
    if (!file) continue;
    const page = slideNumberOf(name);
    const lines = slideLines(await file.async('string'));
    const notesName = notesNames.get(page);
    if (notesName) {
      const notesFile = zip.file(notesName);
      if (notesFile) {
        const notes = slideLines(await notesFile.async('string')).join(' ');
        if (notes) lines.push(`备注：${notes}`);
      }
    }
    // a slide with neither text nor notes would only contribute its marker
    if (lines.length) parts.push([`## 第${page}页`, ...lines].join('\n'));
  }
  return normalizeDocText(parts.join('\n'));
}

function slideNumberOf(partName: string): number {
  return Number(partName.match(/(\d+)\.xml$/i)?.[1] ?? 0);
}

export async function extractDocText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.docx') {
    const mod: any = await import('mammoth');
    const mammoth = mod.default ?? mod;
    const r = await mammoth.extractRawText({ path: filePath });
    return normalizeDocText(r.value ?? '');
  }
  if (ext === '.pdf') {
    const mod: any = await import('pdf-parse');
    const PDFParse = mod.PDFParse ?? mod.default?.PDFParse;
    const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) });
    try {
      const r = await parser.getText({ pageJoiner: '' });
      return normalizeDocText(r.text ?? '');
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.pptx') {
    return extractPptxText(filePath);
  }
  if (TEXT_EXTS.has(ext)) {
    return normalizeDocText(readFileSync(filePath, 'utf8'));
  }
  // .doc / .ppt / .xls (legacy OLE) and anything unknown: refuse rather than
  // read binary bytes as text and poison the index with garbage.
  throw new Error(`unsupported document type: ${ext || '(no extension)'}`);
}
