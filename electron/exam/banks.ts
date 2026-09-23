/**
 * Main-process glue for the exam-mode question banks.
 *
 * Real banks ship as PDF pairs — `…-学生版.pdf` with the questions
 * and `…-答案版.pdf` with 「N.【答案】D。解析：…」 — and the numbering restarts
 * per 部分, so the two files have to be read together and joined by
 * (section, number): see shared/answerKey.ts, which this drives. Prose notes
 * and JSON/CSV exports go through the ordinary bank parser instead, and a note
 * that already contains its own 「题目：…答案：…」 blocks needs no pair.
 *
 * Two rules keep this off the user's critical path:
 *   • nothing is read synchronously on the boot path — extraction of a 1 MB PDF
 *     costs ~200 ms and a pack costs seconds, so the scan runs in the
 *     background and reports progress;
 *   • oversized files are refused with a reason (one 284 MB 北森 pack would
 *     freeze the process and blow memory for hours).
 *
 * There is deliberately no derived cache: the user's files are the source of
 * truth and re-scanning is fast, while a cached copy silently rots the moment
 * they edit a note. Nothing here touches the interview RAG index.
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'fs';
import { basename, extname, join } from 'path';
import { BankStore, type BankSearchHit, type BankVerdict, type ExamSubMode } from '../../shared/bankStore';
import type { BankEntry } from '../../shared/bankParse';
import { parseBankFile } from '../../shared/bankParse';
import { docRole, joinQuestionsAndAnswers, parseAnswersDoc, parseQuestionsDoc } from '../../shared/answerKey';
import { extractDocText } from '../docparse';

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json']);
const PDF_EXTENSIONS = new Set(['.pdf']);
/** Byte size is a terrible proxy for extraction cost on PDFs: the 285 MB
 * 北森题库 in the real corpus is 99% embedded images and yields 716 questions in
 * 14 s, while a 30 MB scanned dump yields nothing. So a PDF gets a generous
 * ceiling (the scan is a background pass with per-file progress) and a plain
 * text file of that size is simply not a question bank. */
const MAX_FILE_BYTES = 30_000_000;
const MAX_PDF_BYTES = 400_000_000;
const MAX_FILES_PER_MODE = 4000;

export interface BankLoadReport {
  subMode: ExamSubMode;
  dir: string;
  files: number;
  parsed: number;
  /** questions with no answer attached (they still serve as recall material) */
  unanswered: number;
  /** skipped with a reason (oversize / scanned PDF / unreadable) */
  skipped: { name: string; reason: string }[];
  entries: number;
  mc: number;
  /** repeated copies of the same question, folded into one record */
  duplicates: number;
  /** questions where two of the user's own files give different answers */
  conflicts: number;
  ms: number;
}

export interface BankProgress {
  subMode: ExamSubMode;
  scanning: boolean;
  done: BankLoadReport[];
  current?: string;
}

const isPdf = (p: string): boolean => PDF_EXTENSIONS.has(extname(p).toLowerCase());
const isText = (p: string): boolean => TEXT_EXTENSIONS.has(extname(p).toLowerCase());

/** walk one directory tree; hidden entries and unrelated formats are skipped */
function walk(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 10 || out.length >= MAX_FILES_PER_MODE) return out;
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, out);
    else if (e.isFile() && (isPdf(full) || isText(full))) out.push(full);
  }
  return out;
}

/** the answer paper that belongs to a question paper, by folder + name shape */
function findPair(pdf: string, all: string[]): string | undefined {
  const dir = pdf.slice(0, pdf.lastIndexOf('\\') >= pdf.lastIndexOf('/') ? Math.max(pdf.lastIndexOf('\\'), pdf.lastIndexOf('/')) : 0);
  const name = basename(pdf);
  if (!/学生版|试题|题目|卷子|试卷/.test(name)) return undefined;
  const asAnswer = name.replace(/学生\s*版/g, '答案版').replace(/试题|题目|卷子|试卷/g, (m) => (/试题|题目/.test(m) ? '答案版' : m));
  const flat = (s: string): string => s.replace(/\s/g, '');
  return all.find(
    (p) => p.startsWith(dir) && flat(basename(p)) === flat(asAnswer) && !/学生版/.test(basename(p)),
  );
}

