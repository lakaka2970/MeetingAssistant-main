/**
 * Provider catalog: the single source of truth for the BYOK service presets,
 * their official sign-up / API-key pages, and the step-by-step tutorials the
 * onboarding wizard renders inline.
 *
 * Pure data — importable from both the renderer and the main process (no
 * electron, no node). Values are copied verbatim from the presets that used to
 * be hardcoded in `src/components/SettingsPanel.tsx`, so adopting the catalog
 * is a zero-behaviour-change refactor.
 *
 * Rules:
 *  - preset ids are STABLE identifiers persisted in settings (`providerId` is
 *    the coarse provider, the preset id is only a UI selection key);
 *  - never match a provider by URL substring — match the exact baseUrl+model
 *    pair via {@link findPresetByEndpoint};
 *  - every URL here must be https and its hostname must appear in
 *    {@link EXTERNAL_LINK_ALLOWED_HOSTS} (the main process refuses to open
 *    anything else).
 */

// ---------- types ----------

export type ProviderCapability = 'text-llm' | 'vision' | 'asr-realtime' | 'asr-segment';

export type ProviderId =
  | 'deepseek'
  | 'aliyun-dashscope-cn'
  | 'aliyun-dashscope-intl'
  | 'mimo'
  | 'zhipu'
  | 'ollama'
  | 'groq'
  | 'gemini'
  | 'custom';

export type ProviderRegion = 'cn' | 'intl' | 'global';

export interface ProviderHelp {
  /** provider home / console */
  platformUrl?: string;
  /** the page where the user actually creates the key */
  keyUrl?: string;
  /** official documentation */
  docsUrl?: string;
  /** ordered tutorial steps rendered inline in the wizard */
  stepsZh: string[];
  stepsEn: string[];
  /** frequent failures worth pre-empting (optional) */
  faqZh?: string[];
  faqEn?: string[];
  /** e.g. 'sk-' — a HINT only, never a hard validation */
  keyFormatHint?: string;
  billingHintZh?: string;
  billingHintEn?: string;
}

export interface ProviderPreset {
  /** stable id, e.g. 'deepseek.text.fast' */
  id: string;
  providerId: ProviderId;
  capability: ProviderCapability;
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  descriptionEn: string;
  /** OpenAI-compatible base URL, or the wss:// endpoint for realtime ASR */
  baseUrl: string;
  model: string;
  region?: ProviderRegion;
  /** default choice for its capability in the onboarding wizard */
  recommended?: boolean;
  /** unverified / partially supported — the UI must show a Beta tag */
  beta?: boolean;
  /** vision providers that need a local proxy by default (Gemini) */
  defaultProxyUrl?: string;
  help: ProviderHelp;
}

// ---------- external-link allowlist ----------

/**
 * Every hostname the app may hand to the OS browser. Kept here (shared/) so the
 * catalog can be validated against it in a renderer-safe unit test while
 * `electron/externalLinks.ts` enforces it in the main process.
 * Exact hostname matches only — no suffix matching, ever.
 */
export const EXTERNAL_LINK_ALLOWED_HOSTS: readonly string[] = [
  'platform.deepseek.com',
  'api-docs.deepseek.com',
  'bailian.console.aliyun.com',
  'modelstudio.console.aliyun.com',
  'help.aliyun.com',
  'platform.xiaomimimo.com',
  'mimo.mi.com',
  'open.bigmodel.cn',
  'bigmodel.cn',
  'docs.bigmodel.cn',
  'console.groq.com',
  'ollama.com',
  'aistudio.google.com',
  'ai.google.dev',
  'github.com',
  // web-search fallback providers (shared/searchProviders.ts) — key pages only
  'app.tavily.com',
  'api-dashboard.search.brave.com',
  'serpapi.com',
];

// ---------- per-provider help ----------

