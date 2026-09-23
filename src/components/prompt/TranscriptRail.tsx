import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TranscriptSegment } from '../../../shared/transcript';
import { clampRailSplit } from '../../../shared/protocol';
import { useT } from '../../i18n';
import { TranscriptPanel } from '../TranscriptPanel';

/**
 * The transcript demoted to a narrow glance rail (子项目② main view): one line
 * per finished sentence, speaker color-coded, live partials pinned at the
 * bottom. Click anywhere and the FULL TranscriptPanel opens as an overlay
 * inside the prompt shell — selection-ask, translation and clearing all keep
 * living in that component untouched.
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

  // the rail is glance-only — it always trails the live edge, no stick logic
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments, partials]);

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
          onClick={() => setExpanded(false)}
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
      <div className="transcript-rail" onClick={() => setExpanded(true)} title={t.transcript.expandTitle}>
        <div className="rail-rows" ref={boxRef}>
          {segments.map((s) => (
            <div key={s.id} className={`rail-row ${s.speaker === 'me' ? 'rail-me' : 'rail-them'}`}>
              <span className="rail-dot" />
              <span className="rail-text">{s.text}</span>
            </div>
          ))}
          {partials?.them && (
            <div className="rail-row rail-them rail-live">
              <span className="rail-dot" />
              <span className="rail-text">{partials.them}</span>
            </div>
          )}
          {partials?.me && (
            <div className="rail-row rail-me rail-live">
              <span className="rail-dot" />
              <span className="rail-text">{partials.me}</span>
            </div>
          )}
          {segments.length === 0 && !partials?.them && !partials?.me && (
            <div className="rail-row rail-empty">{t.transcript.empty}</div>
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
