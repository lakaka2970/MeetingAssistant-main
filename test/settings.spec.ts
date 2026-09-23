import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SettingsStore,
  apiKeyHint,
  defaultSettings,
  migrateSettingsV1ToV2,
  plainCipher,
  type SecretCipher,
} from '../electron/settings';
import type { SettingsFile } from '../shared/protocol';
import { RAIL_SPLIT_DEFAULT, RAIL_SPLIT_MAX, RAIL_SPLIT_MIN } from '../shared/protocol';
import { DEFAULT_SEARCH_MAX_RESULTS } from '../shared/searchProviders';

const fakeCipher: SecretCipher = {
  available: () => true,
  secure: true,
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : ''),
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-settings-'));
  file = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('boots with defaults when no file exists', () => {
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data).toEqual(defaultSettings());
    // deepseek-flash is the default because it also reads images, so 截图做题
    // needs no second provider. It is the fast lane too, now that DeepSeek
    // accepts only this name and deepseek-v4-pro.
    expect(s.data.llm.model).toBe('deepseek-flash');
    expect(s.data.llm.answerLang).toBe('chinese');
    expect(s.data.ui.stealth).toBe(true);
    // v2: a brand new profile has never seen the wizard
    expect(s.data.version).toBe(2);
    expect(s.data.onboarding).toEqual({ schemaVersion: 1, completed: false });
    expect(s.migratedFromV1).toBe(false);
    // nothing was written; the wizard decides what the first file looks like
    expect(existsSync(file)).toBe(false);
  });

  it('boots with defaults on corrupt file (never crash boot)', () => {
    writeFileSync(file, '{"llm": {broken json', 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data).toEqual(defaultSettings());
  });

  it('round-trips a patch to disk', () => {
    const s1 = new SettingsStore(file, fakeCipher);
    s1.applyPatch({ asr: { language: 'chinese' }, ui: { hotkeyToggle: 'Alt+X' } });

    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.data.asr.language).toBe('chinese');
    expect(s2.data.ui.hotkeyToggle).toBe('Alt+X');
    // untouched sections keep defaults
    expect(s2.data.llm.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('clamps webSearch.maxResults in the public view', () => {
    // settings.json is user-editable; the renderer echo must not show 999
    // or NaN, matching how the companion port is clamped at the same line
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ webSearch: { maxResults: 999 } });
    expect(s.getPublic().webSearch.maxResults).toBe(10);
    s.applyPatch({ webSearch: { maxResults: NaN } });
    expect(s.getPublic().webSearch.maxResults).toBe(DEFAULT_SEARCH_MAX_RESULTS);
  });

  it('encrypts the api key at rest and never leaks it via getPublic', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ llm: { apiKey: 'sk-secret-123' } });

    expect(s.data.llm.apiKeyEnc).toBe(fakeCipher.encrypt('sk-secret-123'));
    expect(s.getLlmApiKey()).toBe('sk-secret-123');

    const pub = JSON.stringify(s.getPublic());
    expect(pub).not.toContain('sk-secret-123');
    expect(s.getPublic().llm.apiKeySet).toBe(true);

    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('sk-secret-123');
  });

  it('stores the vision key independently of the llm key', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ vision: { baseUrl: 'https://x/v1', model: 'qwen-vl-max', apiKey: 'sk-vision' } });
    expect(s.getVisionApiKey()).toBe('sk-vision');
    expect(s.getLlmApiKey()).toBeUndefined();
    expect(s.getPublic().vision.apiKeySet).toBe(true);
    expect(JSON.stringify(s.getPublic())).not.toContain('sk-vision');
  });

  it('defaults answerWithVision to false and exposes it publicly', () => {
    const s = new SettingsStore(file, fakeCipher);
    expect(s.getPublic().llm.answerWithVision).toBe(false);
    s.applyPatch({ llm: { answerWithVision: true } });
    expect(s.data.llm.answerWithVision).toBe(true);
    expect(s.getPublic().llm.answerWithVision).toBe(true);
  });

  it('answerWithVision patch does not clobber the api key', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ llm: { apiKey: 'sk-keep' } });
    s.applyPatch({ llm: { answerWithVision: true } });
    expect(s.getLlmApiKey()).toBe('sk-keep');
    expect(s.data.llm.answerWithVision).toBe(true);
  });

  describe('getVisionConfig (inherit the text provider)', () => {
    it('reuses the text model itself when that preset is declared vision-capable', () => {
      // The default configuration: one model, one key, answers and screenshots.
      // Nothing is looked up in the vision list, so the model name cannot drift
      // away from what the user actually selected.
      const s = new SettingsStore(file, fakeCipher);
      s.applyPatch({ llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-one' } });
      const v = s.getVisionConfig();
      expect(v!.model).toBe('deepseek-flash');
      expect(v!.apiKey).toBe('sk-one');
      expect(v!.inherited).toBe(true);
    });

    it('inherits endpoint and key, taking the model from the catalog vision preset', () => {
      // This is what unblocks 截图做题: a DeepSeek user configures one key and
      // gets a working vision endpoint without ever opening 设置 → 视觉模型.
      // deepseek-v4-pro is the text lane that does NOT take images, so the model
      // has to come from the deepseek.vision preset.
      const s = new SettingsStore(file, fakeCipher);
      s.applyPatch({ llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', apiKey: 'sk-deep' } });
      const v = s.getVisionConfig();
      expect(v).toBeDefined();
      expect(v!.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(v!.model).toBe('deepseek-flash');
      expect(v!.apiKey).toBe('sk-deep');
      expect(v!.inherited).toBe(true);
    });

    it('explicit vision settings win over the inherited ones', () => {
      const s = new SettingsStore(file, fakeCipher);
      s.applyPatch({ llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-deep' } });
      s.applyPatch({ vision: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v', apiKey: 'sk-zhipu' } });
      const v = s.getVisionConfig();
      expect(v!.model).toBe('glm-4v');
      expect(v!.apiKey).toBe('sk-zhipu');
      expect(v!.inherited).toBe(false);
    });

    it('returns undefined for a provider with no vision preset instead of guessing a model', () => {
      // Sending an image to a text-only endpoint fails deeper in the stack with
      // a worse message than being told vision is not configured.
      const s = new SettingsStore(file, fakeCipher);
      s.applyPatch({ llm: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3', apiKey: 'sk-ollama' } });
      expect(s.getVisionConfig()).toBeUndefined();
    });

    it('returns undefined when no key exists anywhere', () => {
      const s = new SettingsStore(file, fakeCipher);
      s.applyPatch({ llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } });
      expect(s.getVisionConfig()).toBeUndefined();
    });

    it('accepts a key from the environment between the two stored keys', () => {
      const prev = process.env.MEETINGASSISTANT_VISION_API_KEY;
      process.env.MEETINGASSISTANT_VISION_API_KEY = 'sk-from-env';
      try {
        const s = new SettingsStore(file, fakeCipher);
        s.applyPatch({ llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } });
        expect(s.getVisionConfig()?.apiKey).toBe('sk-from-env');
      } finally {
        if (prev === undefined) delete process.env.MEETINGASSISTANT_VISION_API_KEY;
        else process.env.MEETINGASSISTANT_VISION_API_KEY = prev;
      }
    });

    it('the stored vision key beats the environment', () => {
      const prev = process.env.MEETINGASSISTANT_VISION_API_KEY;
      process.env.MEETINGASSISTANT_VISION_API_KEY = 'sk-from-env';
      try {
        const s = new SettingsStore(file, fakeCipher);
        s.applyPatch({ llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-llm' } });
        s.applyPatch({ vision: { apiKey: 'sk-own' } });
        expect(s.getVisionConfig()?.apiKey).toBe('sk-own');
      } finally {
        if (prev === undefined) delete process.env.MEETINGASSISTANT_VISION_API_KEY;
        else process.env.MEETINGASSISTANT_VISION_API_KEY = prev;
      }
    });
  });

  describe('retired DeepSeek model names', () => {
    const write = (llm: Record<string, unknown>, vision?: Record<string, unknown>): void => {
      writeFileSync(file, JSON.stringify({ version: 2, llm, ...(vision ? { vision } : {}) }), 'utf8');
    };

    it('rewrites an old name on load so the profile stops 400ing', () => {
      for (const old of ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4.1-flash']) {
        write({ baseUrl: 'https://api.deepseek.com/v1', model: old });
        expect(new SettingsStore(file, fakeCipher).data.llm.model, old).toBe('deepseek-flash');
      }
    });

    it('rewrites the vision slot and the routing lanes too', () => {
      write(
        {
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          routing: {
            enabled: true,
            byKind: { coding: 'deepseek.text.thinking' },
            fallbackChain: ['deepseek.text.v41flash', 'zhipu.text.flash'],
          },
        },
        { model: 'deepseek-v4.1-flash' },
      );
      const s = new SettingsStore(file, fakeCipher);
      expect(s.data.vision.model).toBe('deepseek-flash');
      expect(s.data.llm.routing?.byKind?.coding).toBe('deepseek.text.deep');
      expect(s.data.llm.routing?.fallbackChain).toEqual([
        'deepseek.text.fast',
        'zhipu.text.flash',
      ]);
    });

    it('leaves a relay that still serves the old names exactly as typed', () => {
      // only DeepSeek's own endpoint retired these — a proxy is not ours to edit
      write({ baseUrl: 'https://relay.example.com/v1', model: 'deepseek-chat' });
      expect(new SettingsStore(file, fakeCipher).data.llm.model).toBe('deepseek-chat');
    });

    it('leaves a current name alone', () => {
      write({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' });
      expect(new SettingsStore(file, fakeCipher).data.llm.model).toBe('deepseek-v4-pro');
    });
  });

  describe('retired ui fields (paneSplit / answerOnly / opacity / earlyAnswer) + privacy', () => {
    it('loads an old file that still carries them, and keeps them off the wire', () => {
      // mergeWithDefaults is forward-compatible, so the keys survive in
      // data; the guarantee delivery needs is that getPublic never emits
      // them and boot never throws on them
      writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          ui: {
            stealth: true,
            hotkeyToggle: 'Alt+Q',
            hotkeyShot: 'Alt+W',
            earlyAnswer: true,
            paneSplit: 0.62,
            answerOnly: true,
            opacity: 0.8,
            fontScale: 'medium',
            theme: 'dark',
          },
          privacy: { auditEnabled: true, captureReturns: true, maxEntries: 99 },
        }),
        'utf8',
      );
      const s = new SettingsStore(file, fakeCipher);
      const ui = JSON.stringify(s.getPublic().ui);
      expect(ui).not.toMatch(/paneSplit|answerOnly|opacity|earlyAnswer/);
      expect(s.getPublic()).not.toHaveProperty('privacy');
      // live neighbours survive
      expect(s.getPublic().ui.hotkeyToggle).toBe('Alt+Q');
      expect(s.getPublic().ui.railSplit).toBe(RAIL_SPLIT_DEFAULT);
    });
  });

  describe('ui.railSplit (draggable glance rail)', () => {
    it('defaults to the narrow glance width, not the old half-screen paneSplit', () => {
      const s = new SettingsStore(file, fakeCipher);
      expect(s.getPublic().ui.railSplit).toBe(RAIL_SPLIT_DEFAULT);
    });

    it('clamps so the rail can never vanish nor swallow the answer pane', () => {
      const s = new SettingsStore(file, fakeCipher);
      s.applyPatch({ ui: { railSplit: 0.01 } });
      expect(s.getPublic().ui.railSplit).toBe(RAIL_SPLIT_MIN);
      s.applyPatch({ ui: { railSplit: 0.99 } });
      expect(s.getPublic().ui.railSplit).toBe(RAIL_SPLIT_MAX);
    });

    it('falls back to the default on garbage instead of emitting a NaN width', () => {
      writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          ui: {
            stealth: true,
            hotkeyToggle: 'Alt+Q',
            hotkeyShot: 'Alt+W',
            opacity: 0.9,
            fontScale: 'medium',
            theme: 'dark',
            railSplit: 'wide',
          },
        }),
        'utf8',
      );
      const s = new SettingsStore(file, fakeCipher);
      expect(s.getPublic().ui.railSplit).toBe(RAIL_SPLIT_DEFAULT);
    });
  });

  it('defaults asr backend to local streaming Fun-ASR-Nano', () => {
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data.asr.backend).toBe('local-realtime');
    expect(s.getPublic().asr.backend).toBe('local-realtime');
    expect(s.getPublic().asr.localRealtime.model).toBe('fun-asr-nano');
    expect(s.getPublic().asr.realtime.apiKeySet).toBe(false);
    expect(s.getPublic().asr.cloud.apiKeySet).toBe(false);
  });

  it('keeps the localRealtime defaults when the stored file predates the field', () => {
    writeFileSync(file, JSON.stringify({ version: 1, asr: { language: 'auto', backend: 'local' } }), 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data.asr.backend).toBe('local'); // stored choice wins
    expect(s.data.asr.localRealtime?.model).toBe('fun-asr-nano'); // defaults fill the gap
  });

  it('localRealtime model patch round-trips without touching other slots', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({
      asr: { backend: 'local-realtime', localRealtime: { model: 'paraformer-zh-streaming' } },
    });
    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.data.asr.backend).toBe('local-realtime');
    expect(s2.data.asr.localRealtime?.model).toBe('paraformer-zh-streaming');
    expect(s2.getPublic().asr.localRealtime.model).toBe('paraformer-zh-streaming');
  });

  it('stores a nested cloud ASR provider + key, round-trips, and never leaks it', () => {
    const s1 = new SettingsStore(file, fakeCipher);
    s1.applyPatch({
      asr: { backend: 'cloud', cloud: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-asr', apiKey: 'sk-mimo' } },
    });
    expect(s1.getCloudAsrApiKey()).toBe('sk-mimo');
    expect(JSON.stringify(s1.getPublic())).not.toContain('sk-mimo');

    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.data.asr.backend).toBe('cloud');
    expect(s2.data.asr.cloud?.model).toBe('mimo-v2.5-asr');
    expect(s2.getCloudAsrApiKey()).toBe('sk-mimo');
  });

  it('cloud patch does not clobber sibling asr fields', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ asr: { language: 'chinese' } });
    s.applyPatch({ asr: { cloud: { model: 'mimo-v2.5-asr' } } });
    expect(s.data.asr.language).toBe('chinese');
    expect(s.data.asr.cloud?.model).toBe('mimo-v2.5-asr');
  });

  it('clears the api key when set to empty string', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ llm: { apiKey: 'sk-x' } });
    s.applyPatch({ llm: { apiKey: '' } });
    expect(s.data.llm.apiKeyEnc).toBeUndefined();
    expect(s.getPublic().llm.apiKeySet).toBe(false);
  });

  it('defaults ui theme=dark and fontScale=medium (16px answer body)', () => {
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data.ui.theme).toBe('dark');
    expect(s.data.ui.fontScale).toBe('medium');
    expect(s.getPublic().ui.theme).toBe('dark');
    expect(s.getPublic().ui.fontScale).toBe('medium');
  });

  it('theme/fontScale patch round-trips and fills defaults for older files', () => {
    writeFileSync(file, JSON.stringify({ version: 1, ui: { stealth: false } }), 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data.ui.stealth).toBe(false); // stored choice wins
    expect(s.data.ui.theme).toBe('dark'); // defaults fill the gap
    s.applyPatch({ ui: { theme: 'light', fontScale: 'large' } });
    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.data.ui.theme).toBe('light');
    expect(s2.data.ui.fontScale).toBe('large');
    expect(s2.data.ui.stealth).toBe(false); // sibling untouched
  });

  it('merges unknown/missing sections gracefully (migration-friendly)', () => {
    writeFileSync(file, JSON.stringify({ version: 1, llm: { model: 'custom-model' } }), 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data.llm.model).toBe('custom-model');
    expect(s.data.ui.hotkeyToggle).toBe(process.platform === 'darwin' ? 'Command+B' : 'Control+B');
    expect(s.data.asr.language).toBe('auto');
  });

  it('partial patch does not clobber sibling fields', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ llm: { apiKey: 'sk-1' } });
    s.applyPatch({ llm: { model: 'deepseek-v4-pro' } });
    expect(s.getLlmApiKey()).toBe('sk-1');
    expect(s.data.llm.model).toBe('deepseek-v4-pro');
  });

  it('round-trips the macOS input device used for the other-party channel', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ audio: { themDeviceId: 'blackhole-2ch' } });

    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.data.audio.themDeviceId).toBe('blackhole-2ch');
    expect(s2.getPublic().audio.themDeviceId).toBe('blackhole-2ch');
  });
});

