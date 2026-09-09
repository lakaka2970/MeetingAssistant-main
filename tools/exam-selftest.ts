/**
 * Exam-bank self-test: bind a real folder through the PRODUCTION path
 * (electron/exam/banks.ts → parse + pair + merge + index) and run questions
 * through BankStore, printing what would be answered and how fast. No model, no
 * network — this is the half of 做题模式 that must be trustworthy on its own.
 *
 *   npm run exam:selftest -- [bankDir] [extra question…]
 *
 * Under Windows/cmd.exe, quote every argument: a bare CJK path arrives with
 * stray spaces inserted, which silently binds an empty folder.
 */
import { ExamBanks } from '../electron/exam/banks';
import { parseSingleQuestion } from '../shared/bankParse';
import { decideBankAnswer, formatBankBlock } from '../shared/bankStore';

const dir = process.argv[2] ?? 'D:\\LZY\\就业\\知识准备\\题库';
const extra = process.argv.slice(3);

const banks = new ExamBanks();
console.log(`binding ${dir}`);
const t0 = Date.now();
const report = await banks.bind('aptitude', dir);
console.log(
  `  ${report.entries} entries (${report.mc} objective) from ${report.parsed}/${report.files} files in ${Date.now() - t0}ms` +
    (report.duplicates ? ` · 合并重复 ${report.duplicates}` : '') +
    (report.conflicts ? ` · 答案互斥 ${report.conflicts}` : ''),
);
for (const s of report.skipped) console.log(`  skipped: ${s.name} — ${s.reason}`);

const sample = banks.list('aptitude', 3);
if (!sample.length) {
  console.log('nothing indexed — the folder holds nothing the parser can read');
  process.exit(1);
}

/** ask one question through the same gate the exam window uses */
function ask(q: string, label: string): void {
  const t = Date.now();
  const screen = parseSingleQuestion(q);
  const v = banks.search('aptitude', screen.stem || q);
  const d = decideBankAnswer(v, screen.options.map((o) => o.text));
  const best = d.best;
  console.log(`\nQ[${label}]: ${q.slice(0, 64)}${q.length > 64 ? '…' : ''}`);
  console.log(
    `  ${v.mode} in ${Date.now() - t}ms` +
      (best ? `  score=${best.score} conf=${best.confidence} 同干题数=${v.stemCopies ?? 1}` : ''),
  );
  if (!best) {
    console.log('  → 交给 AI / 网络（题库没有）');
    return;
  }
  console.log(`  ${d.direct ? '✅ 免模型直答' : '🧠 交给模型（题库作参考）'}${d.disagree ? ' · 库内答案互斥，已列出待确认' : ''}`);
  console.log(
    '  ' +
      formatBankBlock(best, screen.options.map((o) => o.text))
        .split('\n')
        .slice(0, 4)
        .join('\n  ')
        .slice(0, 300),
  );
  if (v.others.length) console.log(`  相近题 ${v.others.length} 道（会提示确认）`);
}

ask(sample[0].stem, '原题');
ask(`${sample[1]?.stem ?? sample[0].stem} ${sample[1]?.options.map((o) => `${o.key}. ${o.text}`).join(' ') ?? ''}`, '带选项');
ask('量子计算中的 Shor 算法在有限域上求解离散对数的时间复杂度是多少？', '题库没有');
for (const q of extra) ask(q, '自定义');

/**
 * The sweep is the number that actually matters: re-ask every objective
 * question in the folder and count how often the answer printed as fact is the
 * one this record carries. A wrong letter printed with confidence is the only
 * outcome this mode must never produce, so it is the only thing measured.
 */
console.log('\n== 自检：把库里每道客观题原样问回去 ==');
const all = banks.list('aptitude', 100000);
let checked = 0;
let exact = 0;
let wrong = 0;
let surfaced = 0;
const bad: string[] = [];
const tally = new Map<string, number>();
for (const e of all) {
  if (!e.answerKey || e.kind !== 'mc') continue;
  const v = banks.search('aptitude', e.stem);
  const d = decideBankAnswer(v, e.options.map((o) => o.text));
  checked++;
  if (v.best?.confidence === 'exact' && v.best.entry.id === e.id) exact++;
  if (d.disagree || !d.unique) surfaced++;
  if (!d.direct || !d.best) continue;
  tally.set(d.best.entry.id, (tally.get(d.best.entry.id) ?? 0) + 1);
  if (d.best.entry.id === e.id || d.letter === e.answerKey) continue;
  wrong++;
  if (bad.length < 8) bad.push(`  ✗ ${e.stem.slice(0, 30)} → 命中 ${d.best.entry.stem.slice(0, 30)}（${d.letter} ≠ ${e.answerKey}）`);
}
if (!checked) {
  console.log('  库里没有可自检的客观题');
} else {
  console.log(
    `  ${checked} 道题：原题命中自身 ${exact}（${((exact / checked) * 100).toFixed(1)}%）· ` +
      `直答且答错 ${wrong} · 冲突/同干题拦截 ${surfaced}`,
  );
  for (const b of bad) console.log(b);
  const repeated = [...tally.entries()].filter(([, n]) => n > 1).length;
  if (repeated) console.log(`  （${repeated} 条题库记录被多道题共用，属正常的相近题）`);
}
process.exit(wrong ? 1 : 0);