export class ExamBanks {
  readonly store = new BankStore();
  private progress: BankProgress = { subMode: 'aptitude', scanning: false, done: [] };
  private busy = false;

  get status(): BankProgress {
    return this.progress;
  }

  reports(): BankLoadReport[] {
    return this.progress.done;
  }

  /**
   * Scan + index one sub-mode in the background. Safe to call repeatedly (a
   * second call while one is running is folded into the next pass), and a
   * missing directory clears the sub-mode instead of leaving stale answers.
   */
  async bind(subMode: ExamSubMode, dir: string | undefined, onProgress?: (p: BankProgress) => void): Promise<BankLoadReport> {
    const t0 = Date.now();
    const report: BankLoadReport = {
      subMode,
      dir: dir ?? '',
      files: 0,
      parsed: 0,
      unanswered: 0,
      skipped: [],
      entries: 0,
      mc: 0,
      duplicates: 0,
      conflicts: 0,
      ms: 0,
    };
    if (!dir || !existsSync(dir)) {
      this.store.clear(subMode);
      report.ms = Date.now() - t0;
      this.record(report, onProgress);
      return report;
    }
    const paths = walk(dir);
    report.files = paths.length;
    const pdfs = paths.filter(isPdf);
    const texts = paths.filter(isText);
    const entries: BankEntry[] = [];

    // PDF papers first, paired so the answer sheet can attach to its paper
    const paired = new Set<string>();
    for (const q of pdfs) {
      const a = findPair(q, pdfs);
      const size = (p: string): number => {
        try {
          return statSync(p).size;
        } catch {
          return 0;
        }
      };
      if (size(q) > MAX_PDF_BYTES) {
        report.skipped.push({ name: basename(q), reason: `文件过大（${Math.round(size(q) / 1048576)}MB），未扫描` });
        continue;
      }
      this.tick(subMode, basename(q), onProgress);
      let qText = '';
      try {
        qText = await extractDocText(q);
      } catch (e) {
        report.skipped.push({ name: basename(q), reason: `无法解析：${(e as Error).message}` });
        continue;
      }
      if (a && size(a) <= MAX_PDF_BYTES) {
        paired.add(a);
        try {
          const aText = await extractDocText(a);
          const joined = joinQuestionsAndAnswers(parseQuestionsDoc(qText), parseAnswersDoc(aText), basename(q));
          entries.push(...joined.entries);
          report.parsed++;
          report.unanswered += joined.unanswered;
          if (joined.mismatchedSections.length) {
            report.skipped.push({
              name: basename(a),
              reason: `答案卷有 ${joined.mismatchedSections.length} 个节名在题目卷中不存在（已按题号兜底）`,
            });
          }
          continue;
        } catch (e) {
          report.skipped.push({ name: basename(a), reason: `答案卷无法解析：${(e as Error).message}` });
        }
      }
      // no pair: the paper still contributes questions (answer-less), and a
      // self-contained PDF (题干+答案 in one file) is parsed as such
      const asAnswers = docRole(basename(q), qText) === 'answers';
      if (asAnswers) continue; // an answer sheet alone is not searchable material
      const own = parseBankFile(basename(q), qText);
      if (own.entries.length) {
        entries.push(...own.entries);
        report.parsed++;
        continue;
      }
      const lone = joinQuestionsAndAnswers(parseQuestionsDoc(qText), [], basename(q));
      if (lone.entries.length) {
        entries.push(...lone.entries);
        report.parsed++;
        report.unanswered += lone.unanswered;
        report.skipped.push({ name: basename(q), reason: '题目卷未找到配套答案版（仅可作为题干线索）' });
      } else {
        report.skipped.push({ name: basename(q), reason: '未识别出题目（可能是扫描版图片 PDF）' });
      }
    }
    for (const a of pdfs) if (paired.has(a)) continue;

    for (const t of texts) {
      this.tick(subMode, basename(t), onProgress);
      try {
        const { readFileSync } = await import('fs');
        if (statSync(t).size > MAX_FILE_BYTES) {
          report.skipped.push({ name: basename(t), reason: '文件过大，未扫描' });
          continue;
        }
        const parsed = parseBankFile(basename(t), readFileSync(t, 'utf8'));
        entries.push(...parsed.entries);
        if (parsed.entries.length) report.parsed++;
      } catch (e) {
        report.skipped.push({ name: basename(t), reason: (e as Error).message });
      }
    }

    entries.forEach((e, i) => (e.id = `${subMode}#${i}`));
    // duplicates and contradictions are folded away here, so what the search
    // path can return is exactly what this report counts
    const merged = this.store.replaceEntries(subMode, entries, dir);
    report.entries = merged.entries.length;
    report.duplicates = merged.duplicates;
    report.conflicts = merged.conflicts;
    report.mc = merged.entries.filter((e) => e.kind === 'mc').length;
    report.ms = Date.now() - t0;
    this.record(report, onProgress);
    console.log(
      `[exam-banks] ${subMode} ← ${basename(dir)}: ${report.entries} entries ` +
        `(${report.mc} 客观题) from ${report.parsed}/${report.files} files in ${report.ms}ms` +
        (report.unanswered ? `, ${report.unanswered} 题无答案` : '') +
        (merged.duplicates ? `, ${merged.duplicates} 重复已合并` : '') +
        (merged.conflicts ? `, ${merged.conflicts} 题各库答案不一致` : '') +
        (report.skipped.length ? `, ${report.skipped.length} 跳过` : ''),
    );
    return report;
  }

