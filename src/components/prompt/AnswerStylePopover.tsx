import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { AnswerExpertise, AnswerRichness } from '../../../shared/answerStyle';
import type { AnswerPersona } from '../../../shared/personas';

const RICHNESS: AnswerRichness[] = ['concise', 'standard', 'detailed'];
const EXPERTISE: AnswerExpertise[] = ['casual', 'professional', 'technical'];

/** what one 🎚 pick commits — a narrow patch so main can tell the prefix changed */
export type AnswerStylePick = {
  answerRichness?: AnswerRichness;
  answerExpertise?: AnswerExpertise;
  activePersonaId?: string;
};

/**
 * 🎚 回答风格 popover: the three knobs worth turning between two questions —
 * how much to say, how technical it is, and who is speaking. Each pick commits
 * one narrow settings patch; those layers ride the stable prompt prefix, so
 * main re-warms the provider cache and the NEXT answer already reflects it
 * without restarting capture.
 */
export function AnswerStylePopover({
  richness,
  expertise,
  personas,
  activePersonaId,
  onPick,
  onManagePersonas,
}: {
  richness: AnswerRichness;
  expertise: AnswerExpertise;
  personas: AnswerPersona[];
  activePersonaId: string;
  onPick: (pick: AnswerStylePick) => void;
  onManagePersonas: () => void;
}) {
  const s = useT().answerStyle;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', off);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="tb-menu-wrap" ref={ref}>
      <button
        className={`btn btn-icon${open ? ' btn-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={s.buttonTitle}
        aria-label={s.buttonTitle}
      >
        🎚
      </button>
      {open && (
        <div className="style-pop" role="menu">
          <div className="style-pop-row">
            <span className="style-pop-label">{s.richness}</span>
            <div className="mode-seg">
              {RICHNESS.map((r) => (
                <button key={r} className={r === richness ? 'on' : ''} onClick={() => onPick({ answerRichness: r })}>
                  {s.labels[r]}
                </button>
              ))}
            </div>
          </div>
          <div className="style-pop-hint">{s.hints[richness]}</div>
          <div className="style-pop-row">
            <span className="style-pop-label">{s.expertise}</span>
            <div className="mode-seg">
              {EXPERTISE.map((x) => (
                <button
                  key={x}
                  className={x === expertise ? 'on' : ''}
                  onClick={() => onPick({ answerExpertise: x })}
                >
                  {s.labels[x]}
                </button>
              ))}
            </div>
          </div>
          <div className="style-pop-row">
            <span className="style-pop-label">{s.persona}</span>
            <select
              className="style-pop-select"
              value={activePersonaId}
              onChange={(e) => onPick({ activePersonaId: e.target.value })}
            >
              <option value="">{s.personaNone}</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="tb-menu-item"
            onClick={() => {
              setOpen(false);
              onManagePersonas();
            }}
          >
            {s.personaManage}
          </button>
        </div>
      )}
    </div>
  );
}
