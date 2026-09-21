import { useState } from 'react';
import type { PublicSettings } from '../../shared/protocol';
import type { ServiceHealthReport } from '../../shared/healthState';
import { OverlayShell } from './OverlayShell';
import { AsrTab } from './settings/AsrTab';
import { GeneralTab } from './settings/GeneralTab';
import { HealthTab } from './settings/HealthTab';
import { KnowledgeTab } from './settings/KnowledgeTab';
import { ModelTab } from './settings/ModelTab';
import { RoutingTab } from './settings/RoutingTab';
import { useSettingsDraft } from './settings/useSettingsDraft';
import { VisionTab } from './settings/VisionTab';
import type { SettingsTab } from './settings/types';

/** draft tabs commit through the shared 保存 row; knowledge/health act per-row */
const DRAFT_TABS: SettingsTab[] = ['model', 'routing', 'asr', 'vision', 'general'];

/**
 * The settings hub: one overlay for everything that used to be a separate
 * panel — BYOK model/routing/ASR/vision, 知识库, 服务状态 and 通用. The model
 * rows are all on one tab now (provider, endpoint, key, 思考强度), so "which
 * model answers, and how hard does it think" is a single screen. Draft state
 * lives in useSettingsDraft; this container only owns tab selection and the
 * commit row, which shows only on the draft tabs.
 */
export function SettingsPanel({
  settings,
  onSaved,
  onClose,
  onRerunWizard,
  onOpenDiagnostics,
  onOpenHelp,
  health,
  sessionId,
  onSettingsRefreshed,
  initialTab = 'model',
}: {
  settings: PublicSettings;
  onSaved: (s: PublicSettings) => void;
  onClose: () => void;
  /** opens the first-run wizard again (main window stays alive) */
  onRerunWizard?: () => void;
  /** 通用/服务状态 entry into the local support report */
  onOpenDiagnostics?: () => void;
  /** in-app help center (also reachable from the tray) */
  onOpenHelp?: () => void;
  /** service health report, shown on the 服务状态 tab */
  health?: ServiceHealthReport;
  /** current interview — scopes the 知识库 retrieval preview */
  sessionId?: string;
  /** re-read public settings after a health-tab connection test */
  onSettingsRefreshed?: (s: PublicSettings) => void;
  /** which tab to land on (📚 → knowledge, status chip → health, ⚙ → model) */
  initialTab?: SettingsTab;
}) {
  const d = useSettingsDraft(settings, onSaved);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const isDraftTab = DRAFT_TABS.includes(tab);
  const noop = () => {};

  return (
    <OverlayShell title={d.t.titlebar.settingsTitle} onClose={onClose} variant="settings-hub">
      <div className="settings-tabs" role="tablist">
        {d.TABS.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={tab === tb.id}
            className={`settings-tab${tab === tb.id ? ' settings-tab-active' : ''}`}
            onClick={() => setTab(tb.id)}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'model' && <ModelTab d={d} />}
      {tab === 'routing' && <RoutingTab d={d} />}
      {tab === 'asr' && <AsrTab d={d} />}
      {tab === 'vision' && <VisionTab d={d} />}
      {tab === 'knowledge' && <KnowledgeTab sessionId={sessionId} />}
      {tab === 'health' && health && (
        <HealthTab
          settings={settings}
          health={health}
          onOpenModelTab={() => setTab('model')}
          onOpenDiagnostics={onOpenDiagnostics ?? noop}
          onSettingsRefreshed={onSettingsRefreshed ?? noop}
        />
      )}
      {tab === 'general' && (
        <GeneralTab
          d={d}
          onRerunWizard={onRerunWizard}
          onOpenDiagnostics={onOpenDiagnostics}
          onOpenHelp={onOpenHelp}
        />
      )}

      {isDraftTab && d.confirmWeak && (
        <div className="settings-warn">
          <div>{d.t.settings.weakCryptoWarning}</div>
          <div className="settings-actions" style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={() => d.setConfirmWeak(false)}>
              {d.t.settings.weakCryptoBack}
            </button>
            <button className="btn btn-sm" onClick={() => void d.save()}>
              {d.t.settings.weakCryptoContinue}
            </button>
          </div>
        </div>
      )}

      {isDraftTab && (
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={d.requestSave} disabled={d.saving}>
            {d.saving ? d.t.settings.saving : d.t.settings.save}
          </button>
          <button className="btn" onClick={onClose}>
            {d.t.settings.cancel}
          </button>
        </div>
      )}
    </OverlayShell>
  );
}