// ---------------------------------------------------------------- v2 schema

/** a realistic pre-v2 file: real ciphertexts, cloud realtime ASR, custom vision */
const V1_FILE = {
  version: 1,
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    answerLang: 'chinese',
    answerWithVision: false,
    apiKeyEnc: 'enc:c2stZGVlcHNlZWs=',
  },
  vision: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    proxyUrl: '127.0.0.1:7897',
    apiKeyEnc: 'enc:c2stZ2VtaW5p',
  },
  asr: {
    language: 'auto',
    backend: 'cloud-realtime',
    cloud: {},
    realtime: {
      baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      model: 'fun-asr-realtime',
      apiKeyEnc: 'enc:c2stYWxpeXVu',
    },
    localRealtime: { model: 'fun-asr-nano' },
  },
  ui: {
    stealth: false,
    hotkeyToggle: 'Alt+Q',
    hotkeyShot: 'Alt+W',
    // every hotkey is pinned here on purpose: a field left out of the fixture
    // would be filled from the *running platform's* defaults, and the
    // byte-for-byte assertion below would then pass on Windows and fail on macOS
    hotkeyAnswer: 'Alt+E',
    // pinned like every other field: anything left out is filled from the
    // defaults, which would make this assertion test the defaults instead of
    // the migration
    paneSplit: 0.62,
    answerOnly: true,
    opacity: 0.8,
    fontScale: 'large',
    theme: 'light',
    lang: 'en',
  },
  audio: { micEnabled: true, micDeviceId: 'mic-1', themDeviceId: 'them-1' },
};

