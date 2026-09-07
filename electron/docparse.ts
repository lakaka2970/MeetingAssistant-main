/**
 * Deterministic document→text extraction for session material (resume / JD)
 * and the document library. NO LLM / function calling — parsing is a pure I/O
 * task and the main answer path is latency-first (HANDOFF §5 P0-2).
 * Scanned/image-only PDFs have no text layer and yield '' — the renderer
 * surfaces that as a warning.
 */
import { readFileSync } from 'fs';
import { extname } from 'path';

/** extensions offered in the pick dialog (parse support below must match) */
export const DOC_EXTENSIONS = ['md', 'markdown', 'txt', 'docx', 'pdf'];

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

/** .pptx slide text: unzip, read ppt/slides/slideN.xml, collect <a:t> runs */
async function extractPptxText(filePath: string): Promise<string> {
  const mod: any = await import('jszip');
  const JSZip = mod.default ?? mod;
  const zip = await JSZip.loadAsync(new Uint8Array(readFileSync(filePath)));
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number((a.match(/slide(\d+)/i) ?? [0, 0])[1]);
      const nb = Number((b.match(/slide(\d+)/i) ?? [0, 0])[1]);
      return na - nb;
    });
  const parts: string[] = [];
  for (const name of slideNames) {
    const file = zip.file(name);
    if (!file) continue;
    const xml: string = await file.async('string');
    const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const text = runs.join('').trim();
    if (text) parts.push(text);
  }
  return normalizeDocText(parts.join('\n'));
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