  /** boot: bind every configured directory, one after another, in the background */
  async bindAll(binds: Partial<Record<ExamSubMode, string>>, onProgress?: (p: BankProgress) => void): Promise<BankLoadReport[]> {
    if (this.busy) return this.progress.done;
    this.busy = true;
    this.progress = { subMode: 'aptitude', scanning: true, done: [] };
    onProgress?.(this.progress);
    const out: BankLoadReport[] = [];
    try {
      for (const mode of ['aptitude', 'technical', 'personality', 'open'] as ExamSubMode[]) {
        const dir = binds[mode];
        if (!dir) continue;
        out.push(await this.bind(mode, dir, onProgress));
      }
    } finally {
      this.busy = false;
      this.progress = { ...this.progress, scanning: false };
      onProgress?.(this.progress);
    }
    return out;
  }

  private tick(subMode: ExamSubMode, current: string, onProgress?: (p: BankProgress) => void): void {
    this.progress = { ...this.progress, subMode, current };
    onProgress?.(this.progress);
  }

  private record(report: BankLoadReport, onProgress?: (p: BankProgress) => void): void {
    this.progress = {
      ...this.progress,
      subMode: report.subMode,
      done: [...this.progress.done.filter((r) => r.subMode !== report.subMode), report],
    };
    onProgress?.(this.progress);
  }

  statusTable(): ReturnType<BankStore['status']> {
    return this.store.status();
  }

  search(subMode: ExamSubMode, question: string, limit?: number): BankVerdict {
    return this.store.search(subMode, question, limit);
  }

  searchAll(question: string, limit?: number): { mode: ExamSubMode; verdict: BankVerdict }[] {
    return this.store.searchAll(question, limit);
  }

  /** candidates for the semantic adjudication step (a bank hit we must confirm) */
  candidates(question: string, limit = 6): { mode: ExamSubMode; hit: BankSearchHit }[] {
    const out: { mode: ExamSubMode; hit: BankSearchHit }[] = [];
    for (const { mode, verdict } of this.store.searchAll(question, 3)) {
      if (verdict.best) out.push({ mode, hit: verdict.best });
      for (const v of verdict.others) out.push({ mode, hit: v });
    }
    return out.sort((a, b) => b.hit.score - a.hit.score).slice(0, limit);
  }

  list(subMode: ExamSubMode, limit?: number): BankEntry[] {
    return this.store.list(subMode, limit);
  }
}
