import { useEffect, useState } from 'react';
import type {
  AnswerLang,
  AsrLanguage,
  CompanionState,
  FontScale,
  ProviderSlot,
  ProviderTestResult,
  ProviderVerification,
  PublicSettings,
  SettingsPatch,
  ThemeMode,
  UiLang,
} from '../../../shared/protocol';
import {
  LOCAL_REALTIME_MODELS,
  PROVIDER_HELP,
  findPresetById,
  findPresetByEndpoint,
  presetsForCapability,
  providerIdForEndpoint,
  type ProviderCapability,
  type ProviderPreset,
} from '../../../shared/providerCatalog';
import {
  candidateKeyTest,
  isTestableTarget,
  storedKeyTest,
  type EndpointTarget,
} from '../../../shared/providerTestRequests';
import { sanitizeApiKeyInput } from '../../../shared/keyInput';
import { isLikelyAccelerator } from '../../../shared/accelerator';
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_PROVIDER,
  type SearchProviderId,
} from '../../../shared/searchProviders';
import type { ThinkingLevel } from '../../../shared/thinking';
import { listMics } from '../../audio/micCapture';
import { useT } from '../../i18n';
import type { Dict } from '../../i18n';
import type { SettingsTab } from './types';
import { ConnectionResult } from '../providers/ConnectionResult';
import { connectionResultCopy } from '../providers/copy';

export type AsrBackend = 'local' | 'cloud' | 'cloud-realtime' | 'local-realtime';
export type DraftSetter = (v: string) => void;
export type ThinkingByPreset = Record<string, ThinkingLevel>;

/**
 * One API-key slot in the panel. Keys are write-only: the renderer never sees
 * a stored key, only whether one exists plus its last-4 hint. Three outcomes
 * feed the save patch — leave alone (undefined), replace (the new plaintext),
 * delete (`''`, which SettingsStore.applyPatch treats as "clear this slot").
 */
function useKeySlot() {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const reset = (): void => {
    setValue('');
    setEditing(false);
    setPendingDelete(false);
    setConfirming(false);
  };

  /** the `apiKey` field for the settings patch, or undefined to keep it */
  const patchValue = (): string | undefined => {
    if (pendingDelete) return '';
    const clean = sanitizeApiKeyInput(value).value;
    return clean || undefined;
  };

  return {
    value,
    setValue,
    editing,
    setEditing,
    pendingDelete,
    setPendingDelete,
    confirming,
    setConfirming,
    reset,
    patchValue,
  };
}

export type KeySlot = ReturnType<typeof useKeySlot>;

/** in-flight / finished connection test for one provider slot */
interface SlotTest {
  testing: boolean;
  result?: ProviderTestResult;
  at?: number;
  /** the IPC itself failed (provider failures arrive as a result, not a throw) */
  error?: string;
  /** the verdict belongs to a key that is typed but not saved yet */
  candidate?: boolean;
}

/** the public (secret-free) view of one credential slot */
function publicSlot(
  s: PublicSettings,
  slot: ProviderSlot,
): { apiKeySet: boolean; apiKeyHint?: string; verification?: ProviderVerification } {
  switch (slot) {
    case 'llm':
      return s.llm;
    case 'vision':
      return s.vision;
    case 'asr-cloud':
      return s.asr.cloud;
    case 'asr-realtime':
    default:
      return s.asr.realtime;
  }
}

export function laneThinkingEntry(
  presetId: string,
  entry: ThinkingLevel | undefined,
  prev: ThinkingByPreset,
): ThinkingByPreset {
  const next = { ...prev };
  if (entry === undefined) delete next[presetId];
  else next[presetId] = entry;
  return next;
}

/**
 * Everything the settings tabs share: the draft (props seed it once; the
 * panel is a draft the user commits with 保存), the write-only key slots,
 * connection tests, and the save patch. Tab components receive the resulting
 * draft and only render the rows they own.
 */