const deepseekHelp: ProviderHelp = {
  platformUrl: 'https://platform.deepseek.com/',
  keyUrl: 'https://platform.deepseek.com/api_keys',
  docsUrl: 'https://api-docs.deepseek.com/',
  keyFormatHint: 'sk-',
  stepsZh: [
    '打开 DeepSeek 开放平台（platform.deepseek.com）。',
    '使用手机号或邮箱登录；首次使用请先注册账号。',
    '进入左侧的「API keys」页面。',
    '点击「创建 API key」，填写一个便于识别的名称（例如 MeetingAssistant）。',
    '立即复制生成的 Key —— 它通常只完整显示这一次，关闭弹窗后无法再次查看。',
    '回到 MeetingAssistant，把 Key 粘贴到下方输入框。',
    '点击「保存并测试连接」；若提示余额不足，请在平台的充值页面充值后重试。',
  ],
  stepsEn: [
    'Open the DeepSeek open platform (platform.deepseek.com).',
    'Sign in with your phone number or email; create an account on first use.',
    'Go to the "API keys" page in the left sidebar.',
    'Click "Create API key" and give it a recognisable name (e.g. MeetingAssistant).',
    'Copy the key immediately — it is usually shown in full only once.',
    'Come back to MeetingAssistant and paste the key into the field below.',
    'Click "Save and test connection". If the balance is insufficient, top up on the platform and retry.',
  ],
  faqZh: [
    'API Key 不是账号密码，请勿写进聊天记录或截图外传。',
    '提示「Insufficient Balance」时请先在平台充值，Key 本身仍然有效。',
  ],
  faqEn: [
    'An API key is not your account password — never share it in chats or screenshots.',
    'An "Insufficient Balance" error means the account needs a top-up; the key itself is still valid.',
  ],
  billingHintZh: '费用由 DeepSeek 按用量收取，MeetingAssistant 不代收任何费用。',
  billingHintEn: 'DeepSeek bills you by usage. MeetingAssistant never collects any fee.',
};

const aliyunCnHelp: ProviderHelp = {
  platformUrl: 'https://bailian.console.aliyun.com/?tab=model',
  keyUrl: 'https://bailian.console.aliyun.com/?tab=model',
  docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
  stepsZh: [
    '打开阿里云百炼控制台（bailian.console.aliyun.com）。',
    '使用阿里云账号登录；首次使用请先注册。',
    '按页面提示开通「百炼」大模型服务平台。',
    '完成实名认证，未实名的账号无法创建可用的 API Key。',
    '确认当前停留在主账号的默认业务空间（子账号或自建业务空间可能没有实时语音识别权限）。',
    '打开右上角头像菜单中的「API-KEY」页面。',
    '点击「创建我的 API-KEY」，业务空间选择默认业务空间后确认。',
    '复制生成的 Key，回到 MeetingAssistant 粘贴到下方输入框。',
    '点击「保存并测试连接」。',
  ],
  stepsEn: [
    'Open the Alibaba Cloud Model Studio console (bailian.console.aliyun.com).',
    'Sign in with your Alibaba Cloud account; register first if you have none.',
    'Follow the prompt to activate the Model Studio (Bailian) service.',
    'Complete real-name verification — accounts without it cannot create a usable API key.',
    'Stay in the main account default workspace (sub-accounts or custom workspaces may lack realtime ASR access).',
    'Open the "API-KEY" page from the avatar menu in the top-right corner.',
    'Click "Create my API-KEY" and confirm with the default workspace selected.',
    'Copy the key, come back to MeetingAssistant and paste it into the field below.',
    'Click "Save and test connection".',
  ],
  faqZh: [
    '提示权限不足或 Access denied：多为尚未开通百炼或未完成实名认证。',
    '提示 Model not found：请确认账号属于中国大陆站，国际站账号的接入地址不同。',
    '创建后找不到 Key：请在「API-KEY」页面切换回主账号的默认业务空间查看。',
  ],
  faqEn: [
    'Permission denied / Access denied usually means Model Studio is not activated or real-name verification is missing.',
    '"Model not found" usually means the account belongs to the international site, which uses a different endpoint.',
    'If the key is missing after creation, switch back to the main account default workspace on the "API-KEY" page.',
  ],
  billingHintZh: '费用由阿里云按用量收取，MeetingAssistant 不代收任何费用。',
  billingHintEn: 'Alibaba Cloud bills you by usage. MeetingAssistant never collects any fee.',
};

