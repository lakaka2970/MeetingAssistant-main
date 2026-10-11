import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_LINK_ALLOWED_HOSTS,
  LOCAL_REALTIME_MODELS,
  PROVIDER_HELP,
  PROVIDER_PRESETS,
  findPresetByEndpoint,
  findPresetById,
  presetsForCapability,
  providerIdForEndpoint,
  type ProviderHelp,
} from '../shared/providerCatalog';

const urlFields: (keyof ProviderHelp)[] = ['platformUrl', 'keyUrl', 'docsUrl'];

function helpUrls(help: ProviderHelp): string[] {
  return urlFields.map((f) => help[f]).filter((v): v is string => typeof v === 'string');
}

describe('providerCatalog', () => {
  it('has unique, stable preset ids', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships the stable ids the wizard and settings depend on', () => {
    for (const id of [
      'deepseek.text.fast',
      'deepseek.text.deep',
      'deepseek.vision',
      'aliyun.cn.asr.fun-realtime',
      'aliyun.cn.asr.paraformer-realtime-v2',
      'mimo.text.fast',
      'mimo.asr.segment',
      'mimo.vision',
      'gemini.vision.flash',
      'custom.openai.text',
    ]) {
      expect(findPresetById(id), `missing preset ${id}`).toBeTruthy();
    }
  });

  it('gives every preset a zh and an en name plus a description', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.nameZh.length, p.id).toBeGreaterThan(0);
      expect(p.nameEn.length, p.id).toBeGreaterThan(0);
      expect(p.descriptionZh.length, p.id).toBeGreaterThan(0);
      expect(p.descriptionEn.length, p.id).toBeGreaterThan(0);
    }
  });

  it('gives every non-custom preset a non-empty baseUrl and model', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.providerId === 'custom') continue;
      expect(p.baseUrl.length, p.id).toBeGreaterThan(0);
      expect(p.model.length, p.id).toBeGreaterThan(0);
    }
  });

  it('recommends exactly one preset per onboarding capability', () => {
    const recommendedText = presetsForCapability('text-llm').filter((p) => p.recommended);
    const recommendedAsr = presetsForCapability('asr-realtime').filter((p) => p.recommended);
    // deepseek-flash is the recommended default because it also reads images;
    // the invariant that matters is "exactly one", not which one.
    expect(recommendedText.map((p) => p.id)).toEqual(['deepseek.text.fast']);
    expect(recommendedAsr.map((p) => p.id)).toEqual(['aliyun.cn.asr.fun-realtime']);
  });

  it('declares at most one vision-capable text preset per provider+model pair', () => {
    // getVisionConfig() reuses the text model wholesale when its preset says it
    // can take images, so a duplicate (baseUrl, model) marked visionCapable
    // would make that lookup order-dependent.
    const seen = new Set<string>();
    for (const p of presetsForCapability('text-llm').filter((x) => x.visionCapable)) {
      const key = `${p.baseUrl}|${p.model}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
    expect([...seen]).toContain('https://api.deepseek.com/v1|deepseek-flash');
  });

  it('gives recommended presets real help links and tutorial steps', () => {
    for (const p of PROVIDER_PRESETS.filter((x) => x.recommended)) {
      expect(p.help.keyUrl, p.id).toBeTruthy();
      expect(p.help.docsUrl, p.id).toBeTruthy();
      expect(p.help.stepsZh.length, p.id).toBeGreaterThan(2);
      expect(p.help.stepsEn.length, p.id).toBe(p.help.stepsZh.length);
    }
  });

  it('keeps zh and en tutorials in lockstep for every provider', () => {
    for (const [providerId, help] of Object.entries(PROVIDER_HELP)) {
      expect(help.stepsZh.length, providerId).toBeGreaterThan(0);
      expect(help.stepsEn.length, providerId).toBe(help.stepsZh.length);
      expect(help.stepsZh.every((s) => s.trim().length > 0), providerId).toBe(true);
      expect(help.stepsEn.every((s) => s.trim().length > 0), providerId).toBe(true);
      if (help.faqZh || help.faqEn) {
        expect(help.faqEn?.length, providerId).toBe(help.faqZh?.length);
      }
      if (help.billingHintZh || help.billingHintEn) {
        expect(help.billingHintZh, providerId).toBeTruthy();
        expect(help.billingHintEn, providerId).toBeTruthy();
      }
    }
  });

  it('only links to https URLs whose hostname is on the external-link allowlist', () => {
    const urls = [
      ...PROVIDER_PRESETS.flatMap((p) => helpUrls(p.help)),
      ...Object.values(PROVIDER_HELP).flatMap(helpUrls),
    ];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      const parsed = new URL(u);
      expect(parsed.protocol, u).toBe('https:');
      expect(EXTERNAL_LINK_ALLOWED_HOSTS, u).toContain(parsed.hostname);
    }
  });

  it('matches the values that used to be hardcoded in SettingsPanel', () => {
    expect(findPresetById('deepseek.text.fast')).toMatchObject({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
    });
    expect(findPresetById('aliyun.cn.asr.fun-realtime')).toMatchObject({
      baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      model: 'fun-asr-realtime',
    });
    expect(findPresetById('mimo.asr.segment')).toMatchObject({
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-asr',
      beta: true,
    });
    expect(findPresetById('gemini.vision.flash')).toMatchObject({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash',
      defaultProxyUrl: '127.0.0.1:7897',
    });
    expect(LOCAL_REALTIME_MODELS.map((m) => m.value)).toEqual([
      'fun-asr-nano',
      'paraformer-zh-streaming',
      'moss-transcribe-diarize',
    ]);
  });

  it('resolves an endpoint pair to its provider, ignoring trailing slashes', () => {
    expect(providerIdForEndpoint('https://api.deepseek.com/v1', 'deepseek-flash')).toBe('deepseek');
    expect(providerIdForEndpoint('https://api.deepseek.com/v1/', 'deepseek-flash')).toBe('deepseek');
    expect(
      providerIdForEndpoint('wss://dashscope.aliyuncs.com/api-ws/v1/inference', 'fun-asr-realtime'),
    ).toBe('aliyun-dashscope-cn');
  });

  it('treats unknown or partially matching endpoints as custom', () => {
    expect(providerIdForEndpoint('https://api.deepseek.com/v1', 'some-other-model')).toBe('custom');
    expect(providerIdForEndpoint('https://relay.example.com/v1', 'deepseek-flash')).toBe('custom');
    expect(providerIdForEndpoint(undefined, 'deepseek-flash')).toBe('custom');
    expect(providerIdForEndpoint('https://api.deepseek.com/v1', undefined)).toBe('custom');
    // no substring matching: a lookalike host must not resolve to DeepSeek
    expect(providerIdForEndpoint('https://evil.example/api.deepseek.com/v1', 'deepseek-flash')).toBe(
      'custom',
    );
  });

  it('can scope endpoint lookup by capability', () => {
    expect(
      findPresetByEndpoint('https://api.xiaomimimo.com/v1', 'mimo-v2.5-asr', 'asr-segment')?.id,
    ).toBe('mimo.asr.segment');
    expect(
      findPresetByEndpoint('https://api.xiaomimimo.com/v1', 'mimo-v2.5-asr', 'text-llm'),
    ).toBeUndefined();
  });

  // The mainland aggregators are the ones most likely to be mis-typed: their
  // model ids carry slashes and dated suffixes, and `providerId` is never
  // stored from the dropdown — it is re-derived from the saved baseUrl+model,
  // so a pair that does not match exactly reads back as 自定义 and the
  // per-provider tutorial silently disappears.
  describe('mainland platform presets round-trip through endpoint lookup', () => {
    const pairs = [
      { id: 'kimi.text.k3', providerId: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
      { id: 'kimi.text.code-fast', providerId: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.7-code-highspeed' },
      { id: 'siliconflow.text.deepseek-v3', providerId: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
      { id: 'siliconflow.text.pro-r1', providerId: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Pro/deepseek-ai/DeepSeek-R1' },
      { id: 'ark.text.doubao-seed', providerId: 'volcengine-ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-pro-260628' },
    ];

    for (const p of pairs) {
      it(`${p.id} resolves back to itself`, () => {
        expect(findPresetByEndpoint(p.baseUrl, p.model, 'text-llm')?.id).toBe(p.id);
        expect(providerIdForEndpoint(p.baseUrl, p.model, 'text-llm')).toBe(p.providerId);
      });
    }

    it('does not resolve a half-typed aggregator id to a preset', () => {
      // the failure mode a user actually hits: dropping the organisation prefix
      expect(
        findPresetByEndpoint('https://api.siliconflow.cn/v1', 'DeepSeek-V3', 'text-llm'),
      ).toBeUndefined();
      expect(
        providerIdForEndpoint('https://api.siliconflow.cn/v1', 'DeepSeek-V3', 'text-llm'),
      ).toBe('custom');
    });

    it('ships no retired Kimi name', () => {
      // moonshot-v1-*, kimi-k2-* and kimi-latest were all retired by 2026-08-31
      const retired = /moonshot-v1|kimi-k2(?:\.5)?-|kimi-k2-thinking|kimi-latest/;
      for (const preset of PROVIDER_PRESETS.filter((p) => p.providerId === 'kimi')) {
        expect(preset.model).not.toMatch(retired);
      }
      expect(PROVIDER_PRESETS.filter((p) => p.providerId === 'kimi').length).toBeGreaterThan(0);
    });

    it('lets Kimi and Ark reuse their text model for screenshots, and never guesses one for SiliconFlow', () => {
      // getVisionConfig falls back to the provider's own vision preset and
      // returns undefined rather than inventing a model name
      expect(findPresetByEndpoint('https://api.moonshot.cn/v1', 'kimi-k3', 'text-llm')?.visionCapable).toBe(true);
      expect(
        findPresetByEndpoint('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro-260628', 'text-llm')?.visionCapable,
      ).toBe(true);
      expect(presetsForCapability('vision').some((p) => p.providerId === 'siliconflow')).toBe(false);
    });
  });
});
