/**
 * OCR prefilter for screenshot Q&A (upgrade P2 step 13): a region screenshot
 * that is mostly TEXT should not pay vision-model latency — extract the text
 * locally and answer with the fast text LLM instead.
 *
 * Dependency policy: tesseract.js is an OPTIONAL peer. It is only loaded
 * dynamically when the prefilter is enabled AND installed, so the default
 * install stays slim and the feature degrades to the vision path silently.
 * The routing decision itself is pure and unit-tested.
 */
import { createRequire } from 'module';

export interface OcrOutcome {
  ok: boolean;
  text: string;
  ms: number;
}

/** minimum OCR text length that counts as "text-rich" */
export const MIN_TEXT_CHARS = 20;

/**
 * The routing decision: enough legible text → answer from the text LLM,
 * otherwise hand the pixels to the vision model.
 */
export function decideRoute(ocrText: string, threshold: number = MIN_TEXT_CHARS): 'text' | 'vision' {
  const compact = ocrText.replace(/\s+/g, ' ').trim();
  return compact.length >= threshold ? 'text' : 'vision';
}

/**
 * OCR a PNG data URL with tesseract.js (chi_sim+eng). Returns { ok:false }
 * when the library is missing or the worker fails — never throws.
 */
export async function ocrDataUrl(dataUrl: string, lang = 'chi_sim+eng'): Promise<OcrOutcome> {
  const t0 = Date.now();
  try {
    // optional peer, loaded through an unresolvable dynamic import so the
    // bundler keeps it at runtime (same trick as engine.ts)
    const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
    const mod = (await dynamicImport('tesseract.js')) as {
      recognize(
        image: string,
        lang: string,
        opts?: { logger?: () => void },
      ): Promise<{ data: { text: string } }>;
    };
    const { data } = await mod.recognize(dataUrl, lang, { logger: () => {} });
    return { ok: true, text: data?.text ?? '', ms: Date.now() - t0 };
  } catch (e) {
    console.warn(`[ocr] unavailable/failed: ${(e as Error).message}`);
    return { ok: false, text: '', ms: Date.now() - t0 };
  }
}

/** one-shot availability probe (no import side effects) */
export function isOcrConfigured(): boolean {
  try {
    createRequire(__filename).resolve('tesseract.js');
    return true;
  } catch {
    return false;
  }
}
