import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { AnswerStylePopover, type AnswerStylePick } from './prompt/AnswerStylePopover';
import type { AnswerExpertise, AnswerRichness } from '../../shared/answerStyle';
import type { AnswerPersona } from '../../shared/personas';

/**
 * The window bar, grouped by what the user actually does mid-session:
 * core capture controls on the left, five high-frequency icon toggles, then
 * 知识库/设置/… and the window buttons. Low-frequency entries (HUD、做题、
 * 诊断、帮助、向导) fold into the overflow menu so the bar stays one line
 * even in a narrow window. Every toggle keeps its full tooltip — the icon
 * only replaces the label, never the explanation.
 */
export function TitleBar({
  capturing,
  asrReady,
  captureKind,
  mics,
  themDeviceId,
  micDeviceId,
  micActive,
  continuous,
  visionOn,
  answerLangEn,
  stealth,
  showHud,
  dual,
  phonesOnline,
  answerStyle,
  onStartStop,
  onSelectThem,
  onSelectMic,
  onToggleContinuous,
  onToggleModel,
  onToggleAnswerLang,
  onToggleMic,
  onSwitchMode,
  onToggleStealth,
  onToggleHud,
  onOpenExam,
  onOpenKnowledge,
  onOpenSettings,
  onOpenDiagnostics,
  onOpenHelp,
  onRerunWizard,
  onHide,
  onQuit,
  onPickAnswerStyle,
  onManagePersonas,
}: {
  capturing: boolean;
  asrReady: boolean;
  captureKind: 'loopback' | 'input';
  mics: { deviceId: string; label: string }[];
  themDeviceId: string;
  micDeviceId: string;
  micActive: boolean;
  continuous: boolean;
  visionOn: boolean;
  answerLangEn: boolean;
  stealth: boolean;
  showHud: boolean;
  dual: boolean;
  phonesOnline: number;
  onStartStop: () => void;
  onSelectThem: (id: string) => void;
  onSelectMic: (id: string) => void;
  onToggleContinuous: () => void;
  onToggleModel: () => void;
  onToggleAnswerLang: () => void;
  onToggleMic: () => void;
  onSwitchMode: (dual: boolean) => void;
  onToggleStealth: () => void;
  onToggleHud: () => void;
  onOpenExam: () => void;
  onOpenKnowledge: () => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  onOpenHelp: () => void;
  onRerunWizard: () => void;
  onHide: () => void;
  onQuit: () => void;
  /** 🎚 popover: the current 回答风格 layers + the persona library to pick from */
  answerStyle: {
    richness: AnswerRichness;
    expertise: AnswerExpertise;
    personas: AnswerPersona[];
    activePersonaId: string;
  };
  onPickAnswerStyle: (pick: AnswerStylePick) => void;
  onManagePersonas: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const off = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    // pointerdown fires before a click on a menu button would be lost — the
    // items below close the menu themselves
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [menuOpen]);

  const icon = (label: string, tip: string, onClick: () => void, on = false, live = false) => (
    <button
      className={`btn btn-icon${on ? ' btn-on' : ''}${live ? ' btn-live' : ''}`}
      onClick={onClick}
      title={tip}
      aria-label={tip}
    >
      {label}
    </button>
  );

  const item = (label: string, onClick: () => void, active = false) => (
    <button
      className={`tb-menu-item${active ? ' tb-menu-item-on' : ''}`}
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
    >
      {label}
    </button>
  );

  return (
    <header className="titlebar">
      <span className="brand">MeetingAssistant</span>
      <div className="titlebar-actions">
        <button
          className={capturing ? 'btn btn-live' : 'btn btn-primary'}
          onClick={onStartStop}
          disabled={!asrReady}
          title={
            captureKind === 'loopback'
              ? capturing
                ? t.titlebar.stopTitle
                : t.titlebar.startTitle
              : capturing
                ? t.titlebar.stopInputTitle
                : t.titlebar.startInputTitle
          }
        >
          {capturing ? t.titlebar.stop : t.titlebar.start}
        </button>
        {captureKind === 'input' && mics.length > 0 && (
          <select
            className="mic-select"
            value={themDeviceId}
            onChange={(e) => onSelectThem(e.target.value)}
            title={t.titlebar.themDeviceTitle}
          >
            <option value="">{t.titlebar.themDeviceDefault}</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {(m.label || t.titlebar.themDeviceDefault).slice(0, 14)}
              </option>
            ))}
          </select>
        )}
        {/* 单屏 / 双屏 — the one control that changes what the whole app is
            for, so it lives in the bar rather than in 设置. The trailing
            count is how many phones are actually receiving right now. */}
        <div className="mode-seg" title={t.titlebar.modeTitle}>
          <button className={dual ? '' : 'on'} onClick={() => onSwitchMode(false)}>
            {t.titlebar.modeSingle}
          </button>
          <button className={dual ? 'on' : ''} onClick={() => onSwitchMode(true)}>
            {t.titlebar.modeDual}
            {dual && phonesOnline > 0 ? ` ·${phonesOnline}` : ''}
          </button>
        </div>

        {icon('⚡', t.titlebar.continuousTitle, onToggleContinuous, continuous)}
        {icon('👁', t.titlebar.modelTitle, onToggleModel, visionOn)}
        <button
          className="btn btn-icon"
          onClick={onToggleAnswerLang}
          title={t.titlebar.answerLangTitle}
          aria-label={t.titlebar.answerLangTitle}
        >
          {answerLangEn ? 'EN' : '中'}
        </button>
        {icon('🎤', t.titlebar.micTitle, onToggleMic, false, micActive)}
        {micActive && mics.length > 0 && (
          <select
            className="mic-select"
            value={micDeviceId}
            onChange={(e) => onSelectMic(e.target.value)}
            title={t.titlebar.micDeviceTitle}
          >
            <option value="">{t.titlebar.micDefault}</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {(m.label || t.titlebar.micDefault).slice(0, 10)}
              </option>
            ))}
          </select>
        )}
        {icon(
          '🕶',
          window.mc.platform === 'darwin' ? t.titlebar.stealthMacTitle : t.titlebar.stealthTitle,
          onToggleStealth,
          stealth,
        )}

        {/* 🎚 回答风格 — mid-meeting knobs for length / register / persona */}
        <AnswerStylePopover
          richness={answerStyle.richness}
          expertise={answerStyle.expertise}
          personas={answerStyle.personas}
          activePersonaId={answerStyle.activePersonaId}
          onPick={onPickAnswerStyle}
          onManagePersonas={onManagePersonas}
        />
        {icon('📚', t.knowledge.title, onOpenKnowledge)}
        {icon('⚙', t.titlebar.settingsTitle, onOpenSettings)}
        <div className="tb-menu-wrap" ref={menuRef}>
          {icon('⋯', '···', () => setMenuOpen((v) => !v), menuOpen)}
          {menuOpen && (
            <div className="tb-menu" role="menu">
              {item(`${t.titlebar.hudTitle} · ${showHud ? 'ON' : 'OFF'}`, onToggleHud, showHud)}
              {item(t.titlebar.exam, onOpenExam)}
              {item(t.diagnostics.title, onOpenDiagnostics)}
              {item(t.help.title, onOpenHelp)}
              {item(t.settings.rerunWizard, onRerunWizard)}
            </div>
          )}
        </div>
        <button className="btn btn-icon" onClick={onHide} title={t.titlebar.hideTitle} aria-label={t.titlebar.hideTitle}>
          —
        </button>
        <button className="btn btn-icon btn-close" onClick={onQuit} title={t.titlebar.quitTitle} aria-label={t.titlebar.quitTitle}>
          ✕
        </button>
      </div>
    </header>
  );
}