describe('migrateSettingsV1ToV2 (pure)', () => {
  it('preserves every configured field, ciphertexts byte-for-byte', () => {
    const v2 = migrateSettingsV1ToV2(V1_FILE);
    expect(v2.version).toBe(2);
    expect(v2.llm.apiKeyEnc).toBe(V1_FILE.llm.apiKeyEnc);
    expect(v2.vision.apiKeyEnc).toBe(V1_FILE.vision.apiKeyEnc);
    expect(v2.asr.realtime?.apiKeyEnc).toBe(V1_FILE.asr.realtime.apiKeyEnc);
    expect(v2.llm.baseUrl).toBe(V1_FILE.llm.baseUrl);
    expect(v2.vision.proxyUrl).toBe('127.0.0.1:7897');
    expect(v2.asr.backend).toBe('cloud-realtime');
    expect(v2.asr.realtime?.baseUrl).toBe(V1_FILE.asr.realtime.baseUrl);
    // Phase 4 added two ui fields. Everything the user had configured survives
    // untouched; the new ones arrive with their OFF defaults, so upgrading can
    // never silently register an existing profile for auto-start.
    expect(v2.ui).toEqual({ ...V1_FILE.ui, autoLaunch: false, trayNoticeShown: false, railSplit: RAIL_SPLIT_DEFAULT });
    expect(v2.audio).toEqual({ ...V1_FILE.audio, captureBackend: 'webaudio' });
  });

  it('fills a ui.hotkeyAnswer the file never had, from the running platform', () => {
    // The dual-screen answer key postdates every existing settings.json, so a
    // migrated profile must come back with a real binding rather than nothing —
    // registerHotkeys() would otherwise silently have no key to register.
    // The key is deleted outright: a JSON file can be missing a field, it can
    // never hold an explicit `undefined`.
    const withoutKey = { ...V1_FILE.ui } as Record<string, unknown>;
    delete withoutKey.hotkeyAnswer;
    const v2 = migrateSettingsV1ToV2({ ...V1_FILE, ui: withoutKey });
    expect(v2.ui.hotkeyAnswer).toBeTruthy();
    // and the keys the user did configure still win over the defaults
    expect(v2.ui.hotkeyToggle).toBe(V1_FILE.ui.hotkeyToggle);
  });

  it('grandfathers existing users past the wizard', () => {
    const v2 = migrateSettingsV1ToV2(V1_FILE);
    expect(v2.onboarding.completed).toBe(true);
    expect(v2.onboarding.schemaVersion).toBe(1);
    // never claims a plan the user did not pick
    expect(v2.onboarding.selectedPlan).toBeUndefined();
  });

  it('marks the profile as migrated so the upgrade notice can target it', () => {
    expect(migrateSettingsV1ToV2(V1_FILE).onboarding.migratedFromV1).toBe(true);
    // a brand new profile is NOT a migrated one — it must never see the notice
    expect(defaultSettings().onboarding.migratedFromV1).toBeUndefined();
    expect(migrateSettingsV1ToV2(V1_FILE).onboarding.dismissedUpgradePrompt).toBeUndefined();
  });

  it('infers providerId from the catalog by exact baseUrl+model', () => {
    const v2 = migrateSettingsV1ToV2(V1_FILE);
    expect(v2.llm.providerId).toBe('deepseek');
    expect(v2.vision.providerId).toBe('gemini');
    expect(v2.asr.providerId).toBe('aliyun-dashscope-cn');
  });

  it('falls back to custom for unknown endpoints', () => {
    const v2 = migrateSettingsV1ToV2({
      ...V1_FILE,
      llm: { ...V1_FILE.llm, baseUrl: 'https://relay.example.com/v1', model: 'gpt-whatever' },
      vision: { baseUrl: 'https://relay.example.com/v1', model: 'vl-whatever' },
      asr: {
        ...V1_FILE.asr,
        realtime: { baseUrl: 'wss://relay.example.com/ws', model: 'rt-whatever' },
      },
    });
    expect(v2.llm.providerId).toBe('custom');
    expect(v2.vision.providerId).toBe('custom');
    expect(v2.asr.providerId).toBe('custom');
  });

  it('leaves asr.providerId absent for local backends and unset vision', () => {
    const v2 = migrateSettingsV1ToV2({
      version: 1,
      asr: { language: 'auto', backend: 'local-realtime', localRealtime: { model: 'fun-asr-nano' } },
    });
    expect(v2.asr.providerId).toBeUndefined();
    expect(v2.vision.providerId).toBeUndefined();
  });

  it('does not invent an apiKeyHint it cannot compute', () => {
    const v2 = migrateSettingsV1ToV2(V1_FILE);
    expect(v2.llm.apiKeyHint).toBeUndefined();
    expect(v2.asr.realtime?.apiKeyHint).toBeUndefined();
  });

  it('fills missing sections from the defaults', () => {
    const v2 = migrateSettingsV1ToV2({ version: 1, llm: { model: 'custom-model' } });
    expect(v2.llm.model).toBe('custom-model');
    expect(v2.llm.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(v2.asr.language).toBe('auto');
    expect(v2.audio.micEnabled).toBe(false);
  });

  it('throws on input that is not a JSON object', () => {
    expect(() => migrateSettingsV1ToV2(null)).toThrow();
    expect(() => migrateSettingsV1ToV2('nope')).toThrow();
    expect(() => migrateSettingsV1ToV2([1, 2, 3])).toThrow();
  });
});

describe('SettingsStore v1 -> v2 load path', () => {
  it('migrates on load, backs the original up to settings.json.bak and rewrites v2', () => {
    const original = JSON.stringify(V1_FILE, null, 2);
    writeFileSync(file, original, 'utf8');

    const s = new SettingsStore(file, fakeCipher);
    expect(s.migratedFromV1).toBe(true);
    expect(s.data.version).toBe(2);
    expect(s.data.onboarding.completed).toBe(true);

    // the v1 original is recoverable, byte-for-byte
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(original);

    // the live file is v2 and still carries the ciphertexts
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as SettingsFile;
    expect(onDisk.version).toBe(2);
    expect(onDisk.llm.apiKeyEnc).toBe(V1_FILE.llm.apiKeyEnc);
    expect(onDisk.asr.realtime?.apiKeyEnc).toBe(V1_FILE.asr.realtime.apiKeyEnc);
    expect(s.getLlmApiKey()).toBe('sk-deepseek');
    expect(s.getRealtimeAsrApiKey()).toBe('sk-aliyun');

    // reloading the migrated file is a no-op
    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.migratedFromV1).toBe(false);
    expect(s2.data).toEqual(s.data);
  });

  it('treats a file without a version field as v1', () => {
    writeFileSync(file, JSON.stringify({ llm: { model: 'legacy' } }), 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.migratedFromV1).toBe(true);
    expect(s.data.llm.model).toBe('legacy');
    expect(s.data.onboarding.completed).toBe(true);
  });

  it('never overwrites an existing .bak', () => {
    writeFileSync(file, JSON.stringify(V1_FILE), 'utf8');
    writeFileSync(`${file}.bak`, 'an older original', 'utf8');
    new SettingsStore(file, fakeCipher);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('an older original');
  });

  it('keeps a corrupt file untouched and boots with defaults', () => {
    const corrupt = '{"llm": {broken json';
    writeFileSync(file, corrupt, 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data).toEqual(defaultSettings());
    expect(s.migratedFromV1).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(corrupt);
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  it('keeps the original untouched when migration throws (valid JSON, wrong shape)', () => {
    const weird = '"not an object"';
    writeFileSync(file, weird, 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.data).toEqual(defaultSettings());
    expect(s.data.onboarding.completed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(weird);
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  it('loads a v2 file without migrating or backing it up', () => {
    const v2: SettingsFile = {
      ...defaultSettings(),
      onboarding: { schemaVersion: 1, completed: false, lastStep: 3, selectedPlan: 'recommended' },
    };
    writeFileSync(file, JSON.stringify(v2), 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.migratedFromV1).toBe(false);
    expect(existsSync(`${file}.bak`)).toBe(false);
    expect(s.data.onboarding).toEqual({
      schemaVersion: 1,
      completed: false,
      lastStep: 3,
      selectedPlan: 'recommended',
    });
  });
});

describe('weak-crypto reporting', () => {
  it('reports secure storage when the OS cipher is in use', () => {
    expect(new SettingsStore(file, fakeCipher).getPublic().weakCrypto).toBe(false);
  });

  it('flags the plainCipher fallback so the UI can warn before saving a key', () => {
    const s = new SettingsStore(file, plainCipher);
    expect(s.getPublic().weakCrypto).toBe(true);
    // the flag survives a save round-trip: settings:set returns getPublic()
    s.applyPatch({ llm: { apiKey: 'sk-weak-1234' } });
    const pub = s.getPublic();
    expect(pub.weakCrypto).toBe(true);
    expect(pub.llm.apiKeySet).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('sk-weak-1234');
  });

  it('is a runtime flag, never persisted to disk', () => {
    const s = new SettingsStore(file, plainCipher);
    s.applyPatch({ llm: { apiKey: 'sk-weak-1234' } });
    expect(readFileSync(file, 'utf8')).not.toContain('weakCrypto');
  });
});

describe('SettingsStore onboarding + key hints', () => {
  it('persists wizard progress without ever completing onboarding', () => {
    const s = new SettingsStore(file, fakeCipher);
    const state = s.saveOnboardingProgress({ lastStep: 2, selectedPlan: 'mimo-simple' });
    expect(state).toEqual({
      schemaVersion: 1,
      completed: false,
      lastStep: 2,
      selectedPlan: 'mimo-simple',
    });
    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.data.onboarding.lastStep).toBe(2);
    expect(s2.data.onboarding.completed).toBe(false);
  });

  it('completes onboarding with a timestamp and the chosen plan', () => {
    const s = new SettingsStore(file, fakeCipher);
    const state = s.completeOnboarding({ selectedPlan: 'recommended' });
    expect(state.completed).toBe(true);
    expect(state.selectedPlan).toBe('recommended');
    expect(Date.parse(state.completedAt!)).not.toBeNaN();

    const s2 = new SettingsStore(file, fakeCipher);
    expect(s2.data.onboarding.completed).toBe(true);
    expect(s2.getPublic().onboarding.completed).toBe(true);
  });

  it('lets the main window dismiss the upgrade notice', () => {
    writeFileSync(file, JSON.stringify(V1_FILE), 'utf8');
    const s = new SettingsStore(file, fakeCipher);
    expect(s.getOnboarding().dismissedUpgradePrompt).toBeUndefined();
    s.saveOnboardingProgress({ dismissedUpgradePrompt: true });
    expect(new SettingsStore(file, fakeCipher).data.onboarding.dismissedUpgradePrompt).toBe(true);
  });

  it('computes the key hint main-side and never exposes more than 4 characters', () => {
    expect(apiKeyHint('sk-abcdefgh')).toBe('efgh');
    expect(apiKeyHint('ab')).toBe('ab');
    expect(apiKeyHint('')).toBeUndefined();

    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({ llm: { apiKey: 'sk-topsecret-9911' } });
    expect(s.data.llm.apiKeyHint).toBe('9911');
    const pub = s.getPublic();
    expect(pub.llm.apiKeyHint).toBe('9911');
    expect(JSON.stringify(pub)).not.toContain('sk-topsecret-9911');
  });

  it('clears the hint and verification when a key is deleted', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({
      asr: {
        realtime: {
          baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
          model: 'fun-asr-realtime',
          apiKey: 'sk-aliyun-4321',
          verification: { lastTestOk: true, lastTestCode: 'OK' },
        },
      },
    });
    expect(s.data.asr.realtime?.apiKeyHint).toBe('4321');
    expect(s.getPublic().asr.realtime.verification?.lastTestCode).toBe('OK');

    s.applyPatch({ asr: { realtime: { apiKey: '' } } });
    expect(s.data.asr.realtime?.apiKeyHint).toBeUndefined();
    expect(s.data.asr.realtime?.apiKeyEnc).toBeUndefined();
    // a key change invalidates the previous test result
    expect(s.data.asr.realtime?.verification).toBeUndefined();
  });

  it('MC_DEV_DEFAULT_LOCAL_ASR=1 keeps the pre-wizard developer boot', () => {
    const before = process.env.MC_DEV_DEFAULT_LOCAL_ASR;
    try {
      process.env.MC_DEV_DEFAULT_LOCAL_ASR = '1';
      const s = new SettingsStore(file, fakeCipher);
      // straight to the main window, with the local sidecar backend as before
      expect(s.data.onboarding.completed).toBe(true);
      expect(s.data.asr.backend).toBe('local-realtime');
    } finally {
      if (before === undefined) delete process.env.MC_DEV_DEFAULT_LOCAL_ASR;
      else process.env.MC_DEV_DEFAULT_LOCAL_ASR = before;
    }
    expect(new SettingsStore(file, fakeCipher).data.onboarding.completed).toBe(false);
  });

  it('round-trips providerId and verification through the public settings', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({
      llm: {
        providerId: 'deepseek',
        verification: { lastTestOk: true, lastTestCode: 'OK', latencyMs: 120 },
      },
      asr: { providerId: 'aliyun-dashscope-cn' },
    });
    const pub = s.getPublic();
    expect(pub.version).toBe(2);
    expect(pub.llm.providerId).toBe('deepseek');
    expect(pub.llm.verification).toEqual({ lastTestOk: true, lastTestCode: 'OK', latencyMs: 120 });
    expect(pub.asr.providerId).toBe('aliyun-dashscope-cn');
  });
});

describe('SettingsStore.recordVerification', () => {
  const verdict = {
    lastTestAt: '2026-08-17T10:00:00.000Z',
    lastTestOk: true,
    lastTestCode: 'OK' as const,
    latencyMs: 412,
  };

  it('writes the verdict into each slot and persists it', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.recordVerification('llm', verdict);
    s.recordVerification('vision', { ...verdict, lastTestOk: false, lastTestCode: 'TIMEOUT' });
    s.recordVerification('asr-cloud', { ...verdict, latencyMs: 900 });
    s.recordVerification('asr-realtime', { ...verdict, latencyMs: 88 });

    const reloaded = new SettingsStore(file, fakeCipher);
    expect(reloaded.data.llm.verification).toEqual(verdict);
    expect(reloaded.data.vision.verification?.lastTestCode).toBe('TIMEOUT');
    expect(reloaded.data.asr.cloud?.verification?.latencyMs).toBe(900);
    expect(reloaded.data.asr.realtime?.verification?.latencyMs).toBe(88);
    expect(reloaded.getPublic().asr.realtime.verification?.lastTestOk).toBe(true);
  });

  // this is the whole reason the method exists: settings:set restarts the ASR
  // engine whenever asr.cloud / asr.realtime appear in a patch, so a test
  // result must never travel through applyPatch()
  it('touches nothing but the one verification field', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({
      llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-llm-1111' },
      asr: {
        backend: 'cloud-realtime',
        language: 'chinese',
        realtime: {
          baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
          model: 'fun-asr-realtime',
          apiKey: 'sk-rt-2222',
        },
      },
      ui: { stealth: false },
    });
    const before = JSON.parse(JSON.stringify(s.data)) as SettingsFile;

    s.recordVerification('asr-realtime', verdict);

    const after = s.data;
    expect(after.asr.realtime?.verification).toEqual(verdict);
    // key, endpoint, model, hint, backend, language and every other section
    // survive byte-for-byte
    expect(after.asr.realtime?.apiKeyEnc).toBe(before.asr.realtime?.apiKeyEnc);
    expect(after.asr.realtime?.apiKeyHint).toBe('2222');
    expect(after.asr.realtime?.baseUrl).toBe(before.asr.realtime?.baseUrl);
    expect(after.asr.realtime?.model).toBe(before.asr.realtime?.model);
    expect(after.asr.backend).toBe('cloud-realtime');
    expect(after.asr.language).toBe('chinese');
    expect(after.llm).toEqual(before.llm);
    expect(after.vision).toEqual(before.vision);
    expect(after.ui).toEqual(before.ui);
    expect(after.audio).toEqual(before.audio);
    expect(after.onboarding).toEqual(before.onboarding);
    expect(after.asr.cloud).toEqual(before.asr.cloud);
  });

  it('overwrites an older verdict rather than merging with it', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.recordVerification('llm', verdict);
    s.recordVerification('llm', {
      lastTestAt: '2026-08-17T11:00:00.000Z',
      lastTestOk: false,
      lastTestCode: 'RATE_LIMITED',
    });
    expect(s.data.llm.verification).toEqual({
      lastTestAt: '2026-08-17T11:00:00.000Z',
      lastTestOk: false,
      lastTestCode: 'RATE_LIMITED',
    });
    expect(s.data.llm.verification?.latencyMs).toBeUndefined();
  });

  it('resolves the stored key for each slot', () => {
    const s = new SettingsStore(file, fakeCipher);
    s.applyPatch({
      llm: { apiKey: 'sk-llm-1111' },
      vision: { apiKey: 'sk-vis-2222' },
      asr: { cloud: { apiKey: 'sk-seg-3333' }, realtime: { apiKey: 'sk-rt-4444' } },
    });
    expect(s.getApiKeyForSlot('llm')).toBe('sk-llm-1111');
    expect(s.getApiKeyForSlot('vision')).toBe('sk-vis-2222');
    expect(s.getApiKeyForSlot('asr-cloud')).toBe('sk-seg-3333');
    expect(s.getApiKeyForSlot('asr-realtime')).toBe('sk-rt-4444');
    expect(new SettingsStore(join(dir, 'other.json'), fakeCipher).getApiKeyForSlot('llm')).toBeUndefined();
  });
});