/**
 * International Model Studio. No preset ships in Phase 2: its realtime ASR
 * WebSocket endpoint is unverified and the CN endpoint must stay the default.
 * The help entry exists so the wizard can still point INTL users at the right
 * console.
 */
const aliyunIntlHelp: ProviderHelp = {
  platformUrl: 'https://modelstudio.console.aliyun.com/?tab=playground',
  keyUrl: 'https://modelstudio.console.aliyun.com/?tab=playground',
  docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
  stepsZh: [
    '打开阿里云国际站 Model Studio 控制台（modelstudio.console.aliyun.com）。',
    '使用阿里云国际站账号登录并开通 Model Studio。',
    '在控制台的 API-KEY 页面创建一个 API Key 并复制。',
    '国际站的实时语音识别接入地址与中国大陆站不同，目前仍在验证中（Beta）。',
    '如需稳定的实时字幕，建议先使用中国大陆站账号。',
  ],
  stepsEn: [
    'Open the international Model Studio console (modelstudio.console.aliyun.com).',
    'Sign in with an Alibaba Cloud international account and activate Model Studio.',
    'Create an API key on the API-KEY page and copy it.',
    'The international realtime ASR endpoint differs from the mainland one and is still being verified (Beta).',
    'For dependable live captions, prefer a mainland (cn) account for now.',
  ],
  billingHintZh: '费用由阿里云国际站按用量收取，MeetingAssistant 不代收任何费用。',
  billingHintEn: 'Alibaba Cloud International bills you by usage. MeetingAssistant never collects any fee.',
};

const mimoHelp: ProviderHelp = {
  platformUrl: 'https://platform.xiaomimimo.com/',
  keyUrl: 'https://platform.xiaomimimo.com/console/api-keys',
  docsUrl: 'https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call',
  keyFormatHint: 'sk-',
  stepsZh: [
    '打开 MiMo 开放平台（platform.xiaomimimo.com）。',
    '使用小米账号登录；首次使用请先完成注册。',
    '进入控制台的「API Keys」页面。',
    '点击新建 API Key，填写名称后确认。',
    '复制以 sk- 开头的 Key —— 它通常只完整显示这一次。',
    '回到 MeetingAssistant，把 Key 粘贴到下方输入框。',
    '同一个 Key 可以同时用于语音识别与 AI 回答（极简配置方案）；该用法仍处于 Beta。',
    '点击「保存并测试连接」；若语音识别不可用，请改用推荐方案。',
  ],
  stepsEn: [
    'Open the MiMo open platform (platform.xiaomimimo.com).',
    'Sign in with your Xiaomi account; register first if you have none.',
    'Go to the "API Keys" page in the console.',
    'Create a new API key and confirm the name.',
    'Copy the key (it starts with sk-) — it is usually shown in full only once.',
    'Come back to MeetingAssistant and paste the key into the field below.',
    'One key can serve both speech recognition and AI answers (the minimal plan); this is still Beta.',
    'Click "Save and test connection"; switch to the recommended plan if ASR is unavailable.',
  ],
  faqZh: ['英文文档见 mimo.mi.com 的 en-US 快速开始页面。'],
  faqEn: ['The Chinese quick-start page lives under zh-CN on mimo.mi.com.'],
  billingHintZh: '费用由 MiMo 平台按用量收取，MeetingAssistant 不代收任何费用。',
  billingHintEn: 'The MiMo platform bills you by usage. MeetingAssistant never collects any fee.',
};

