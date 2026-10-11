/**
 * The exam window's whole UI. One component, on purpose: it is a tool with
 * exactly one job (read the screen, answer it), and splitting it would only
 * scatter the state machine that has to stay obvious — capture → read → look
 * up → answer → (maybe) web.
 *
 * Latency ordering is the product: a bank hit is shown the moment it is known
 * (before any model token), the model only ever adds to what is on screen, and
 * the web is reached only when the bank had nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExamBankCandidateView,
  ExamEvent,
  ExamPersona,
  ExamStatusView,
  ExamSubMode,
  PublicSettings,
} from '../../shared/protocol';
import { buildPersonaBlock, defaultPersona, updateLedger, type Ledger } from '../../shared/persona';
import { MathText } from '../components/MathText';
// The check card's shape and its whole state machine live in ./checkCard: the
// card is never merged into `answer` (the original must stay visible beside it),
// and a pure reducer is the only way to unit-test the event ORDER without a DOM.
import { applyCheckCard, type Check } from './checkCard';
import { examDict } from './i18n';

let seq = 0;
const rid = (): string => `exam-${++seq}-${Date.now()}`;

const MODES: ExamSubMode[] = ['aptitude', 'technical', 'personality', 'open'];

interface Answer {
  question: string;
  text: string;
  origin: string;
  letter?: string;
  bank?: ExamBankCandidateView;
  ms: Record<string, number>;
  streaming: boolean;
}

/**
 * The self-check round's card is NOT merged into `answer`: see ./checkCard for
 * its shape and for the pure reducer that decides every check event.
 */
