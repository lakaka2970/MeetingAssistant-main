import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TranscriptSegment } from '../../../shared/transcript';
import { clampRailSplit } from '../../../shared/protocol';
import { useT } from '../../i18n';
import { TranscriptPanel } from '../TranscriptPanel';

/**
 * The transcript shown as chat bubbles in a narrow side rail (子项目② main
 * view): every finished sentence wraps in full inside its bubble, colored by
 * speaker, with ⚡答 / 译 / 复制 revealed on hover. Live partials ride at the
 * bottom. The ⤢ button in the rail header opens the FULL TranscriptPanel as an
 * overlay inside the prompt shell — selection-ask and clearing keep living in
 * that component untouched.
 *
 * The thin strip on the rail's right edge drags the rail wider/narrower. The
 * drag writes the shell's `--rail-split` CSS variable directly (no React
 * re-render per pointermove); only the final pointerup commits to settings.
 */
export function TranscriptRail({
  segments,
  partials,
  answersReady,
  answersHint,
  onAsk,
  onTranslate,
  onClear,
  railSplit,
  onCommitRailSplit,
}: {
  segments: TranscriptSegment[];
  partials?: { them?: string; me?: string };
  answersReady: boolean;
  answersHint: string;
  onAsk: (text: string) => void;
  onTranslate: (seg: TranscriptSegment) => void;
  onClear: () => void;
  railSplit: number;
  onCommitRailSplit: (ratio: number) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  /** live drag state; ratio kept here so pointerup can commit the final value */
  const dragRef = useRef<{ startX: number; startRatio: number; shellW: number; ratio: number } | null>(null);
  /** false while the user has scrolled up to re-read — a ref, no re-render */
  const stickRef = useRef(true);

  // follow the live edge only while stuck to it; scrolling up pauses the follow.
  // `expanded` is a dependency so returning from the full panel lands on the
  // newest line again (the rail's scroll box is remounted on every toggle).
  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [segments, partials, expanded]);

  const onRowsScroll = () => {
    const el = boxRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const onResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const shell = (e.currentTarget as HTMLElement).closest('.prompt-shell') as HTMLElement | null;
    if (!shell) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startRatio: railSplit, shellW: shell.clientWidth, ratio: railSplit };
  };

  const onResizerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const shell = (e.currentTarget as HTMLElement).closest('.prompt-shell') as HTMLElement | null;
    if (!shell) return;
    d.ratio = clampRailSplit(d.startRatio + (e.clientX - d.startX) / (d.shellW || 1));
    shell.style.setProperty('--rail-split', String(d.ratio));
  };

  const onResizerPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.ratio !== d.startRatio) onCommitRailSplit(d.ratio);
  };

  if (expanded) {
    return (
      <div className="rail-expand">
        <button
          className="btn btn-icon rail-expand-close"
          onClick={() => {
            stickRef.current = true;
            setExpanded(false);
          }}
          title={t.settings.closeTitle}
          aria-label={t.settings.closeTitle}
        >
          ✕
        </button>
        <TranscriptPanel
          segments={segments}
          partials={partials}
          answersReady={answersReady}
          answersHint={answersHint}
          onAsk={onAsk}
          onTranslate={onTranslate}
          onClear={onClear}
        />
      </div>
    );
  }

  return (
    <>
      <div className="transcript-rail">
        <div className="rail-head">
          <span className="rail-title">{t.transcript.title}</span>
          <button
            className="btn btn-icon rail-open"
            onClick={() => setExpanded(true)}
            title={t.transcript.expandTitle}
            aria-label={t.transcript.expandTitle}
          >
            ⤢
          </button>
        </div>
        <div className="rail-rows" ref={boxRef} onScroll={onRowsScroll}>
          {segments.map((s) => {
            const me = s.speaker === 'me';
            return (
              <div key={s.id} className={`rail-bubble ${me ? 'rail-me' : 'rail-them'}`}>
                <div className="rail-bubble-role">{me ? t.transcript.me : t.transcript.them}</div>
                <div className="rail-bubble-text">{s.text}</div>
                {(s.translation || s.translating) && (
                  <div className="rail-bubble-trans">
                    {s.translating ? t.transcript.translating : s.translation}
                  </div>
                )}
                <div className="rail-bubble-btns">
                  <button
                    className="rail-btn"
                    title={t.transcript.copyTitle}
                    onClick={() => void navigator.clipboard.writeText(s.text)}
                  >
                    ⧉
                  </button>
                  <button
                    className="rail-btn"
                    title={t.transcript.translateTitle}
                    onClick={() => onTranslate(s)}
                  >
                    {t.transcript.translateBtn}
                  </button>
                  {!me && (
                    <button
                      className="rail-btn rail-btn-ask"
                      disabled={!answersReady}
                      title={answersReady ? t.transcript.answerTitle : answersHint}
                      onClick={() => onAsk(s.text)}
                    >
                      {t.transcript.answerBtn}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {partials?.them && (
            <div className="rail-bubble rail-them rail-live">
              <div className="rail-bubble-role">{`${t.transcript.them} · ${t.transcript.live}`}</div>
              <div className="rail-bubble-text">{partials.them}</div>
            </div>
          )}
          {partials?.me && (
            <div className="rail-bubble rail-me rail-live">
              <div className="rail-bubble-role">{`${t.transcript.me} · ${t.transcript.live}`}</div>
              <div className="rail-bubble-text">{partials.me}</div>
            </div>
          )}
          {segments.length === 0 && !partials?.them && !partials?.me && (
            <div className="rail-empty">{t.transcript.empty}</div>
          )}
        </div>
      </div>
      <div
        className="rail-resizer"
        onPointerDown={onResizerPointerDown}
        onPointerMove={onResizerPointerMove}
        onPointerUp={onResizerPointerUp}
        onPointerCancel={onResizerPointerUp}
      />
    </>
  );
}
