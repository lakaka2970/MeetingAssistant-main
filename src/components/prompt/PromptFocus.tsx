import { useEffect, useRef, useState } from 'react';
import type { KbSlot, StoredSession } from '../../../shared/protocol';
import { useT } from '../../i18n';
import { MathText } from '../MathText';
import { focusTurn, type AnswerTurn } from './focusTurn';

export type { AnswerTurn, TurnKind } from './focusTurn';

/**
 * The teleprompter (子项目② main view): one question line, one big answer
 * card, everything else demoted. Answers still accumulate in the session, but
 * only the FOCUS turn is rendered large — by default the newest one; clicking
 * a summary row pins an older answer so you can keep reading it while the next
 * answer streams (a fresh streaming turn always releases the pin). Those rows
 * sit behind a 「历史回答 · N」 toggle that is folded by default — the focus card
 * is what the user reads mid-meeting, so it gets the height.
 *
 * A turn can carry a knowledge-base hit: the prepared answer is printed
 * verbatim first, in the largest type on screen (it is what the user came here
 * to say); the streamed AI text under it is enrichment, and reasoning / web
 * sources / QA provenance stay collapsed.
 */
export function PromptFocus({
  sessions,
  currentId,
  turns,
  resumeName,
  resumeChars,
  jdName,
  jdChars,
  notice,
  visionReady,
  answersReady,
  answersHint,
  onSwitch,
  onNew,
  onDelete,
  onRename,
  onPickKb,
  onClearKb,
  historyOpen,
  onToggleHistory,
  onCancel,
  onClear,
  onFreeAsk,
  onShotAsk,
}: {
  sessions: StoredSession[];
  currentId: string;
  turns: AnswerTurn[];
  resumeName?: string;
  resumeChars: number;
  jdName?: string;
  jdChars: number;
  /** transient parse warning (e.g. scanned PDF with no text layer) */
  notice?: string | null;
  visionReady: boolean;
  /** false = no LLM configured; asking is disabled with an explanation */
  answersReady: boolean;
  answersHint: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onPickKb: (slot: KbSlot) => void;
  onClearKb: (slot: KbSlot) => void;
  /** v1.0.1 ②: the history list is folded by default — settings-owned, so the
      choice survives a restart */
  historyOpen: boolean;
  onToggleHistory: (open: boolean) => void;
  onCancel: (id: string) => void;
  onClear: () => void;
  onFreeAsk: (question: string) => void;
  onShotAsk: (question: string, imageDataUrl?: string) => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const currentName = sessions.find((s) => s.id === currentId)?.name ?? '';
  const { focus, follow } = focusTurn(turns, pinnedId);

  // the question strip is a glance affordance; a new focus turn folds it back
  useEffect(() => {
    setLabelOpen(false);
  }, [focus?.id]);

  const submit = () => {
    const q = inputRef.current?.value.trim();
    if (!q) return;
    onFreeAsk(q);
    if (inputRef.current) inputRef.current.value = '';
  };

  const body = (turn: AnswerTurn) =>
    turn.status === 'error' ? (
      <span className="answer-error">{turn.error}</span>
    ) : (
      <>
        {turn.qa && (
          <div className="turn-qa" data-exact={turn.qa.exact ? '1' : '0'}>
            <div className="turn-qa-head">
              <span className="turn-qa-badge">
                {turn.qa.exact ? t.answer.qaBadgeExact : t.answer.qaBadge}
              </span>
              <span className="turn-qa-q" title={turn.qa.question}>
                {turn.qa.question}
              </span>
              {turn.qa.ref && <span className="turn-qa-ref">{turn.qa.ref}</span>}
            </div>
            <div className="turn-qa-body prompt-answer">
              <MathText text={turn.qa.answer} />
            </div>
          </div>
        )}
        {turn.qa && <div className="turn-qa-note">{t.answer.qaEnrichedNote}</div>}
        {!!turn.reasoning && (
          <details className="turn-reasoning">
            <summary>{t.answer.reasoningToggle}</summary>
            <div className="turn-reasoning-body">{turn.reasoning}</div>
          </details>
        )}
        {turn.text ? (
          <MathText text={turn.text} />
        ) : turn.kind === 'vision' ? (
          t.answer.visionWaiting
        ) : (
          t.answer.genWaiting
        )}
        {turn.status === 'streaming' && <span className="cursor">▍</span>}
        {(turn.webSup || turn.webPending) && (
          <div className="turn-web-sup">
            <span className="turn-web-sup-badge">🌐 {t.answer.webSupHeading}</span>
            {turn.webSup ? (
              <div className="turn-web-sup-body">
                <MathText text={turn.webSup} />
              </div>
            ) : (
              <div className="turn-web-sup-hint">{t.answer.webSearching}</div>
            )}
          </div>
        )}
        {!!turn.web?.length && (
          <div className="turn-web">
            <span className="turn-web-badge">{t.answer.webBadge}</span>
            {turn.web.map((s, i) => (
              <span key={i} className="turn-web-src" title={s.url}>
                {i + 1}. {s.title}
              </span>
            ))}
          </div>
        )}
      </>
    );

  return (
    <section className="prompt-focus">
      <header className="pane-head session-bar">
        {editing ? (
          <input
            className="session-select"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              onRename(currentId, nameDraft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename(currentId, nameDraft);
                setEditing(false);
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
          />
        ) : (
          <select
            className="session-select"
            value={currentId}
            onChange={(e) => onSwitch(e.target.value)}
            title={t.answer.switchTitle}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn btn-sm"
          onClick={() => {
            setNameDraft(currentName);
            setEditing(true);
          }}
          title={t.answer.renameTitle}
        >
          ✎
        </button>
        <button className="btn btn-sm" onClick={onNew} title={t.answer.newTitle}>
          ＋
        </button>
        <button className="btn btn-sm" onClick={() => onDelete(currentId)} title={t.answer.deleteTitle}>
          🗑
        </button>
        <button
          className={resumeChars > 0 ? 'btn btn-sm btn-on' : 'btn btn-sm'}
          onClick={() => onPickKb('resume')}
          title={
            resumeChars > 0
              ? t.answer.resumeSetTitle(resumeName ?? '', resumeChars)
              : t.answer.resumeEmptyTitle
          }
        >
          📄{resumeChars > 0 ? resumeName ?? t.answer.resume : t.answer.resume}
        </button>
        {resumeChars > 0 && (
          <button className="btn btn-sm" onClick={() => onClearKb('resume')} title={t.answer.resumeRemoveTitle}>
            ×
          </button>
        )}
        <button
          className={jdChars > 0 ? 'btn btn-sm btn-on' : 'btn btn-sm'}
          onClick={() => onPickKb('jd')}
          title={jdChars > 0 ? t.answer.jdSetTitle(jdName ?? '', jdChars) : t.answer.jdEmptyTitle}
        >
          📋{jdChars > 0 ? jdName ?? t.answer.jd : t.answer.jd}
        </button>
        {jdChars > 0 && (
          <button className="btn btn-sm" onClick={() => onClearKb('jd')} title={t.answer.jdRemoveTitle}>
            ×
          </button>
        )}
        <span className="session-spacer" />
        <button className="btn btn-sm" onClick={onClear} title={t.answer.clearTitle}>
          {t.answer.clear}
        </button>
      </header>
      {notice && <div className="kb-notice">{notice}</div>}

      {!focus ? (
        <div className="pane-empty prompt-empty">
          {t.answer.empty}
          {resumeChars === 0 && t.answer.emptyKbHint}
        </div>
      ) : (
        <>
          <button
            className={`prompt-q${labelOpen ? ' prompt-q-open' : ''}`}
            title={focus.label}
            onClick={() => setLabelOpen((v) => !v)}
          >
            <span className="turn-tag">{t.answer.kindTag[focus.kind]}</span>
            <span className="prompt-q-text">{focus.label}</span>
          </button>

          <div className={`prompt-card turn turn-${focus.kind}`}>
            <div className="turn-head">
              <span className="session-spacer" />
              {focus.status === 'streaming' ? (
                <button className="btn btn-sm" onClick={() => onCancel(focus.id)}>
                  {t.answer.stop}
                </button>
              ) : (
                <button
                  className="btn btn-sm"
                  onClick={() => void navigator.clipboard.writeText(focus.text)}
                  title={t.answer.copyTitle}
                >
                  {t.answer.copy}
                </button>
              )}
            </div>
            <div className="turn-body prompt-body">{body(focus)}</div>
          </div>

          {!follow && (
            <div className="prompt-pinbar">
              <span>{t.answer.pinnedNote}</span>
              <button className="btn btn-sm" onClick={() => setPinnedId(null)}>
                {t.answer.unpin}
              </button>
            </div>
          )}

          {turns.length > 1 && (
            <div className="prompt-history">
              <button
                className="prompt-hx-toggle"
                onClick={() => onToggleHistory(!historyOpen)}
                title={historyOpen ? t.answer.historyCollapseTitle : t.answer.historyExpandTitle}
              >
                <span className="prompt-hx-caret">{historyOpen ? '▾' : '▸'}</span>
                <span>{t.answer.historyTitle(turns.length - 1)}</span>
              </button>
              {historyOpen && (
                <div className="prompt-hx-list">
                  {turns
                    .filter((x) => x.id !== focus.id)
                    .slice()
                    .reverse()
                    .map((x) => (
                      <button
                        key={x.id}
                        className="prompt-hx"
                        title={x.label}
                        onClick={() => setPinnedId(x.id)}
                      >
                        <span className="turn-tag">{t.answer.kindTag[x.kind]}</span>
                        <span className="prompt-hx-text">{x.label}</span>
                        {x.status === 'error' && <span className="tag tag-err">!</span>}
                        {x.status === 'streaming' && <span className="tag tag-wait">…</span>}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!answersReady && <div className="kb-notice">{answersHint}</div>}
      <div className="answer-input">
        <input
          ref={inputRef}
          disabled={!answersReady}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          }}
          placeholder={answersReady ? t.answer.freePlaceholder : answersHint}
        />
        <button
          className="btn btn-primary"
          disabled={!answersReady}
          title={answersReady ? undefined : answersHint}
          onClick={submit}
        >
          {t.answer.ask}
        </button>
        {visionReady && (
          <button
            className="btn"
            title={t.answer.shotTitle}
            onClick={async () => {
              const q = inputRef.current?.value.trim() ?? '';
              const img = await window.mc.pickRegion();
              if (!img) return; // cancelled
              if (inputRef.current) inputRef.current.value = '';
              onShotAsk(q, img);
            }}
          >
            📷
          </button>
        )}
      </div>
    </section>
  );
}