export function ExamApp() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [subMode, setSubMode] = useState<ExamSubMode>('aptitude');
  const [stage, setStage] = useState<string>('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [candidates, setCandidates] = useState<ExamBankCandidateView[] | null>(null);
  const [error, setError] = useState<string>('');
  /** a caveat from the reader (e.g. a second question on screen matched too) */
  const [note, setNote] = useState<string>('');
  const [status, setStatus] = useState<ExamStatusView | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanCurrent, setScanCurrent] = useState('');
  const [instruction, setInstruction] = useState('');
  const [probeQ, setProbeQ] = useState('');
  const [probeHits, setProbeHits] = useState<Awaited<ReturnType<typeof window.mcExam.probeBank>> | null>(null);
  const [ledger, setLedger] = useState<Ledger>({});
  const [copied, setCopied] = useState(false);
  const activeRef = useRef<string>('');
  const t = examDict(settings?.ui.lang ?? 'zh');

  useEffect(() => {
    void window.mcExam.getSettings().then((s) => {
      setSettings(s);
      setSubMode(s.exam?.subMode ?? 'aptitude');
      // same theme resolution as the main window: an unset/'system' theme
      // follows the OS, and the small window must not flash the wrong one
      const want = s.ui.theme ?? 'dark';
      const dark = want === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : want !== 'light';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      // Linux creates this window opaque, where a rounded panel would leave four
      // unfilled-looking corners inside a square window
      document.documentElement.dataset.overlayAlpha = s.ui.overlayAlpha === false ? '0' : '1';
    });
    void window.mcExam.status().then(setStatus);
  }, []);

  const captureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const offShot = window.mcExam.onShot(() => captureRef.current());
    return offShot;
  }, []);

  useEffect(() => {
    const offProg = window.mcExam.onProgress((p) => {
      setScanning(p.scanning);
      setScanCurrent(p.current ?? '');
    });
    const off = window.mcExam.onExamEvent((ev: ExamEvent) => {
      // a main-initiated shot (whole-screen hotkey) has no owning window:
      // begin makes this window the owner before the requestId filter below
      // would have silently dropped the entire run
      if (ev.kind === 'begin') {
        activeRef.current = ev.requestId;
        setError('');
        setNote('');
        setCheck(null);
        setCandidates(null);
        setStage(t.reading);
        setAnswer({ question: '', text: '', origin: 'none', ms: {}, streaming: true });
        return;
      }
      // A phone-driven sub-mode change has no active request in this window, and
      // the "nothing to check yet" caveat is sent with an empty requestId: both
      // must be handled BEFORE the filter below, or the window silently keeps the
      // old mode / drops the global hint.
      if (ev.kind === 'subMode') {
        setSubMode(ev.subMode);
        return;
      }
      if (ev.kind === 'note' && !ev.requestId) {
        setNote(ev.text);
        return;
      }
      if (ev.requestId !== activeRef.current) return;
      switch (ev.kind) {
        case 'stage':
          setStage(
            ev.stage === 'reading'
              ? t.reading
              : ev.stage === 'searching'
                ? t.searching
                : ev.stage === 'searching-web'
                  ? t.webbing
                  : t.thinking,
          );
          break;
        case 'question':
          setAnswer((a) => (a ? { ...a, question: ev.text } : { question: ev.text, text: '', origin: 'none', streaming: true, ms: {} }));
          break;
        case 'note':
          setNote(ev.text);
          break;
        case 'bank':
          setAnswer((a) => ({
            question: a?.question ?? ev.hit.stem,
            text: ev.hit.answer,
            origin: 'bank',
            letter: ev.letter ?? ev.hit.answerKey,
            bank: ev.hit,
            ms: { bank: 0 },
            streaming: true,
          }));
          setStage(t.thinking);
          break;
        case 'ambiguous':
          setCandidates(ev.candidates);
          break;
        case 'delta':
          setAnswer((a) => (a ? { ...a, text: a.origin === 'bank' && !a.streaming ? a.text : a.text + ev.text, streaming: true } : a));
          break;
        case 'done': {
          setAnswer((a) => {
            const text = ev.text || a?.text || '';
            if (subMode === 'personality' && a?.question) {
              setLedger((l) => updateLedger(l, a.question, !/^(不符|不太|没有|不)/.test(text)).ledger);
            }
            return {
              question: a?.question ?? '',
              text,
              origin: ev.origin,
              letter: a?.letter ?? firstLetter(text),
              bank: a?.bank,
              ms: ev.ms,
              streaming: false,
            };
          });
          setStage('');
          setCandidates(null);
          break;
        }
        case 'error':
          setError(ev.message);
          setStage('');
          setAnswer((a) => (a ? { ...a, streaming: false } : a));
          break;
        // The check round rides the same requestId as the answer it reviews; it
        // never touches `answer`, so the original stays visible below the card.
        // All three phases go through one pure reducer (./checkCard): the main
        // process streams every `checkDelta` BEFORE the verdict header, so the
        // first token must open a provisional card and the header must merge
        // into it — replacing it would erase the text the user watched appear.
        case 'check':
        case 'checkDelta':
        case 'checkDone':
          setCheck((c) => applyCheckCard(c, ev));
          break;
      }
    });
    return () => {
      off();
      offProg();
    };
  }, [t, subMode]);

  const ask = useCallback(
    async (opts: { imageDataUrl?: string; question?: string; force?: ExamBankCandidateView; again?: boolean } = {}) => {
      setError('');
      setNote('');
      setCheck(null);
      setCandidates(null);
      setCopied(false);
      const requestId = rid();
      activeRef.current = requestId;
      setStage(t.reading);
      setAnswer({
        question: opts.question ?? opts.force?.stem ?? '',
        text: '',
        origin: 'none',
        bank: opts.force,
        ms: {},
        streaming: true,
      });
      window.mcExam.ask({
        requestId,
        subMode,
        imageDataUrl: opts.imageDataUrl,
        question: opts.question,
        instruction: instruction.trim() || undefined,
        priorAnswer: opts.again ? answer?.text : undefined,
        forceCandidate: opts.force,
      });
    },
    [subMode, instruction, answer, t.reading],
  );

  const capture = useCallback(async () => {
    const img = await window.mcExam.pickRegion();
    if (!img) {
      setStage('');
      return;
    }
    void ask({ imageDataUrl: img });
  }, [ask]);

  captureRef.current = () => void capture();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void capture();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capture]);

  const stop = useCallback(() => {
    if (activeRef.current) window.mcExam.cancel(activeRef.current);
    setAnswer((a) => (a ? { ...a, streaming: false } : a));
    // an aborted round sends neither a verdict header nor a `checkDone` (main
    // returns on AbortError), so a card opened by its tokens would keep a
    // "复核中…" hint with nothing left to close it. Cancel takes the card with it.
    setCheck(null);
    setStage('');
  }, []);

  const copy = useCallback(() => {
    const text = answer?.letter ? `${answer.letter}. ${answer.text}` : answer?.text ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [answer]);

  const bind = useCallback(
    async (mode: ExamSubMode) => {
      const picked = await window.mcExam.bindBank(mode);
      if (picked) setStatus(await window.mcExam.status());
    },
    [],
  );

  const persona: ExamPersona | undefined = settings?.exam?.persona;
  const ledgerCount = useMemo(
    () => Object.values(ledger).reduce((s, v) => s + (v?.times ?? 0), 0),
    [ledger],
  );

  const bankOf = (mode: ExamSubMode) => status?.table?.[mode];
  const reportOf = (mode: ExamSubMode) => status?.banks?.find((b) => b.subMode === mode);

  return (
    <div className="exam">
      <div className="exam-head" title={t.drag}>
        <span className="exam-title">{t.title}</span>
        <div className="exam-modes">
          {MODES.map((m) => (
            <button
              key={m}
              className={`btn btn-sm ${subMode === m ? 'btn-on' : ''}`}
              title={t.subModeTitle}
              onClick={() => {
                setSubMode(m);
                void window.mcExam.setSubMode(m);
              }}
            >
              {t.subModes[m]}
            </button>
          ))}
        </div>
        <button className="btn btn-sm btn-close" title={t.hideTitle} onClick={() => window.mcExam.hide()}>
          {t.hide}
        </button>
      </div>

      <div className="exam-body">
        <div className="exam-row">
          <button className="btn btn-primary" onClick={() => void capture()} disabled={!!stage}>
            {t.capture}
          </button>
          {answer?.streaming || check?.streaming ? (
            <button className="btn" onClick={stop}>
              {t.stop}
            </button>
          ) : null}
          {answer?.text ? (
            <button className="btn" onClick={copy}>
              {copied ? t.copied : t.copy}
            </button>
          ) : null}
          {stage ? <span className="exam-hint">{stage}</span> : null}
        </div>

        {error ? <div className="exam-card exam-badge warn">{error}</div> : null}
        {note ? <div className="exam-hint">{note}</div> : null}

        {answer ? (
          <div className="exam-card exam-answer" data-origin={answer.origin}>
            <div className="exam-row">
              <span className={`exam-badge ${answer.origin === 'bank' ? 'good' : ''}`}>
                {t.origins[answer.origin] ?? answer.origin}
              </span>
              {answer.ms?.total ? <span className="exam-meta">{t.msLabel(answer.ms.total)}</span> : null}
              {answer.bank?.ref ? (
                <span className="exam-meta">
                  {t.sourceLabel}: {answer.bank.ref}
                  {answer.bank.section ? ` · ${answer.bank.section}` : ''}
                </span>
              ) : null}
            </div>
            {answer.question ? (
              <>
                <div className="exam-label" style={{ marginTop: 4 }}>
                  {t.questionLabel}
                </div>
                <div className="exam-q">{answer.question}</div>
              </>
            ) : null}
            {answer.bank?.options?.length ? (
              <div style={{ marginTop: 4 }}>
                {answer.bank.options.map((o) => (
                  <span key={o.key} className={`exam-opt ${answer.bank?.answerKey === o.key ? 'hit' : ''}`}>
                    {o.key}. {o.text}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="exam-a">
              {answer.letter && answer.origin === 'bank' ? <span className="exam-big">{answer.letter}</span> : null}
              {answer.origin === 'bank' ? ' ' : ''}
              <MathText text={answer.text} codeLabels={t.codeLabels} />
              {answer.streaming && !answer.text ? <span>▍</span> : null}
            </div>
            {answer.bank?.explanation && answer.origin === 'bank' ? (
              <>
                <div className="exam-label" style={{ marginTop: 4 }}>
                  {t.explainLabel}
                </div>
                <div className="exam-q">{answer.bank.explanation}</div>
              </>
            ) : null}
            <div className="exam-hint" style={{ marginTop: 4 }}>
              {answer.origin === 'bank' || answer.origin === 'bank+model' ? t.originBankHint : t.originModelHint}
            </div>
          </div>
        ) : null}

        {check ? (
          <div className="exam-card exam-check" data-verdict={check.verdict} data-streaming={check.streaming ? '1' : undefined}>
            <div className="exam-row">
              <span className={`exam-badge ${check.verdict === 'ok' ? 'good' : check.verdict === 'fix' ? 'warn' : ''}`}>
                {/* a provisional card (its tokens ran ahead of the verdict header) is
                    still running, not a failed round: 复核未完成 would report a
                    verdict the checker has not produced yet */}
                {check.streaming && check.verdict === 'unknown' ? t.checkThinking : t.checkTitle[check.verdict]}
              </span>
              <span className="exam-meta">{t.checkTurn(check.turn)}</span>
              {check.ms ? <span className="exam-meta">{t.msLabel(check.ms)}</span> : null}
            </div>
            {check.note ? <div className="exam-check-note">{check.note}</div> : null}
            {check.revision ? (
              <div className="exam-check-rev">
                <MathText text={check.revision} codeLabels={t.codeLabels} />
              </div>
            ) : null}
            {check.streaming && check.verdict !== 'unknown' ? <span className="exam-hint">{t.checkThinking}</span> : null}
          </div>
        ) : null}

        {candidates?.length ? (
          <div className="exam-card">
            <div className="exam-label">{t.candidates}</div>
            {candidates.map((c) => (
              <button key={c.stem} className="exam-cand" onClick={() => void ask({ question: c.stem, force: c })}>
                <span className="exam-cand-q">{c.stem}</span>
                <span className="exam-cand-a">
                  {c.answerKey ? `${c.answerKey}. ` : ''}
                  {c.answer}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {answer?.text && !answer.streaming ? (
          <div className="exam-row">
            <input
              className="exam-input"
              placeholder={t.reaskPlaceholder}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void ask({ question: answer.question, again: true });
              }}
            />
            <button className="btn" onClick={() => void ask({ question: answer.question, again: true })}>
              {t.reask}
            </button>
            {/* no requestId travels: the main process checks the one answer in
                its own lastExam slot, so this and the phone re-check the same题.
                Gated on any in-flight round, not just the check: lastExam is only
                written at `done`, so a mid-ask press would be a silent no-op. */}
            <button
              className="btn"
              disabled={!!check?.streaming || !!answer?.streaming || !!stage}
              onClick={() => window.mcExam.check(instruction.trim() || undefined)}
            >
              {t.checkAgain}
            </button>
          </div>
        ) : null}

        <div className="exam-card">
          <div className="exam-row">
            <span className="exam-label" style={{ margin: 0 }}>
              {t.bankTitle}
            </span>
            <span className="exam-badge">{t.subModes[subMode]}</span>
            <button className="btn btn-sm" onClick={() => void bind(subMode)}>
              {t.bankBind}
            </button>
            <button
              className="btn btn-sm"
              disabled={scanning}
              onClick={() =>
                void window.mcExam.rescan(subMode).then((s) => {
                  setStatus(s);
                  setScanning(false);
                })
              }
            >
              {t.bankRescan}
            </button>
            {scanning ? <span className="exam-hint">{t.bankScanning(scanCurrent)}</span> : null}
          </div>
          {(() => {
            const b = bankOf(subMode);
            const r = reportOf(subMode);
            if (!b?.entries) return <div className="exam-hint">{t.bankEmpty}</div>;
            return (
              <div className="exam-meta">
                <span>{t.bankCount(b.entries, b.mc, r?.unanswered ?? 0)}</span>
                {r?.duplicates ? <span title={t.bankDupTitle}>{t.bankDup(r.duplicates)}</span> : null}
                {r?.conflicts ? <span title={t.bankConflictTitle}>{t.bankConflict(r.conflicts)}</span> : null}
                {r?.skipped?.length ? <span>{t.bankSkipped(r.skipped.length)}</span> : null}
                {r?.skipped?.slice(0, 3).map((s) => (
                  <span key={s.name} title={s.reason}>
                    {s.name}
                  </span>
                ))}
              </div>
            );
          })()}
          <div className="exam-row" style={{ marginTop: 6 }}>
            <input
              className="exam-input"
              placeholder={t.bankProbeInput}
              title={t.bankProbeTitle}
              value={probeQ}
              onChange={(e) => setProbeQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && probeQ.trim())
                  void window.mcExam.probeBank(subMode, probeQ.trim()).then(setProbeHits);
              }}
            />
            <button
              className="btn btn-sm"
              disabled={!probeQ.trim()}
              onClick={() => void window.mcExam.probeBank(subMode, probeQ.trim()).then(setProbeHits)}
            >
              {t.bankProbe}
            </button>
            {/* the full chain on typed text: the way to use this with no vision model
                and no OCR installed, i.e. exactly when reading the screen is blind */}
            <button
              className="btn btn-sm btn-primary"
              disabled={!probeQ.trim() || !!stage}
              onClick={() => void ask({ question: probeQ.trim() })}
            >
              {t.askTyped}
            </button>
          </div>
          {probeHits ? (
            probeHits.length ? (
              probeHits.map((h) => (
                <div key={h.stem} className="exam-meta">
                  <span className="exam-badge good">{t.bankProbeHit(h.score.toFixed(2))}</span>
                  <span>{h.stem}</span>
                  <span className="exam-cand-a">
                    {h.answerKey ? `${h.answerKey}. ` : ''}
                    {h.answer}
                  </span>
                </div>
              ))
            ) : (
              <div className="exam-hint">{t.bankProbeEmpty}</div>
            )
          ) : null}
        </div>

        <div className="exam-card">
          <div className="exam-label">{t.personaTitle}</div>
          {subMode === 'personality' ? (
            <>
              <div className="exam-hint">{persona ? t.personaOn(persona.role ?? '', persona.targets.length) : t.personaNone}</div>
              {ledgerCount ? <div className="exam-hint">{t.personaLedger(ledgerCount)}</div> : null}
              <div className="exam-row" style={{ marginTop: 4 }}>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void window.mcExam.researchPersona(persona?.role ?? settings?.llm.model ?? '', persona?.company ?? '').then((p) => {
                      if (p) void window.mcExam.getSettings().then(setSettings);
                    })
                  }
                >
                  {t.personaResearch}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void window.mcExam.setPersona(defaultPersona()).then(() => void window.mcExam.getSettings().then(setSettings))
                  }
                >
                  {t.personaDefault}
                </button>
                <button className="btn btn-sm" onClick={() => setLedger({})}>
                  {t.personaReset}
                </button>
              </div>
            </>
          ) : (
            <div className="exam-hint">
              {persona ? t.personaOn(persona.role ?? '', persona.targets.length) : t.personaNone}
            </div>
          )}
          {subMode === 'personality' && persona ? (
            <details style={{ marginTop: 4 }}>
              <summary className="exam-hint">{buildPersonaBlock(persona, ledger).split('\n')[0]}</summary>
              <div className="exam-q" style={{ maxHeight: '10em' }}>
                {buildPersonaBlock(persona, ledger)}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** the leading A-H letter of a short answer, when the model wrote one */
function firstLetter(text: string): string | undefined {
  const m = text.trim().match(/^([A-H])(?![a-z])/);
  return m?.[1];
}