const geminiHelp: ProviderHelp = {
  platformUrl: 'https://aistudio.google.com/app/apikey',
  keyUrl: 'https://aistudio.google.com/app/apikey',
  docsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
  stepsZh: [
    '打开 Google AI Studio 的 API Key 页面（aistudio.google.com）。',
    '使用 Google 账号登录。',
    '点击 Create API key，按提示选择或新建一个 Google Cloud 项目。',
    '复制生成的 Key，回到 MeetingAssistant 粘贴到下方输入框。',
    '中国大陆网络通常无法直连 Google，请在高级设置中填写本机代理地址（例如 127.0.0.1:7897）。',
    '视觉问答是可选功能，可以跳过；跳过后截图提问会提示尚未配置。',
  ],
  stepsEn: [
    'Open the API key page in Google AI Studio (aistudio.google.com).',
    'Sign in with your Google account.',
    'Click "Create API key" and pick or create a Google Cloud project when asked.',
    'Copy the key, come back to MeetingAssistant and paste it into the field below.',
    'Google is usually unreachable directly from mainland China — set a local proxy (e.g. 127.0.0.1:7897) in advanced settings.',
    'Visual Q&A is optional and can be skipped; the screenshot button then reports it is not configured.',
  ],
  billingHintZh: '费用由 Google 按用量收取，MeetingAssistant 不代收任何费用。',
  billingHintEn: 'Google bills you by usage. MeetingAssistant never collects any fee.',
};

const customHelp: ProviderHelp = {
  docsUrl: 'https://github.com/lakaka2970/MeetingAssistant-main',
  stepsZh: [
    '准备一个 OpenAI 兼容的服务地址（以 /v1 结尾）与模型名称。',
    '在高级设置中填写 Base URL、模型与 API Key。',
    '自定义服务商的官方页面不会由 MeetingAssistant 代为打开，请自行访问。',
  ],
  stepsEn: [
    'Prepare an OpenAI-compatible base URL (ending in /v1) and a model name.',
    'Fill in the base URL, model and API key under advanced settings.',
    'MeetingAssistant never opens a custom provider page for you — visit it yourself.',
  ],
  billingHintZh: '费用由你选择的服务商收取，MeetingAssistant 不代收任何费用。',
  billingHintEn: 'Your chosen provider bills you. MeetingAssistant never collects any fee.',
};

const zhipuHelp: ProviderHelp = {
  platformUrl: 'https://open.bigmodel.cn/',
  keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/overview',
  keyFormatHint: 'id.',
  stepsZh: [
    '打开智谱开放平台（bigmodel.cn / open.bigmodel.cn）。',
    '使用手机号登录；首次使用请先注册并完成实名。',
    '进入右上角头像菜单的「API 密钥」管理页。',
    '点击「新建 API Key」，填写名称后确认。',
    '复制生成的 Key —— 它通常只完整显示这一次。',
    '回到 MeetingAssistant，把 Key 粘贴到下方输入框。',
    'GLM-4-Flash 档位免费额度充足，适合作为低延迟快速档。',
    '点击「保存并测试连接」。',
  ],
  stepsEn: [
    'Open the Zhipu (Z.ai) open platform (bigmodel.cn / open.bigmodel.cn).',
    'Sign in with your phone number; register and complete verification on first use.',
    'Open the "API Keys" page from the avatar menu.',
    'Click "Create API Key" and confirm a name.',
    'Copy the key — it is usually shown in full only once.',
    'Come back to MeetingAssistant and paste the key into the field below.',
    'The GLM-4-Flash tier is free/very cheap — a good low-latency fast lane.',
    'Click "Save and test connection".',
  ],
  faqZh: [
    '智谱的 Key 以「id.」开头、形如 id.secret，请整段复制。',
    '国内直连稳定，无需配置代理。',
  ],
  faqEn: [
    'A Zhipu key looks like "id.secret" — copy the whole string.',
    'Reachable directly from mainland China; no proxy needed.',
  ],
  billingHintZh: '费用由智谱按用量收取（GLM-4-Flash 免费档），MeetingAssistant 不代收任何费用。',
  billingHintEn: 'Zhipu bills you by usage (GLM-4-Flash is free). MeetingAssistant never collects any fee.',
};

