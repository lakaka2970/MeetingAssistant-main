/**
 * Settings store: plain JSON file + OS-encrypted secrets (safeStorage).
 * HARD RULE (PLAN §3.2, Natively lesson): no Chromium DOM storage / LevelDB
 * for anything that matters. Load failures fall back to defaults — the app
 * must always boot.
 *
 * Dependencies are injected (file path + cipher) so this is unit-testable
 * without Electron.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type {
  OnboardingCompletePayload,
  OnboardingProgressPatch,
  OnboardingState,
  ProviderSlot,
  ProviderVerification,
  PublicSettings,
  SettingsFile,
  SettingsPatch,
  UiLang,
} from '../shared/protocol';
import { clampPaneSplit, PANE_SPLIT_DEFAULT } from '../shared/protocol';
import { defaultHotkeysForPlatform } from '../shared/platform';
import {
  findPresetById,
  presetsForCapability,
  providerIdForEndpoint,
} from '../shared/providerCatalog';
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_PROVIDER,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../shared/searchProviders';

export interface SecretCipher {
  available(): boolean;
  /**
   * true only for OS-backed encryption. The plain fallback sets it to false so
   * the store can tell the UI that keys are merely obfuscated on this machine
   * (PublicSettings.weakCrypto).
   */
  readonly secure: boolean;
  /** plaintext -> base64 ciphertext */
  encrypt(plain: string): string;
  /** base64 ciphertext -> plaintext */
  decrypt(b64: string): string;
}

