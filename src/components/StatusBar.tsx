import type { AsrUiState, HudStats } from '../App';
import { chipTone, type ChipTone, type ServiceHealthReport } from '../../shared/healthState';
import { useT } from '../i18n';

/** one glyph per tone — the chips must stay readable at 10px in a 28px bar */
const MARK: Record<ChipTone, string> = { ok: '✓', busy: '…', bad: '!', none: '–' };

export function StatusBar({
  asr,
  capturing,
  hud,
  health,
  cacheHitRate,
  ragState,
  onOpenHealth,
  onOpenKnowledge,
}: {
  asr: AsrUiState;
  capturing: boolean;
  hud?: HudStats;
  /** absent until the settings snapshot has loaded */
  health?: ServiceHealthReport;
  /** upgrade P1: prefix-cache hit rate over the last 10 answers (null = n/a) */
  cacheHitRate?: number | null;
  /** upgrade P0: embed worker lifecycle for the RAG chip */
  ragState?: 'idle' | 'loading' | 'ready' | 'error' | 'off';
  onOpenHealth: () => void;
  onOpenKnowledge: () => void;
}) {
  const t = useT();
  const ragTone: ChipTone =
    ragState === 'ready' ? 'ok' : ragState === 'error' ? 'bad' : ragState === 'off' ? 'none' : 'busy';
  const ragLabel =
    ragState === 'off' ? '–' : ragState === 'ready' ? t.knowledge.stateReady : ragState === 'error' ? '!' : '…';
  return (
    <footer className="statusbar">
      <div className="status-left">
        {asr.phase === 'loading' && <span className="tag tag-wait">{t.status.state.loading}</span>}
        {asr.phase === 'error' && <span className="tag tag-err">{t.status.engineError}</span>}
        {asr.phase === 'ready' && (
          <>
            <span className={capturing ? 'tag tag-live' : 'tag'}>
              {capturing ? t.status.state[asr.workerState] : t.status.idle}
            </span>
            <span className={asr.gpuSuspect ? 'tag tag-err' : 'tag tag-ok'}>
              {asr.gpuSuspect ? t.status.gpuBad : t.status.gpuOk}
            </span>
          </>
        )}
        {asr.lastError && (
          <span className="tag tag-err" title={asr.lastError}>
            ⚠
          </span>
        )}
        {/* compact service health; the panel behind it carries the detail */}
        {health && (
          <button className="health-chips" onClick={onOpenHealth} title={t.health.chipsTitle}>
            <span className={`health-chip is-${chipTone(health.asr)}`}>
              {t.health.chipAsr} {MARK[chipTone(health.asr)]}
            </span>
            <span className={`health-chip is-${chipTone(health.llm)}`}>
              {t.health.chipLlm} {MARK[chipTone(health.llm)]}
            </span>
            <span className={`health-chip is-${chipTone(health.audio)}`}>
              {t.health.chipAudio} {MARK[chipTone(health.audio)]}
            </span>
          </button>
        )}
        {/* upgrade P0: RAG worker state → knowledge panel */}
        <button
          className={`health-chip is-${ragTone}`}
          onClick={onOpenKnowledge}
          title={t.status.ragTitle(ragLabel)}
        >
          {t.status.ragChip} {ragLabel}
        </button>
        {/* upgrade P1: prefix-cache hit rate */}
        {typeof cacheHitRate === 'number' && (
          <span
            className={`health-chip is-${cacheHitRate >= 60 ? 'ok' : cacheHitRate >= 20 ? 'busy' : 'bad'}`}
            title={t.status.cacheTitle(`${cacheHitRate}%`)}
          >
            {t.status.cacheChip} {cacheHitRate}%
          </span>
        )}
      </div>
      {hud && (
        <div className="status-hud" title={t.status.hudTitle}>
          {hud.lastE2eMs !== undefined ? (
            <>
              <span>{(hud.lastE2eMs / 1000).toFixed(2)}s</span>
              <span className="dim">
                p50 {hud.p50 !== undefined ? (hud.p50 / 1000).toFixed(2) : '–'} · p95{' '}
                {hud.p95 !== undefined ? (hud.p95 / 1000).toFixed(2) : '–'}
              </span>
              <span className="dim">
                {t.status.infer} {hud.lastInferMs}ms
              </span>
            </>
          ) : (
            <span className="dim">{t.status.hudWaiting}</span>
          )}
        </div>
      )}
    </footer>
  );
}