const qwenHelp: ProviderHelp = {
  platformUrl: 'https://bailian.console.aliyun.com/?tab=model',
  keyUrl: 'https://bailian.console.aliyun.com/?tab=model',
  docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
  stepsZh: [
    '打开阿里云百炼控制台（bailian.console.aliyun.com）。',
    '使用阿里云账号登录并开通百炼服务，完成实名认证。',
    '在「API-KEY」页面创建并复制一个 API Key（与语音识别同账号可用）。',
    '回到 MeetingAssistant，把 Key 粘贴到下方输入框。',
    '通义文本模型走 OpenAI 兼容接口（compatible-mode），国内直连。',
    '点击「保存并测试连接」。',
  ],
  stepsEn: [
    'Open the Alibaba Cloud Model Studio console (bailian.console.aliyun.com).',
    'Sign in, activate Model Studio and complete real-name verification.',
    'Create and copy an API key on the "API-KEY" page (shared with ASR on the same account).',
    'Come back to MeetingAssistant and paste the key into the field below.',
    'Qwen text models use the OpenAI-compatible endpoint (compatible-mode), direct from mainland China.',
    'Click "Save and test connection".',
  ],
  billingHintZh: '费用由阿里云按用量收取，MeetingAssistant 不代收任何费用。',
  billingHintEn: 'Alibaba Cloud bills you by usage. MeetingAssistant never collects any fee.',
};

const ollamaHelp: ProviderHelp = {
  platformUrl: 'https://ollama.com/',
  docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
  stepsZh: [
    '在本机安装并启动 Ollama（ollama.com 下载；默认监听 127.0.0.1:11434）。',
    '拉取一个模型，例如命令行执行：ollama pull qwen2.5:7b。',
    'Base URL 填 http://127.0.0.1:11434/v1，模型名与所拉取的模型一致。',
    '本地推理不需要 API Key，「API Key」留空即可。',
    '速度取决于本机硬件；优势是回答完全不经过网络。',
  ],
  stepsEn: [
    'Install and start Ollama locally (download at ollama.com; listens on 127.0.0.1:11434).',
    'Pull a model, e.g. run: ollama pull qwen2.5:7b.',
    'Set the base URL to http://127.0.0.1:11434/v1 and the model to what you pulled.',
    'Local inference needs no API key — leave "API Key" empty.',
    'Speed depends on your hardware; the upside is answers that never leave the machine.',
  ],
  faqZh: ['若测试连接失败，请确认 Ollama 正在运行：OLLAMA_HOST 默认仅监听本机回环。'],
  faqEn: ['If the test fails, make sure Ollama is running; OLLAMA_HOST defaults to loopback only.'],
  billingHintZh: '本地运行不产生任何 API 费用。',
  billingHintEn: 'Runs locally — no API cost at all.',
};

const groqHelp: ProviderHelp = {
  platformUrl: 'https://console.groq.com/',
  keyUrl: 'https://console.groq.com/keys',
  docsUrl: 'https://console.groq.com/docs/openai',
  keyFormatHint: 'gsk_',
  stepsZh: [
    '打开 Groq 控制台（console.groq.com）。',
    '注册/登录后进入「API Keys」页面创建并复制 Key。',
    'Groq 服务器在海外，中国大陆网络通常需要本机代理；如需走代理请先在视觉设置中配置代理地址并在系统层生效。',
    '免费档速率有限制，适合作为英文编码题的极速档。',
    '点击「保存并测试连接」。',
  ],
  stepsEn: [
    'Open the Groq console (console.groq.com).',
    'Sign up / sign in and create an API key on the "API Keys" page.',
    'Groq runs overseas; mainland-China networks usually need a local proxy for direct API access.',
    'The free tier is rate-limited — best as a fast lane for English coding questions.',
    'Click "Save and test connection".',
  ],
  billingHintZh: '费用由 Groq 按用量收取（有免费档），MeetingAssistant 不代收任何费用。',
  billingHintEn: 'Groq bills you by usage (free tier available). MeetingAssistant never collects any fee.',
};