export function useSettingsDraft(
  settings: PublicSettings,
  onSaved: (s: PublicSettings) => void,
) {
  const t = useT();
  const [baseUrl, setBaseUrl] = useState(settings.llm.baseUrl);
  const [model, setModel] = useState(settings.llm.model);
  const [answerLang, setAnswerLang] = useState<AnswerLang>(settings.llm.answerLang);
  const [llmThinking, setLlmThinking] = useState<string>(settings.llm.thinking ?? '');
  const [thinkingByPreset, setThinkingByPreset] = useState<ThinkingByPreset>(
    () => settings.llm.thinkingByPreset ?? {},
  );
  const [language, setLanguage] = useState<AsrLanguage>(settings.asr.language);
  const [hotkey, setHotkey] = useState(settings.ui.hotkeyToggle);
  const [visionBaseUrl, setVisionBaseUrl] = useState(settings.vision.baseUrl ?? '');
  const [visionModel, setVisionModel] = useState(settings.vision.model ?? '');
  const [visionProxy, setVisionProxy] = useState(settings.vision.proxyUrl ?? '');
  const [ocrPrefilter, setOcrPrefilter] = useState(settings.vision.ocrPrefilter);
  const [asrBackend, setAsrBackend] = useState<AsrBackend>(settings.asr.backend);
  const [strategy, setStrategy] = useState<'accuracy' | 'balanced' | 'latency'>(
    settings.asr.strategy ?? 'balanced',
  );
  const [moonshine, setMoonshine] = useState(settings.asr.moonshineEnabled);
  const [cloudBaseUrl, setCloudBaseUrl] = useState(settings.asr.cloud.baseUrl ?? '');
  const [cloudModel, setCloudModel] = useState(settings.asr.cloud.model ?? '');
  const [rtBaseUrl, setRtBaseUrl] = useState(settings.asr.realtime.baseUrl ?? '');
  const [rtModel, setRtModel] = useState(settings.asr.realtime.model ?? '');
  const [rtLocalModel, setRtLocalModel] = useState(
    settings.asr.localRealtime.model ?? 'fun-asr-nano',
  );
  const [hotkeyShot, setHotkeyShot] = useState(settings.ui.hotkeyShot);
  const [hotkeyAnswer, setHotkeyAnswer] = useState(settings.ui.hotkeyAnswer);
  const [examHotkeyOpen, setExamHotkeyOpen] = useState(settings.exam.hotkeyOpen);
  const [examHotkeyAsk, setExamHotkeyAsk] = useState(settings.exam.hotkeyAsk);
  const [examPreferOcr, setExamPreferOcr] = useState(settings.exam.preferOcr);
  const [examWebFallback, setExamWebFallback] = useState(settings.exam.webFallback);
  /** the hotkeys the last save attempt refused ('' = none) */
  const [hotkeyError, setHotkeyError] = useState('');
  const [autoLaunch, setAutoLaunch] = useState(settings.ui.autoLaunch);
  const [fontScale, setFontScale] = useState<FontScale>(settings.ui.fontScale ?? 'medium');
  const [theme, setTheme] = useState<ThemeMode>(settings.ui.theme ?? 'dark');
  const [uiLang, setUiLang] = useState<UiLang>(settings.ui.lang);
  const [themDeviceId, setThemDeviceId] = useState(settings.audio.themDeviceId ?? '');
  const [micDeviceId, setMicDeviceId] = useState(settings.audio.micDeviceId ?? '');
  const [captureBackend, setCaptureBackend] = useState<'webaudio' | 'native'>(
    settings.audio.captureBackend ?? 'webaudio',
  );
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [saving, setSaving] = useState(false);
  /** weak-crypto confirmation is pending; nothing has been sent to main yet */
  const [confirmWeak, setConfirmWeak] = useState(false);
  // ---- LAN companion (手机显示) ----
  const [cOn, setCOn] = useState(settings.companion.enabled);
  const [cHttps, setCHttps] = useState(settings.companion.useHttps);
  const [cTranscript, setCTranscript] = useState(settings.companion.pushTranscript);
  const [cAnswers, setCAnswers] = useState(settings.companion.pushExam || settings.companion.pushInterview);
  const [cShot, setCShot] = useState(settings.companion.pushScreenshot);
  const [cPhoneOnly, setCPhoneOnly] = useState(settings.companion.hotkeyToPhone);
  const [cPort, setCPort] = useState(String(settings.companion.port));
  const [cState, setCState] = useState<CompanionState | null>(null);

  const llmKey = useKeySlot();
  const visionKey = useKeySlot();
  const cloudKey = useKeySlot();
  const rtKey = useKeySlot();
  // per-question-kind routing lanes (write-only keys per non-primary preset)
  const routeCodingKey = useKeySlot();
  const routeQualityKey = useKeySlot();
  const routeFallbackKey = useKeySlot();
  const [routeEnabled, setRouteEnabled] = useState(settings.llm.routing.enabled);
  const [routeCoding, setRouteCoding] = useState(settings.llm.routing.byKind.coding ?? '');
  const [routeQuality, setRouteQuality] = useState(settings.llm.routing.byKind.behavioral ?? '');
  const [routeFallback, setRouteFallback] = useState(settings.llm.routing.fallbackChain[0] ?? '');
  // web-search fallback (knowledge-base miss): off until a key is stored
  const wsKey = useKeySlot();
  const [wsEnabled, setWsEnabled] = useState(!!settings.webSearch?.enabled);
  const [wsProvider, setWsProvider] = useState<SearchProviderId>(
    settings.webSearch?.providerId ?? DEFAULT_SEARCH_PROVIDER,
  );
  const [wsMax, setWsMax] = useState(settings.webSearch?.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS);

  /**
   * Live secret-free snapshot. The props seed the form once, but 已配置 flags
   * and connection-test verdicts must reflect what the main process just
   * recorded — a test writes `verification` through a dedicated store write.
   */
  const [live, setLive] = useState<PublicSettings>(settings);
  const [tests, setTests] = useState<Partial<Record<ProviderSlot, SlotTest>>>({});
  const anyTesting = Object.values(tests).some((s) => s?.testing);
  const resultCopy = connectionResultCopy(t);

  useEffect(() => {
    void listMics()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  /**
   * The bridge's real state lives in main (bound port, who is connected, wire
   * latency), so the panel polls it while it is open — the port the user typed
   * is not necessarily the port that got bound, and a QR must never encode a
   * port that is not listening.
   */
  useEffect(() => {
    let dead = false;
    const tick = async (): Promise<void> => {
      try {
        const s = await window.mc.companionState();
        if (!dead) setCState(s);
      } catch {
        /* main IPC not up yet */
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 1500);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, []);

  /**
   * One real provider round-trip on an explicit click. A key typed above wins
   * over the stored one — that is the 更换 Key flow's whole question — and the
   * candidate is NOT saved by the test: 保存 still commits the form.
   */
  const runSlotTest = async (slot: ProviderSlot, target: EndpointTarget, candidate: string) => {
    setTests((s) => ({ ...s, [slot]: { testing: true, candidate: candidate !== '' } }));
    try {
      const result = await window.mc.providerTest(
        candidate ? candidateKeyTest(target, candidate) : storedKeyTest(target),
      );
      setTests((s) => ({
        ...s,
        [slot]: { testing: false, result, at: Date.now(), candidate: candidate !== '' },
      }));
    } catch (e) {
      setTests((s) => ({
        ...s,
        [slot]: { testing: false, error: t.settings.testCrashed((e as Error).message) },
      }));
    }
    try {
      // main recorded the verdict into the slot — re-read so 上次测试… is current
      setLive(await window.mc.getSettings());
    } catch {
      /* the verdict is already on screen; a stale snapshot is not worth failing */
    }
  };

  /** the provider's own key page, for the failure path */
  const keyPageFor = (target: EndpointTarget): string | undefined =>
    findPresetByEndpoint(target.baseUrl, target.model, target.capability)?.help.keyUrl ??
    PROVIDER_HELP[target.providerId].keyUrl;

  const verificationSummary = (v: ProviderVerification | undefined): string => {
    if (!v?.lastTestAt) return t.settings.testNever;
    const when = new Date(v.lastTestAt).toLocaleString(t.locale);
    return v.lastTestOk ? t.settings.testLastOk(when, v.latencyMs) : t.settings.testLastFail(when);
  };

  /** preset display name in the current UI language */
  const presetName = (p: ProviderPreset): string => (t.uiLang === 'zh' ? p.nameZh : p.nameEn);

  /**
   * The preset matching a draft endpoint. The active tab's rows re-derive
   * this from the draft baseUrl/model (or a lane's preset id) on every render,
   * so switching providers moves the thinking selector without any syncing.
   */
  const presetFor = (
    capability: ProviderCapability,
    endpointBaseUrl: string,
    endpointModel: string,
  ): ProviderPreset | undefined =>
    findPresetByEndpoint(endpointBaseUrl.trim(), endpointModel.trim(), capability);

  /** a save that would persist at least one NEW plaintext key (a deletion is
   * `''`, which never writes a secret and therefore needs no warning) */
  const savesAKey = (): boolean =>
    [llmKey, visionKey, cloudKey, rtKey, routeCodingKey, routeQualityKey, routeFallbackKey, wsKey].some(
      (s) => {
        const v = s.patchValue();
        return v !== undefined && v !== '';
      },
    );

  /** routing lanes whose provider differs from the primary need their own key */
  const primaryProviderId = (): string =>
    providerIdForEndpoint(baseUrl.trim(), model.trim(), 'text-llm');
  const laneNeedsOwnKey = (presetId: string): boolean => {
    const p = findPresetById(presetId);
    if (!p) return false;
    return p.providerId !== 'ollama' && p.providerId !== primaryProviderId();
  };
  const laneRouteKey = (presetId: string): { apiKeySet: boolean; apiKeyHint?: string } =>
    live.llm.routeKeys[presetId] ?? { apiKeySet: false };

  /** pre-flight: ask before the plaintext leaves the renderer, so 「返回」
   * really means the key was never persisted */
  const requestSave = () => {
    // an unparseable accelerator makes globalShortcut.register THROW on the
    // next re-register — surface it here instead of a post-save balloon
    const keys = [
      hotkey,
      hotkeyShot,
      hotkeyAnswer,
      examHotkeyOpen,
      examHotkeyAsk,
    ].map((k) => k.trim());
    const invalid = keys.filter((k) => k && !isLikelyAccelerator(k));
    if (invalid.length) {
      setHotkeyError(invalid.join(', '));
      return;
    }
    setHotkeyError('');
    if (settings.weakCrypto && savesAKey()) {
      setConfirmWeak(true);
      return;
    }
    void save();
  };

  const save = async () => {
    setConfirmWeak(false);
    setSaving(true);
    try {
      const llmApiKey = llmKey.patchValue();
      const visionApiKey = visionKey.patchValue();
      const cloudApiKey = cloudKey.patchValue();
      const rtApiKey = rtKey.patchValue();
      const wsApiKey = wsKey.patchValue();
      // collect routing-lane key writes keyed by preset id
      const laneKeys: Record<string, { apiKey?: string }> = {};
      const laneKeyEntries: [string, string | undefined][] = [
        [routeCoding, routeCodingKey.patchValue()],
        [routeQuality, routeQualityKey.patchValue()],
        [routeFallback, routeFallbackKey.patchValue()],
      ];
      for (const [presetId, key] of laneKeyEntries) {
        if (presetId && key !== undefined) laneKeys[presetId] = { apiKey: key };
      }
      const patch: SettingsPatch = {
        llm: {
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          answerLang,
          providerId: providerIdForEndpoint(baseUrl.trim(), model.trim(), 'text-llm'),
          ...(llmApiKey !== undefined ? { apiKey: llmApiKey } : {}),
          // draft '' = 跟随默认 → main clears the stored level back to unset
          thinking: llmThinking as ThinkingLevel | '',
          // whole-map replace: lanes not in the map fall back to the default
          thinkingByPreset,
          routing: {
            enabled: routeEnabled,
            byKind: {
              ...(routeCoding ? { coding: routeCoding } : {}),
              ...(routeQuality ? { behavioral: routeQuality, technical: routeQuality } : {}),
            },
            fallbackChain: routeFallback ? [routeFallback] : [],
          },
          ...(Object.keys(laneKeys).length ? { routeKeys: laneKeys } : {}),
        },
        vision: {
          baseUrl: visionBaseUrl.trim(),
          model: visionModel.trim(),
          proxyUrl: visionProxy.trim(),
          ocrPrefilter,
          providerId: providerIdForEndpoint(visionBaseUrl.trim(), visionModel.trim(), 'vision'),
          ...(visionApiKey !== undefined ? { apiKey: visionApiKey } : {}),
        },
        asr: {
          language,
          backend: asrBackend,
          strategy: asrBackend === 'local' ? strategy : undefined,
          moonshineEnabled: asrBackend === 'local' ? moonshine : undefined,
          // local backends have no cloud provider; leave the stored value alone
          ...(asrBackend === 'cloud-realtime'
            ? {
                providerId: providerIdForEndpoint(
                  rtBaseUrl.trim(),
                  rtModel.trim(),
                  'asr-realtime',
                ),
              }
            : asrBackend === 'cloud'
              ? {
                  providerId: providerIdForEndpoint(
                    cloudBaseUrl.trim(),
                    cloudModel.trim(),
                    'asr-segment',
                  ),
                }
              : {}),
          cloud: {
            baseUrl: cloudBaseUrl.trim(),
            model: cloudModel.trim(),
            ...(cloudApiKey !== undefined ? { apiKey: cloudApiKey } : {}),
          },
          realtime: {
            baseUrl: rtBaseUrl.trim(),
            model: rtModel.trim(),
            ...(rtApiKey !== undefined ? { apiKey: rtApiKey } : {}),
          },
          localRealtime: { model: rtLocalModel },
        },
        ui: {
          hotkeyToggle: hotkey.trim(),
          hotkeyShot: hotkeyShot.trim(),
          hotkeyAnswer: hotkeyAnswer.trim(),
          fontScale,
          theme,
          lang: uiLang,
          autoLaunch,
        },
        exam: {
          hotkeyOpen: examHotkeyOpen.trim(),
          hotkeyAsk: examHotkeyAsk.trim(),
          preferOcr: examPreferOcr,
          webFallback: examWebFallback,
        },
        audio: {
          themDeviceId: themDeviceId || undefined,
          micDeviceId: micDeviceId || undefined,
          captureBackend,
        },
        webSearch: {
          enabled: wsEnabled,
          providerId: wsProvider,
          maxResults: wsMax,
          ...(wsApiKey !== undefined ? { apiKey: wsApiKey } : {}),
        },
        companion: {
          enabled: cOn,
          useHttps: cHttps,
          hotkeyToPhone: cPhoneOnly,
          // main clamps this into 1..65535, so garbage in the box cannot poison
          // the bind with NaN
          port: Number(cPort) || settings.companion.port,
          pushTranscript: cTranscript,
          // one checkbox for both answer kinds: on a phone there is no reason
          // to show the transcript but hide the answer to it
          pushExam: cAnswers,
          pushInterview: cAnswers,
          pushScreenshot: cShot,
        },
      };
      const next = await window.mc.setSettings(patch);
      llmKey.reset();
      visionKey.reset();
      cloudKey.reset();
      rtKey.reset();
      routeCodingKey.reset();
      routeQualityKey.reset();
      routeFallbackKey.reset();
      wsKey.reset();
      onSaved(next);
    } finally {
      setSaving(false);
    }
  };

  /** provider dropdown driven by the catalog; the value is always the truth
   * derived from the stored baseUrl+model, so an unmatched pair reads 自定义 */
  const providerSelect = (
    capability: ProviderCapability,
    currentBaseUrl: string,
    currentModel: string,
    onPick: (p: ProviderPreset) => void,
  ) => {
    const presets = presetsForCapability(capability).filter((p) => p.baseUrl && p.model);
    const current = findPresetByEndpoint(currentBaseUrl, currentModel, capability);
    return (
      <select
        value={current?.id ?? ''}
        onChange={(e) => {
          const p = findPresetById(e.target.value);
          if (p) onPick(p);
        }}
      >
        {!current && <option value="">{t.settings.providerCustom}</option>}
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {presetName(p)}
          </option>
        ))}
      </select>
    );
  };

  const keyRow = (label: string, slot: KeySlot, slotId: ProviderSlot, target: EndpointTarget) => {
    const pub = publicSlot(live, slotId);
    const apiKeySet = pub.apiKeySet;
    const hint = pub.apiKeyHint;
    const state = tests[slotId];
    const candidate = sanitizeApiKeyInput(slot.value).value;
    const canTest =
      isTestableTarget(target) && !slot.pendingDelete && (candidate !== '' || apiKeySet);
    const keyUrl = keyPageFor(target);
    return (
      <div className="settings-row">
        <label>{label}</label>
        {apiKeySet && !slot.editing && !slot.pendingDelete ? (
          <div className="key-status">
            <span className="tag tag-ok">{t.settings.keyConfigured}</span>
            {hint && <span className="key-mask">{`••••${hint}`}</span>}
            <button className="btn btn-sm" onClick={() => slot.setEditing(true)}>
              {t.settings.keyReplace}
            </button>
            {slot.confirming ? (
              <>
                <span className="settings-inline-hint">{t.settings.keyDeleteConfirm}</span>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    slot.setPendingDelete(true);
                    slot.setConfirming(false);
                  }}
                >
                  {t.settings.keyDeleteYes}
                </button>
                <button className="btn btn-sm" onClick={() => slot.setConfirming(false)}>
                  {t.settings.keyDeleteNo}
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => slot.setConfirming(true)}>
                {t.settings.keyDelete}
              </button>
            )}
          </div>
        ) : slot.pendingDelete ? (
          <div className="key-status">
            <span className="tag tag-err">{t.settings.keyPendingDelete}</span>
            <button className="btn btn-sm" onClick={slot.reset}>
              {t.settings.keyUndoDelete}
            </button>
          </div>
        ) : (
          <>
            <input
              type="password"
              value={slot.value}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => slot.setValue(e.target.value)}
              placeholder={apiKeySet ? t.settings.keyNewPlaceholder : 'sk-…'}
            />
            <span className="settings-inline-hint">
              {apiKeySet ? t.settings.keyKeepPlaceholder : t.settings.keyMissing} ·{' '}
              {t.settings.keySanitizedHint}
            </span>
          </>
        )}

        <div className="key-status">
          <button
            className="btn btn-sm"
            disabled={!canTest || anyTesting}
            title={canTest ? undefined : t.settings.testNoKey}
            onClick={() => void runSlotTest(slotId, target, candidate)}
          >
            {state?.testing ? t.settings.testing : t.settings.testConnection}
          </button>
          <span className="settings-inline-hint">{verificationSummary(pub.verification)}</span>
        </div>

        <ConnectionResult
          copy={resultCopy}
          result={state?.result ?? null}
          testing={state?.testing}
          message={
            state?.result
              ? t.uiLang === 'zh'
                ? state.result.messageZh
                : state.result.messageEn
              : undefined
          }
          hint={state?.result ? t.settings.testHints[state.result.code] : undefined}
          at={state?.at}
        >
          {keyUrl && (
            <button className="btn btn-sm" onClick={() => void window.mc.openExternal(keyUrl)}>
              {t.settings.testOpenKeyPage}
            </button>
          )}
        </ConnectionResult>
        {state?.result?.ok && state.candidate && (
          <span className="settings-inline-hint">{t.settings.testCandidateOk}</span>
        )}
        {state?.error && <div className="settings-warn">{state.error}</div>}
      </div>
    );
  };

  /** where each key row points its connection test */
  const llmTarget = (): EndpointTarget => ({
    capability: 'text-llm',
    providerId: providerIdForEndpoint(baseUrl.trim(), model.trim(), 'text-llm'),
    baseUrl,
    model,
    slot: 'llm',
  });
  const visionTarget = (): EndpointTarget => ({
    capability: 'vision',
    providerId: providerIdForEndpoint(visionBaseUrl.trim(), visionModel.trim(), 'vision'),
    baseUrl: visionBaseUrl,
    model: visionModel,
    slot: 'vision',
    ...(visionProxy.trim() ? { proxyUrl: visionProxy.trim() } : {}),
  });
  const cloudTarget = (): EndpointTarget => ({
    capability: 'asr-segment',
    providerId: providerIdForEndpoint(cloudBaseUrl.trim(), cloudModel.trim(), 'asr-segment'),
    baseUrl: cloudBaseUrl,
    model: cloudModel,
    slot: 'asr-cloud',
  });
  const rtTarget = (): EndpointTarget => ({
    capability: 'asr-realtime',
    providerId: providerIdForEndpoint(rtBaseUrl.trim(), rtModel.trim(), 'asr-realtime'),
    baseUrl: rtBaseUrl,
    model: rtModel,
    slot: 'asr-realtime',
  });

  const asrSummary = (): string => {
    if (asrBackend === 'local') return t.settings.asrLocalWhisper;
    if (asrBackend === 'local-realtime') {
      const m = LOCAL_REALTIME_MODELS.find((x) => x.value === rtLocalModel);
      return m ? (t.uiLang === 'zh' ? m.nameZh : m.nameEn) : rtLocalModel;
    }
    const p =
      asrBackend === 'cloud-realtime'
        ? findPresetByEndpoint(rtBaseUrl, rtModel, 'asr-realtime')
        : findPresetByEndpoint(cloudBaseUrl, cloudModel, 'asr-segment');
    return p ? presetName(p) : t.settings.providerCustom;
  };

  const llmSummary = (): string => {
    const p = findPresetByEndpoint(baseUrl, model, 'text-llm');
    return p ? presetName(p) : `${model || '—'}`;
  };

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: 'model', label: t.settings.tabModel },
    { id: 'routing', label: t.settings.tabRouting },
    { id: 'asr', label: t.settings.tabAsr },
    { id: 'vision', label: t.settings.tabVision },
    { id: 'knowledge', label: t.settings.tabKnowledge },
    { id: 'health', label: t.settings.tabHealth },
    { id: 'general', label: t.settings.tabGeneral },
  ];

  return {
    t,
    settings,
    live,
    baseUrl,
    setBaseUrl,
    model,
    setModel,
    answerLang,
    setAnswerLang,
    llmThinking,
    setLlmThinking,
    thinkingByPreset,
    setThinkingByPreset,
    language,
    setLanguage,
    hotkey,
    setHotkey,
    visionBaseUrl,
    setVisionBaseUrl,
    visionModel,
    setVisionModel,
    visionProxy,
    setVisionProxy,
    ocrPrefilter,
    setOcrPrefilter,
    asrBackend,
    setAsrBackend,
    strategy,
    setStrategy,
    moonshine,
    setMoonshine,
    cloudBaseUrl,
    setCloudBaseUrl,
    cloudModel,
    setCloudModel,
    rtBaseUrl,
    setRtBaseUrl,
    rtModel,
    setRtModel,
    rtLocalModel,
    setRtLocalModel,
    hotkeyShot,
    setHotkeyShot,
    hotkeyAnswer,
    setHotkeyAnswer,
    examHotkeyOpen,
    setExamHotkeyOpen,
    examHotkeyAsk,
    setExamHotkeyAsk,
    examPreferOcr,
    setExamPreferOcr,
    examWebFallback,
    setExamWebFallback,
    hotkeyError,
    autoLaunch,
    setAutoLaunch,
    fontScale,
    setFontScale,
    theme,
    setTheme,
    uiLang,
    setUiLang,
    themDeviceId,
    setThemDeviceId,
    micDeviceId,
    setMicDeviceId,
    captureBackend,
    setCaptureBackend,
    devices,
    saving,
    confirmWeak,
    setConfirmWeak,
    cOn,
    setCOn,
    cHttps,
    setCHttps,
    cTranscript,
    setCTranscript,
    cAnswers,
    setCAnswers,
    cShot,
    setCShot,
    cPhoneOnly,
    setCPhoneOnly,
    cPort,
    setCPort,
    cState,
    llmKey,
    visionKey,
    cloudKey,
    rtKey,
    routeCodingKey,
    routeQualityKey,
    routeFallbackKey,
    wsKey,
    routeEnabled,
    setRouteEnabled,
    routeCoding,
    setRouteCoding,
    routeQuality,
    setRouteQuality,
    routeFallback,
    setRouteFallback,
    wsEnabled,
    setWsEnabled,
    wsProvider,
    setWsProvider,
    wsMax,
    setWsMax,
    presetFor,
    presetName,
    providerSelect,
    keyRow,
    llmTarget,
    visionTarget,
    cloudTarget,
    rtTarget,
    laneNeedsOwnKey,
    laneRouteKey,
    asrSummary,
    llmSummary,
    requestSave,
    save,
    TABS,
  };
}

export type SettingsDraft = ReturnType<typeof useSettingsDraft>;
// re-exported so tabs keep the same Dict-typed `t` the hook hands them
export type { Dict };