/** Fallback when OS encryption is unavailable: marked base64 (obfuscation only). */
export const plainCipher: SecretCipher = {
  available: () => true,
  secure: false,
  encrypt: (plain) => `plain:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (b64) =>
    b64.startsWith('plain:') ? Buffer.from(b64.slice(6), 'base64').toString('utf8') : '',
};

export function defaultSettings(platform: string = process.platform): SettingsFile {
  const hotkeys = defaultHotkeysForPlatform(platform);
  return {
    version: 2,
    // A brand new profile has never seen the wizard; the setup window owns
    // startup until it completes (electron/main.ts gating).
    // MC_DEV_DEFAULT_LOCAL_ASR=1 keeps the pre-wizard developer workflow:
    // the defaults below already select the local Fun-ASR sidecar, so all the
    // flag has to do is let boot go straight to the main window.
    onboarding: {
      schemaVersion: 1,
      completed: process.env.MC_DEV_DEFAULT_LOCAL_ASR === '1',
    },
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',
      // deepseek-flash reads images too, so 截图做题 needs no second provider.
      // It replaces 'deepseek-chat' / 'deepseek-v4.1-flash': DeepSeek now accepts
      // only 'deepseek-flash' and 'deepseek-v4-pro' and 400s on anything else.
      model: 'deepseek-flash',
      answerLang: 'chinese',
      answerWithVision: false,
      // upgrade P1: routing off by default — single provider stays the zero-
      // config path; byKind/fallbackChain are opt-in via settings UI
      routing: { enabled: false, byKind: {}, fallbackChain: [] },
    },
    vision: {
      // upgrade P2: off by default — needs tesseract.js + language data
      ocrPrefilter: false,
    },
    asr: {
      language: 'auto',
      // default = local Fun-ASR-Nano via the auto-spawned sidecar: free,
      // private, zh+en good with punctuation (user decision 2026-07-10)
      backend: 'local-realtime',
      cloud: {},
      realtime: {},
      localRealtime: { model: 'fun-asr-nano' },
      // upgrade P1: whisper-only accuracy by default; the moonshine fast lane
      // is an explicit opt-in (it downloads a ~30 MB English model)
      strategy: 'balanced',
      moonshineEnabled: false,
    },
    ui: {
      stealth: true,
      hotkeyToggle: hotkeys.toggle,
      hotkeyShot: hotkeys.shot,
      hotkeyAnswer: hotkeys.answer,
      // even halves: the transcript and the answer each need to be readable,
      // and neither is secondary by default
      paneSplit: PANE_SPLIT_DEFAULT,
      answerOnly: false,
      opacity: 0.94,
      // medium = 16px answer body (was 13px) — readable at a glance mid-interview
      fontScale: 'medium',
      theme: 'dark',
      // opt-in only: a meeting copilot has no business starting itself
      autoLaunch: false,
      trayNoticeShown: false,
    },
    audio: {
      micEnabled: false,
      // upgrade P1.5: the renderer Web Audio pipeline stays the default; the
      // napi-rs native loopback is an opt-in (artifact may not be built)
      captureBackend: 'webaudio' as const,
    },
    // upgrade P0: RAG on by default but fully lazy — the embed worker only
    // spawns on first ingest/search, so a disabled/offline machine pays nothing
    rag: {
      enabled: true,
      model: 'bge-m3',
      // 5, not 3: measured on the interview KB's own question set, topK=3 cannot
      // even cover the expected files for a cross-document question (a "零拷贝"
      // ask spans BASE-12 / P19-01 / BASE-16). Retrieval is cheap; a missing
      // source is not recoverable downstream.
      topK: 5,
      minScore: 0.2,
      // huggingface.co is unreachable from mainland networks; the mirror is
      // the honest default and can be overridden (or pointed back at HF)
      remoteHost: 'https://hf-mirror.com',
      // empty = no pre-chunked knowledge base bound
      kbIndex: '',
    },
    // web search stays OFF: it is the knowledge-base-miss fallback, needs a key
    // the user must supply, and is the one answer path that leaves the machine
    webSearch: {
      enabled: false,
      providerId: DEFAULT_SEARCH_PROVIDER,
      maxResults: DEFAULT_SEARCH_MAX_RESULTS,
      timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    },
    // 做题模式: banks start unbound; local OCR preferred; no web unless asked
    exam: {
      banks: {},
      subMode: 'aptitude',
      preferOcr: true,
      webFallback: false,
      hotkeyOpen: platform === 'darwin' ? 'Command+Alt+B' : 'Control+Alt+B',
      hotkeyAsk: platform === 'darwin' ? 'Command+Alt+S' : 'Control+Alt+S',
    },
    // the audit trail stays off until asked for: it writes sensitive use to disk
    privacy: {
      auditEnabled: false,
      captureReturns: false,
      maxEntries: 500,
    },
    // nothing listens on a LAN port until the user turns this on
    companion: {
      enabled: false,
      port: 18765,
      pushExam: true,
      pushInterview: true,
      pushTranscript: true,
      pushScreenshot: true,
      useHttps: true,
      hotkeyToPhone: false,
      jpegQuality: 80,
      maxDim: 1920,
    },
  };
}

/** last <=4 characters of a key — the only fragment ever shown to the user. */
export function apiKeyHint(plain: string): string | undefined {
  const key = plain.trim();
  return key ? key.slice(-4) : undefined;
}

/**
 * Integer bound for a setting the renderer (and therefore a hand-edited
 * settings.json) can put anything into. NaN/Infinity/absent all land on `def`
 * rather than poisoning a port or a JPEG quality with NaN.
 */
function clampInt(value: number | undefined, min: number, max: number, def: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return def;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * DeepSeek model names that stopped being accepted on 2026-09-16. The API now
 * lists exactly two (`deepseek-flash`, `deepseek-v4-pro`) and rejects the rest
 * with HTTP 400 "The supported API model names are …" — which reaches the user
 * as a failed answer, not as something they can act on. A profile written by an
 * older build still holds the old name, so it is rewritten on load.
 *
 * Scoped to DeepSeek's own endpoint on purpose: a relay that still fronts the
 * old names under a different baseUrl is left exactly as the user typed it.
 */
const RETIRED_DEEPSEEK_MODELS: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
};

/** preset ids retired with those models — an old routing lane keeps working. */
const RETIRED_PRESET_IDS: Record<string, string> = {
  'deepseek.text.v41flash': 'deepseek.text.fast',
  'deepseek.text.thinking': 'deepseek.text.deep',
};

function isDeepSeekEndpoint(baseUrl: string | undefined): boolean {
  const deepseek = findPresetById('deepseek.text.fast')?.baseUrl;
  if (!deepseek) return false;
  const norm = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();
  return !!baseUrl && norm(baseUrl) === norm(deepseek);
}

/**
 * Rewrite a retired model name in one endpoint slot. `inheritedBaseUrl` is the
 * endpoint this slot falls back to when it names no baseUrl of its own — the
 * vision slot rides on the text provider that way, and it is still DeepSeek.
 * The slot's own baseUrl (or its absence) is never touched, so `inherited`
 * stays answerable from the file.
 */
function withRetiredModels<T extends { baseUrl?: string; model?: string }>(
  slot: T,
  inheritedBaseUrl: string | undefined = undefined,
): T {
  const model = slot.model?.trim();
  if (!model) return slot;
  const endpoint = slot.baseUrl?.trim() ? slot.baseUrl : inheritedBaseUrl;
  if (!isDeepSeekEndpoint(endpoint)) return slot;
  const replacement = RETIRED_DEEPSEEK_MODELS[model];
  return replacement ? { ...slot, model: replacement } : slot;
}

/**
 * Per-section spread merge against the defaults. Unknown keys in the stored
 * file survive (forward compatibility); missing ones get the default.
 */
function mergeWithDefaults(raw: Partial<SettingsFile>, defaults: SettingsFile): SettingsFile {
  const dr = defaults.llm.routing ?? { enabled: false, byKind: {}, fallbackChain: [] as string[] };
  const byKind: Record<string, string> = { ...dr.byKind, ...raw.llm?.routing?.byKind };
  for (const [kind, id] of Object.entries(byKind)) {
    if (RETIRED_PRESET_IDS[id]) byKind[kind] = RETIRED_PRESET_IDS[id];
  }
  const llm = withRetiredModels({ ...defaults.llm, ...raw.llm });
  return {
    version: 2,
    onboarding: { ...defaults.onboarding, ...raw.onboarding, schemaVersion: 1 },
    llm: {
      ...llm,
      routing: {
        ...dr,
        ...raw.llm?.routing,
        byKind,
        fallbackChain: (raw.llm?.routing?.fallbackChain ?? dr.fallbackChain ?? []).map(
          (id) => RETIRED_PRESET_IDS[id] ?? id,
        ),
      },
    },
    // the vision slot with no baseUrl of its own runs on the text endpoint
    vision: withRetiredModels({ ...defaults.vision, ...raw.vision }, llm.baseUrl),
    asr: {
      ...defaults.asr,
      ...raw.asr,
      cloud: { ...defaults.asr.cloud, ...raw.asr?.cloud },
      realtime: { ...defaults.asr.realtime, ...raw.asr?.realtime },
      localRealtime: { ...defaults.asr.localRealtime, ...raw.asr?.localRealtime },
      strategy: raw.asr?.strategy ?? defaults.asr.strategy,
      moonshineEnabled: raw.asr?.moonshineEnabled ?? defaults.asr.moonshineEnabled,
    },
    ui: { ...defaults.ui, ...raw.ui },
    audio: { ...defaults.audio, ...raw.audio },
    rag: { ...defaults.rag, ...raw.rag },
    webSearch: { ...defaults.webSearch, ...raw.webSearch },
    exam: {
      ...defaults.exam,
      ...raw.exam,
      // per-sub-mode bindings merge per key, and undefined must not delete a
      // binding the user still has (the patch uses null for that instead)
      banks: { ...defaults.exam.banks, ...raw.exam?.banks },
    },
    privacy: { ...defaults.privacy, ...raw.privacy },
    companion: { ...defaults.companion, ...raw.companion },
  };
}

/**
 * v1 -> v2 settings migration. Pure: no fs, no electron, no cipher — so it is
 * unit-testable and can never damage the file it is reading from.
 *
 * Guarantees:
 *  - `apiKeyEnc` ciphertexts are carried over byte-for-byte (we cannot decrypt
 *    here, and re-encrypting would need safeStorage);
 *  - baseUrl / model / proxy / backend / ui / audio are untouched;
 *  - `providerId` is inferred from the catalog by exact baseUrl+model match,
 *    falling back to 'custom';
 *  - a settings file EXISTS, so this user already configured the app by hand:
 *    onboarding is marked completed (grandfathered) and the wizard never
 *    hijacks their next launch.
 *
 * `apiKeyHint` is deliberately NOT back-filled: the plaintext is unavailable
 * during migration. Hints appear the next time a key is saved.
 *
 * Throws on input that is not a JSON object; the caller keeps the original
 * file untouched and boots with defaults.
 */
export function migrateSettingsV1ToV2(
  v1: unknown,
  platform: string = process.platform,
): SettingsFile {
  if (!v1 || typeof v1 !== 'object' || Array.isArray(v1)) {
    throw new Error('settings: v1 payload is not a JSON object');
  }
  const raw = v1 as Partial<SettingsFile>;
  const next = mergeWithDefaults(raw, defaultSettings(platform));

  // existing users are grandfathered past the wizard; keep any progress fields
  // a re-run may already have written. `migratedFromV1` is what lets the main
  // window tell a hand-configured profile from one the wizard produced, so the
  // upgrade notice only reaches the former.
  next.onboarding = {
    ...next.onboarding,
    schemaVersion: 1,
    completed: true,
    migratedFromV1: true,
  };

  next.llm.providerId = providerIdForEndpoint(next.llm.baseUrl, next.llm.model, 'text-llm');
  if (next.vision.baseUrl && next.vision.model) {
    next.vision.providerId = providerIdForEndpoint(
      next.vision.baseUrl,
      next.vision.model,
      'vision',
    );
  }

  const rt = next.asr.realtime;
  const cl = next.asr.cloud;
  const rtProvider =
    rt?.baseUrl && rt?.model
      ? providerIdForEndpoint(rt.baseUrl, rt.model, 'asr-realtime')
      : undefined;
  const clProvider =
    cl?.baseUrl && cl?.model ? providerIdForEndpoint(cl.baseUrl, cl.model, 'asr-segment') : undefined;
  // the active backend decides which slot names the provider; local backends
  // have no cloud provider at all, so the field stays absent
  const asrProvider = next.asr.backend === 'cloud' ? clProvider ?? rtProvider : rtProvider ?? clProvider;
  if (asrProvider) next.asr.providerId = asrProvider;

  return next;
}

export class SettingsStore {
  data: SettingsFile;
  /** true when this boot upgraded a v1 file (main logs it once) */
  readonly migratedFromV1: boolean = false;
  /** raw v1 text kept until the first v2 save writes settings.json.bak */
  private pendingBackup: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
    /** UI language when the user never chose one (derived from OS locale) */
    private readonly fallbackUiLang: UiLang = 'zh',
  ) {
    const loaded = this.loadFromDisk();
    this.data = loaded.data;
    this.migratedFromV1 = loaded.migrated;
    if (loaded.migrated) {
      // persist eagerly so the .bak escape hatch exists immediately; a failure
      // here (read-only dir) must never take the app down
      try {
        this.save();
      } catch (e) {
        console.warn('[settings] could not persist the v2 migration:', (e as Error).message);
      }
    }
  }

  private loadFromDisk(): { data: SettingsFile; migrated: boolean } {
    const defaults = defaultSettings();
    if (!existsSync(this.filePath)) return { data: defaults, migrated: false };

    let text: string;
    let raw: unknown;
    try {
      text = readFileSync(this.filePath, 'utf8');
      raw = JSON.parse(text);
    } catch (e) {
      // corrupt or unreadable: boot with defaults and leave the file ALONE
      console.warn('[settings] failed to load, using defaults:', (e as Error).message);
      return { data: defaults, migrated: false };
    }

    const version = (raw as { version?: unknown } | null)?.version;
    if (version === 2) {
      return { data: mergeWithDefaults(raw as Partial<SettingsFile>, defaults), migrated: false };
    }

    // anything older (v1, or a file written before `version` existed)
    try {
      const data = migrateSettingsV1ToV2(raw);
      this.pendingBackup = text;
      console.log(`[settings] migrated settings.json v${String(version ?? 1)} -> v2`);
      return { data, migrated: true };
    } catch (e) {
      console.warn('[settings] migration failed, using defaults:', (e as Error).message);
      return { data: defaults, migrated: false };
    }
  }

  save(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    if (this.pendingBackup !== null) {
      const bak = `${this.filePath}.bak`;
      const original = this.pendingBackup;
      this.pendingBackup = null; // one attempt; never loop on a failing disk
      try {
        // an existing .bak is an older original — do not overwrite it
        if (!existsSync(bak)) writeFileSync(bak, original, 'utf8');
      } catch (e) {
        console.warn('[settings] could not write settings.json.bak:', (e as Error).message);
      }
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  // ---- onboarding ----

  getOnboarding(): OnboardingState {
    return { ...this.data.onboarding };
  }

  /** 保存并稍后继续 / dismissing the upgrade notice — never flips `completed` */
  saveOnboardingProgress(patch: OnboardingProgressPatch): OnboardingState {
    this.data.onboarding = {
      ...this.data.onboarding,
      ...stripUndefined(patch),
      schemaVersion: 1,
    };
    this.save();
    return this.getOnboarding();
  }

  /** the wizard finished; the main window may take over */
  completeOnboarding(payload: OnboardingCompletePayload = {}): OnboardingState {
    this.data.onboarding = {
      ...this.data.onboarding,
      ...stripUndefined(payload),
      schemaVersion: 1,
      completed: true,
      completedAt: new Date().toISOString(),
    };
    this.save();
    return this.getOnboarding();
  }

  applyPatch(patch: SettingsPatch): void {
    if (patch.llm) {
      const { apiKey, routing, routeKeys, thinking, ...rest } = patch.llm;
      // '' (UI: 跟随默认) clears back to unset — stripUndefined alone cannot
      // express "remove this key"
      if (thinking === '') delete this.data.llm.thinking;
      else if (thinking !== undefined) this.data.llm.thinking = thinking;
      Object.assign(this.data.llm, stripUndefined(rest));
      if (routing) {
        const cur = this.data.llm.routing ?? { enabled: false, byKind: {}, fallbackChain: [] as string[] };
        this.data.llm.routing = {
          ...cur,
          ...stripUndefined(routing),
          byKind: { ...cur.byKind, ...routing.byKind },
          fallbackChain: routing.fallbackChain ?? cur.fallbackChain,
        };
      }
      if (routeKeys) {
        this.data.llm.routeKeys = { ...(this.data.llm.routeKeys ?? {}) };
        for (const [presetId, entry] of Object.entries(routeKeys)) {
          const prev = this.data.llm.routeKeys[presetId] ?? {};
          if (entry.apiKey === '') {
            // '' clears the preset's key slot
            const { apiKeyEnc: _drop, apiKeyHint: _dropHint, ...restMeta } = prev;
            if (Object.keys(restMeta).length === 0) {
              delete this.data.llm.routeKeys[presetId];
            } else {
              this.data.llm.routeKeys[presetId] = restMeta;
            }
          } else if (entry.apiKey !== undefined) {
            this.data.llm.routeKeys[presetId] = {
              ...prev,
              apiKeyEnc: this.cipher.encrypt(entry.apiKey),
              apiKeyHint: apiKeyHint(entry.apiKey),
            };
          }
        }
      }
      if (apiKey !== undefined) {
        this.writeKey(this.data.llm, apiKey, rest.verification !== undefined);
      }
    }
    if (patch.vision) {
      const { apiKey, ...rest } = patch.vision;
      Object.assign(this.data.vision, stripUndefined(rest));
      if (apiKey !== undefined) {
        this.writeKey(this.data.vision, apiKey, rest.verification !== undefined);
      }
    }
    if (patch.asr) {
      const { cloud, realtime, localRealtime, ...rest } = patch.asr;
      Object.assign(this.data.asr, stripUndefined(rest));
      if (localRealtime) {
        this.data.asr.localRealtime = {
          ...this.data.asr.localRealtime,
          ...stripUndefined(localRealtime),
        };
      }
      if (cloud) {
        const { apiKey, ...crest } = cloud;
        this.data.asr.cloud = { ...this.data.asr.cloud, ...stripUndefined(crest) };
        if (apiKey !== undefined) {
          this.writeKey(this.data.asr.cloud, apiKey, crest.verification !== undefined);
        }
      }
      if (realtime) {
        const { apiKey, ...rrest } = realtime;
        this.data.asr.realtime = { ...this.data.asr.realtime, ...stripUndefined(rrest) };
        if (apiKey !== undefined) {
          this.writeKey(this.data.asr.realtime, apiKey, rrest.verification !== undefined);
        }
      }
    }
    if (patch.ui) Object.assign(this.data.ui, stripUndefined(patch.ui));
    if (patch.audio) Object.assign(this.data.audio, stripUndefined(patch.audio));
    if (patch.rag) Object.assign(this.data.rag, stripUndefined(patch.rag));
    if (patch.webSearch) {
      const { apiKey, ...rest } = patch.webSearch;
      this.data.webSearch = { ...this.data.webSearch, ...stripUndefined(rest) };
      if (apiKey !== undefined) {
        this.writeKey(this.data.webSearch, apiKey, false);
      }
    }
    if (patch.exam) {
      const { banks, persona, ...rest } = patch.exam;
      this.data.exam = { ...this.data.exam, ...stripUndefined(rest) };
      if (banks) {
        const next = { ...(this.data.exam.banks ?? {}) } as Record<string, string | undefined>;
        for (const [mode, dir] of Object.entries(banks)) {
          // undefined keeps the binding, null/'' removes it (the UI can unbind
          // one sub-mode without touching the others)
          if (dir === null || dir === '') delete next[mode];
          else if (dir !== undefined) next[mode] = dir;
        }
        this.data.exam.banks = next;
      }
      if (persona === null) delete this.data.exam.persona;
      else if (persona) this.data.exam.persona = persona;
    }
    if (patch.privacy) {
      this.data.privacy = { ...this.data.privacy, ...stripUndefined(patch.privacy) };
    }
    if (patch.companion) {
      this.data.companion = { ...this.data.companion, ...stripUndefined(patch.companion) };
    }
    this.save();
  }

  /**
   * Persist the outcome of a connection test into one provider slot.
   *
   * Deliberately NOT routed through {@link applyPatch}: the `settings:set`
   * handler restarts the ASR engine whenever `asr.cloud` / `asr.realtime` is
   * present in a patch, so recording "the realtime key tested OK" that way
   * would bounce a live transcription session every time the user pressed
   * 重新测试. This writes the one field and saves, nothing else.
   */
  recordVerification(slot: ProviderSlot, verification: ProviderVerification): void {
    const value: ProviderVerification = { ...verification };
    switch (slot) {
      case 'llm':
        this.data.llm.verification = value;
        break;
      case 'vision':
        this.data.vision.verification = value;
        break;
      case 'asr-cloud':
        this.data.asr.cloud = { ...this.data.asr.cloud, verification: value };
        break;
      case 'asr-realtime':
        this.data.asr.realtime = { ...this.data.asr.realtime, verification: value };
        break;
    }
    this.save();
  }

  /**
   * Encrypt a plaintext key into a slot and derive its display hint main-side.
   * '' clears the slot. A key change invalidates the stored verification
   * unless the very same patch supplied a fresh one.
   */
  private writeKey(
    slot: { apiKeyEnc?: string; apiKeyHint?: string; verification?: ProviderVerification },
    apiKey: string,
    keepVerification: boolean,
  ): void {
    if (apiKey === '') {
      slot.apiKeyEnc = undefined;
      slot.apiKeyHint = undefined;
    } else {
      slot.apiKeyEnc = this.cipher.encrypt(apiKey);
      slot.apiKeyHint = apiKeyHint(apiKey);
    }
    if (!keepVerification) slot.verification = undefined;
  }

  getPublic(): PublicSettings {
    const d = this.data;
    return {
      version: 2,
      // the renderer must be able to warn before it hands over a plaintext key
      weakCrypto: !this.cipher.secure,
      onboarding: { ...d.onboarding },
      llm: {
        baseUrl: d.llm.baseUrl,
        model: d.llm.model,
        answerLang: d.llm.answerLang,
        answerWithVision: !!d.llm.answerWithVision,
        apiKeySet: !!d.llm.apiKeyEnc,
        providerId: d.llm.providerId,
        apiKeyHint: d.llm.apiKeyHint,
        verification: d.llm.verification,
        thinking: d.llm.thinking,
        thinkingByPreset: d.llm.thinkingByPreset ?? {},
        routing: {
          enabled: !!d.llm.routing?.enabled,
          byKind: d.llm.routing?.byKind ?? {},
          fallbackChain: d.llm.routing?.fallbackChain ?? [],
        },
        // routing-target key metadata only — never the key itself
        routeKeys: Object.fromEntries(
          Object.entries(d.llm.routeKeys ?? {}).map(([presetId, slot]) => [
            presetId,
            { apiKeySet: !!slot.apiKeyEnc, apiKeyHint: slot.apiKeyHint },
          ]),
        ),
      },
      vision: {
        baseUrl: d.vision.baseUrl,
        model: d.vision.model,
        proxyUrl: d.vision.proxyUrl,
        apiKeySet: !!d.vision.apiKeyEnc,
        ocrPrefilter: !!d.vision.ocrPrefilter,
        providerId: d.vision.providerId,
        apiKeyHint: d.vision.apiKeyHint,
        verification: d.vision.verification,
      },
      asr: {
        language: d.asr.language,
        modelsDir: d.asr.modelsDir,
        backend: d.asr.backend ?? 'local',
        providerId: d.asr.providerId,
        cloud: {
          baseUrl: d.asr.cloud?.baseUrl,
          model: d.asr.cloud?.model,
          apiKeySet: !!d.asr.cloud?.apiKeyEnc,
          apiKeyHint: d.asr.cloud?.apiKeyHint,
          verification: d.asr.cloud?.verification,
        },
        realtime: {
          baseUrl: d.asr.realtime?.baseUrl,
          model: d.asr.realtime?.model,
          apiKeySet: !!d.asr.realtime?.apiKeyEnc,
          apiKeyHint: d.asr.realtime?.apiKeyHint,
          verification: d.asr.realtime?.verification,
        },
        localRealtime: { model: d.asr.localRealtime?.model },
        strategy: d.asr.strategy ?? 'balanced',
        moonshineEnabled: !!d.asr.moonshineEnabled,
      },
      // knowledge lives in a separate file; main fills the real char count
      knowledge: { chars: 0 },
      ui: {
        ...d.ui,
        // optional on disk (files written before the dual-screen answer key
        // existed) but always a string on the wire
        hotkeyAnswer: d.ui.hotkeyAnswer ?? defaultHotkeysForPlatform(process.platform).answer,
        // clamped here so a hand-edited settings.json cannot produce a layout
        // where one pane is 0 px wide and the divider is unreachable
        paneSplit: clampPaneSplit(d.ui.paneSplit),
        answerOnly: !!d.ui.answerOnly,
        lang: d.ui.lang ?? this.fallbackUiLang,
        // both are optional on disk (files written before Phase 4 lack them)
        // but always booleans on the wire, so the UI needs no ?? dance
        autoLaunch: !!d.ui.autoLaunch,
        trayNoticeShown: !!d.ui.trayNoticeShown,
      },
      audio: {
        themDeviceId: d.audio.themDeviceId,
        micEnabled: d.audio.micEnabled,
        micDeviceId: d.audio.micDeviceId,
        captureBackend: d.audio.captureBackend ?? 'webaudio',
      },
      rag: {
        enabled: d.rag?.enabled !== false,
        model: d.rag?.model ?? 'bge-m3',
        topK: d.rag?.topK ?? 5,
        minScore: d.rag?.minScore ?? 0.2,
        remoteHost: d.rag?.remoteHost ?? 'https://hf-mirror.com',
        kbIndex: d.rag?.kbIndex ?? '',
      },
      webSearch: {
        enabled: !!d.webSearch?.enabled,
        providerId: d.webSearch?.providerId ?? DEFAULT_SEARCH_PROVIDER,
        apiKeySet: !!d.webSearch?.apiKeyEnc,
        apiKeyHint: d.webSearch?.apiKeyHint,
        maxResults: d.webSearch?.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
      },
      exam: {
        banks: d.exam?.banks ?? {},
        subMode: d.exam?.subMode ?? 'aptitude',
        persona: d.exam?.persona,
        bounds: d.exam?.bounds,
        preferOcr: d.exam?.preferOcr !== false,
        webFallback: !!d.exam?.webFallback,
        hotkeyOpen: d.exam?.hotkeyOpen ?? 'Control+Alt+B',
        hotkeyAsk: d.exam?.hotkeyAsk ?? 'Control+Alt+S',
      },
      privacy: {
        auditEnabled: !!d.privacy?.auditEnabled,
        captureReturns: !!d.privacy?.captureReturns,
        maxEntries: d.privacy?.maxEntries ?? 500,
      },
      companion: {
        enabled: !!d.companion?.enabled,
        // a 0/absent port would make the bind call throw inside the bridge and
        // the failure surfaces as "not running" with nothing to explain it
        port: clampInt(d.companion?.port, 1, 65535, 18765),
        pushExam: d.companion?.pushExam !== false,
        pushInterview: d.companion?.pushInterview !== false,
        pushTranscript: d.companion?.pushTranscript !== false,
        pushScreenshot: d.companion?.pushScreenshot !== false,
        useHttps: d.companion?.useHttps !== false,
        hotkeyToPhone: !!d.companion?.hotkeyToPhone,
        jpegQuality: clampInt(d.companion?.jpegQuality, 10, 100, 80),
        maxDim: clampInt(d.companion?.maxDim, 640, 4096, 1920),
      },
    };
  }

  getLlmApiKey(): string | undefined {
    if (!this.data.llm.apiKeyEnc) return undefined;
    try {
      return this.cipher.decrypt(this.data.llm.apiKeyEnc);
    } catch {
      return undefined;
    }
  }

  /** decrypted per-preset routing keys (upgrade P1); main-process only */
  getRouteKeys(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [presetId, slot] of Object.entries(this.data.llm.routeKeys ?? {})) {
      if (!slot.apiKeyEnc) continue;
      try {
        out[presetId] = this.cipher.decrypt(slot.apiKeyEnc);
      } catch {
        // an undecryptable slot (cipher change) behaves like "not set"
      }
    }
    return out;
  }

  getVisionApiKey(): string | undefined {
    if (!this.data.vision.apiKeyEnc) return undefined;
    try {
      return this.cipher.decrypt(this.data.vision.apiKeyEnc);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the vision slot, falling back to the text LLM where the user left
   * the field empty.
   *
   * Screenshot answering used to demand three hand-typed fields even when the
   * user's text provider also serves vision, so for almost everyone the flow
   * died at 「未配置视觉模型」. Now the endpoint and key are inherited and the
   * model name comes from that provider's vision preset in the catalog.
   *
   * A provider with no vision preset still yields `undefined` rather than a
   * guessed model — sending an image to a text-only endpoint fails deeper in
   * the stack with a worse message than being told to configure vision.
   *
   * The env var is the MyTool-style last resort, so a key already exported for
   * another tool does not have to be pasted again.
   */
  getVisionConfig():
    | { baseUrl: string; model: string; apiKey: string; proxyUrl?: string; inherited: boolean }
    | undefined {
    const v = this.data.vision;
    const l = this.data.llm;
    const ownBaseUrl = (v.baseUrl ?? '').trim();
    const baseUrl = ownBaseUrl || (l.baseUrl ?? '').trim();
    if (!baseUrl) return undefined;

    const ownModel = (v.model ?? '').trim();
    let model = ownModel;
    let proxyUrl = v.proxyUrl;
    if (!model) {
      // One model can do both jobs: if the text preset is declared to accept
      // images, reuse it verbatim (same endpoint, same key, same model).
      const textPreset = presetsForCapability('text-llm').find(
        (p) => p.visionCapable && p.model === (l.model ?? '').trim() && p.baseUrl === (l.baseUrl ?? '').trim(),
      );
      if (textPreset) {
        model = textPreset.model;
        proxyUrl = textPreset.defaultProxyUrl ?? v.proxyUrl;
      } else {
        // otherwise fall back to that provider's dedicated vision preset
        const providerId = ownBaseUrl
          ? providerIdForEndpoint(baseUrl, undefined, 'vision')
          : providerIdForEndpoint(l.baseUrl, l.model, 'text-llm');
        const preset = presetsForCapability('vision').find((p) => p.providerId === providerId);
        if (!preset) return undefined;
        model = preset.model;
        proxyUrl = preset.defaultProxyUrl;
      }
    }

    const envKey = (process.env.MEETINGASSISTANT_VISION_API_KEY ?? '').trim();
    const apiKey = this.getVisionApiKey() ?? (envKey || undefined) ?? this.getLlmApiKey();
    if (!model || !apiKey) return undefined;

    return {
      baseUrl,
      model,
      apiKey,
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
      // tells the UI it is riding on the text provider, so "I never set this
      // up" is answerable without reading the code
      inherited: !ownBaseUrl || !ownModel,
    };
  }

  getCloudAsrApiKey(): string | undefined {
    const enc = this.data.asr.cloud?.apiKeyEnc;
    if (!enc) return undefined;
    try {
      return this.cipher.decrypt(enc);
    } catch {
      return undefined;
    }
  }

  getRealtimeAsrApiKey(): string | undefined {
    const enc = this.data.asr.realtime?.apiKeyEnc;
    if (!enc) return undefined;
    try {
      return this.cipher.decrypt(enc);
    } catch {
      return undefined;
    }
  }

  /** the web-search key (KB-miss fallback); undefined = search never enabled */
  getWebSearchApiKey(): string | undefined {
    const enc = this.data.webSearch?.apiKeyEnc;
    if (!enc) return undefined;
    try {
      return this.cipher.decrypt(enc);
    } catch {
      return undefined;
    }
  }

  /** the stored key behind one slot — used by 「用已保存的 Key 重新测试」 */
  getApiKeyForSlot(slot: ProviderSlot): string | undefined {
    switch (slot) {
      case 'llm':
        return this.getLlmApiKey();
      case 'vision':
        return this.getVisionApiKey();
      case 'asr-cloud':
        return this.getCloudAsrApiKey();
      case 'asr-realtime':
        return this.getRealtimeAsrApiKey();
    }
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