/** help metadata by provider — exported so the UI can show INTL guidance
 * even though no INTL preset ships yet. */
export const PROVIDER_HELP: Record<ProviderId, ProviderHelp> = {
  deepseek: deepseekHelp,
  'aliyun-dashscope-cn': aliyunCnHelp,
  'aliyun-dashscope-intl': aliyunIntlHelp,
  mimo: mimoHelp,
  zhipu: zhipuHelp,
  ollama: ollamaHelp,
  groq: groqHelp,
  gemini: geminiHelp,
  custom: customHelp,
};

// ---------- presets ----------

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ---- text LLM ----
  {
    id: 'deepseek.text.fast',
    providerId: 'deepseek',
    capability: 'text-llm',
    nameZh: 'DeepSeek 快速·非思考 (deepseek-chat)',
    nameEn: 'DeepSeek fast · non-thinking (deepseek-chat)',
    descriptionZh: '首个字最快，适合实时会议问答，默认选择。',
    descriptionEn: 'Fastest first token; the default for live meeting answers.',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    region: 'cn',
    recommended: true,
    help: deepseekHelp,
  },
  {
    id: 'deepseek.text.thinking',
    providerId: 'deepseek',
    capability: 'text-llm',
    nameZh: 'DeepSeek 思考·v4-flash',
    nameEn: 'DeepSeek thinking · v4-flash',
    descriptionZh: '带推理链，回答更完整，但首字更慢。',
    descriptionEn: 'Reasoning chain first — richer answers, slower first token.',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    region: 'cn',
    help: deepseekHelp,
  },
  {
    id: 'deepseek.text.deep',
    providerId: 'deepseek',
    capability: 'text-llm',
    nameZh: 'DeepSeek 深度·v4-pro',
    nameEn: 'DeepSeek deep · v4-pro',
    descriptionZh: '最强推理，适合复盘与深度问题，不适合抢答。',
    descriptionEn: 'Strongest reasoning; good for review, not for snap answers.',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
    region: 'cn',
    help: deepseekHelp,
  },
  {
    id: 'mimo.text.fast',
    providerId: 'mimo',
    capability: 'text-llm',
    nameZh: 'MiMo 快速 (mimo-v2.5-pro)',
    nameEn: 'MiMo fast (mimo-v2.5-pro)',
    descriptionZh: '与 MiMo 语音识别共用一个平台账号，适合极简配置。',
    descriptionEn: 'Shares one platform account with MiMo ASR — the minimal plan.',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    region: 'cn',
    help: mimoHelp,
  },
  {
    id: 'zhipu.text.flash',
    providerId: 'zhipu',
    capability: 'text-llm',
    nameZh: '智谱 GLM-4-Flash（免费·低延迟）',
    nameEn: 'Zhipu GLM-4-Flash (free · low latency)',
    descriptionZh: '国内直连、首字最快档之一，免费额度充足；适合低延迟兜底或编码题快速档。',
    descriptionEn: 'Direct from mainland China with a very fast first token and a free tier; a good low-latency fallback or coding fast lane.',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    region: 'cn',
    help: zhipuHelp,
  },
  {
    id: 'zhipu.text.glm46',
    providerId: 'zhipu',
    capability: 'text-llm',
    nameZh: '智谱 GLM-4.6（质量档）',
    nameEn: 'Zhipu GLM-4.6 (quality)',
    descriptionZh: '中文质量更强的智谱旗舰档，适合行为面与复杂问答；同一账号与 Key。',
    descriptionEn: 'Zhipu flagship with stronger Chinese quality — good for behavioral and complex Q&A; same account and key.',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    region: 'cn',
    help: zhipuHelp,
  },
  {
    id: 'qwen.text.plus',
    providerId: 'aliyun-dashscope-cn',
    capability: 'text-llm',
    nameZh: '通义 qwen-plus（百炼）',
    nameEn: 'Qwen qwen-plus (Model Studio)',
    descriptionZh: '阿里云百炼 OpenAI 兼容接口，与实时语音识别共用账号与 Key。',
    descriptionEn: 'Alibaba Model Studio OpenAI-compatible endpoint; shares the account and key with realtime ASR.',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    region: 'cn',
    help: qwenHelp,
  },
  {
    id: 'qwen.text.72b',
    providerId: 'aliyun-dashscope-cn',
    capability: 'text-llm',
    nameZh: '通义 Qwen2.5-72B（复杂推理）',
    nameEn: 'Qwen2.5-72B (complex reasoning)',
    descriptionZh: '72B 旗舰开源档，复杂推理更强；速度慢于 qwen-plus。',
    descriptionEn: 'The 72B flagship open-weight tier with stronger reasoning; slower than qwen-plus.',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen2.5-72b-instruct',
    region: 'cn',
    help: qwenHelp,
  },
  {
    id: 'ollama.text.local',
    providerId: 'ollama',
    capability: 'text-llm',
    nameZh: 'Ollama 本地（零外传）',
    nameEn: 'Ollama local (zero egress)',
    descriptionZh: '本机推理，回答完全不经过网络；无需 API Key，速度取决于硬件。',
    descriptionEn: 'On-device inference — answers never leave the machine; no API key, speed depends on hardware.',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    region: 'global',
    beta: true,
    help: ollamaHelp,
  },
  {
    id: 'groq.text.llama33',
    providerId: 'groq',
    capability: 'text-llm',
    nameZh: 'Groq Llama 3.3（海外·极速）',
    nameEn: 'Groq Llama 3.3 (overseas · fastest)',
    descriptionZh: '推理速度最快的云端档之一，适合英文编码题；国内网络通常需要代理。',
    descriptionEn: 'One of the fastest cloud lanes — great for English coding questions; mainland networks usually need a proxy.',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    region: 'intl',
    beta: true,
    help: groqHelp,
  },
  // ---- realtime (streaming) ASR ----
  {
    id: 'aliyun.cn.asr.fun-realtime',
    providerId: 'aliyun-dashscope-cn',
    capability: 'asr-realtime',
    nameZh: '阿里云 fun-asr-realtime（中英双优，逐字丝滑）',
    nameEn: 'Aliyun fun-asr-realtime (great zh+en, word-by-word)',
    descriptionZh: '实时性最好的云端流式识别，中英混说也稳定，默认选择。',
    descriptionEn: 'Lowest-latency cloud streaming ASR, stable on mixed zh/en; the default.',
    baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    model: 'fun-asr-realtime',
    region: 'cn',
    recommended: true,
    help: aliyunCnHelp,
  },
  {
    id: 'aliyun.cn.asr.paraformer-realtime-v2',
    providerId: 'aliyun-dashscope-cn',
    capability: 'asr-realtime',
    nameZh: '阿里云 paraformer-realtime-v2',
    nameEn: 'Aliyun paraformer-realtime-v2',
    descriptionZh: '同一账号下的备选流式模型，中文场景更保守。',
    descriptionEn: 'Alternative streaming model on the same account; more conservative on Chinese.',
    baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    model: 'paraformer-realtime-v2',
    region: 'cn',
    help: aliyunCnHelp,
  },
  // ---- segment (non-streaming) ASR ----
  {
    id: 'mimo.asr.segment',
    providerId: 'mimo',
    capability: 'asr-segment',
    nameZh: 'MiMo 分段语音识别 (mimo-v2.5-asr)',
    nameEn: 'MiMo segment ASR (mimo-v2.5-asr)',
    descriptionZh: '按句返回，跟随性弱于实时模式；可与 MiMo 文本模型共用一个 Key（Beta）。',
    descriptionEn: 'Returns whole sentences; less responsive than streaming. Can share one key with the MiMo text model (Beta).',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-asr',
    region: 'cn',
    beta: true,
    help: mimoHelp,
  },
  // ---- vision ----
  {
    id: 'mimo.vision',
    providerId: 'mimo',
    capability: 'vision',
    nameZh: 'MiMo',
    nameEn: 'MiMo',
    descriptionZh: '截图提问的多模态模型，国内直连。',
    descriptionEn: 'Multimodal model for screenshot Q&A, reachable from mainland China.',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5',
    region: 'cn',
    defaultProxyUrl: '',
    help: mimoHelp,
  },
  {
    id: 'gemini.vision.flash',
    providerId: 'gemini',
    capability: 'vision',
    nameZh: 'Gemini',
    nameEn: 'Gemini',
    descriptionZh: '图像理解更强，中国大陆通常需要本机代理。',
    descriptionEn: 'Stronger image understanding; usually needs a local proxy in mainland China.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    region: 'global',
    defaultProxyUrl: '127.0.0.1:7897',
    help: geminiHelp,
  },
  // ---- escape hatch ----
  {
    id: 'custom.openai.text',
    providerId: 'custom',
    capability: 'text-llm',
    nameZh: '自定义（OpenAI 兼容）',
    nameEn: 'Custom (OpenAI-compatible)',
    descriptionZh: '手动填写 Base URL 与模型名，适合自建或第三方中转服务。',
    descriptionEn: 'Enter the base URL and model yourself — self-hosted or third-party relays.',
    baseUrl: '',
    model: '',
    help: customHelp,
  },
];

/**
 * Local streaming ASR models (backend 'local-realtime'). Not cloud providers —
 * the endpoint is a fixed localhost sidecar — but kept next to the catalog so
 * the settings UI has one place to read every selectable model from.
 * Labels copied verbatim from the previous SettingsPanel constant.
 */
export const LOCAL_REALTIME_MODELS: readonly { value: string; nameZh: string; nameEn: string }[] = [
  {
    value: 'fun-asr-nano',
    nameZh: 'Fun-ASR-Nano（中英+标点，推荐）',
    nameEn: 'Fun-ASR-Nano (zh+en, punctuation; recommended)',
  },
  {
    value: 'paraformer-zh-streaming',
    nameZh: 'paraformer 流式（纯中文，字幕更跟手）',
    nameEn: 'paraformer streaming (Chinese-only, snappier captions)',
  },
  {
    value: 'moss-transcribe-diarize',
    nameZh: 'MOSS-Transcribe 0.9B（实验·整句·GPU 优先）',
    nameEn: 'MOSS-Transcribe 0.9B (experimental, per-utterance, GPU-first)',
  },
];

// ---------- lookups ----------

export function presetsForCapability(capability: ProviderCapability): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((p) => p.capability === capability);
}

export function findPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * Exact baseUrl+model match (trailing slashes and case on the URL are
 * normalised; the model is compared verbatim). Deliberately NOT a substring or
 * hostname match — `https://evil.example/api.deepseek.com/v1` must not resolve
 * to DeepSeek.
 */
export function findPresetByEndpoint(
  baseUrl: string | undefined,
  model: string | undefined,
  capability?: ProviderCapability,
): ProviderPreset | undefined {
  if (!baseUrl || !model) return undefined;
  const url = normalizeBaseUrl(baseUrl);
  return PROVIDER_PRESETS.find(
    (p) =>
      (capability === undefined || p.capability === capability) &&
      p.baseUrl !== '' &&
      normalizeBaseUrl(p.baseUrl) === url &&
      p.model === model,
  );
}

/** provider behind a stored baseUrl+model pair; unknown pairs are 'custom'. */
export function providerIdForEndpoint(
  baseUrl: string | undefined,
  model: string | undefined,
  capability?: ProviderCapability,
): ProviderId {
  return findPresetByEndpoint(baseUrl, model, capability)?.providerId ?? 'custom';
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}
