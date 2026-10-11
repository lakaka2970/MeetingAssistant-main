# API key guide

中文版：[API_KEYS.zh-CN.md](API_KEYS.zh-CN.md)

---

## What an API key is

An API key is a credential you create in a model provider's console. It proves the requests are yours.

- **It is not your account password.** MeetingAssistant never asks for one, in any field.
- **It is a billing credential.** Whoever holds it can spend your quota, so keep it out of chats, screenshots and public repos.
- **It is disposable.** If one leaks, delete it in the provider console and create a new one; your account is unaffected.

## Who charges you

MeetingAssistant is **BYOK (bring your own key)**:

- you create the key at the provider, and the provider bills your usage directly;
- MeetingAssistant has no accounts and no server; it collects no fee, takes no cut and adds no markup;
- every "Test connection" button sends one tiny real request (1 token, ~1.4 s of audio, or a 64×64 image), which may cost a very small amount — and only when you click it.

## Where keys are stored

- Saving strips surrounding whitespace, wrapping quotes and a `Bearer ` prefix for you.
- The key is encrypted with the OS credential store before it is written to the local config file: DPAPI on Windows, Keychain on macOS.
- The decrypted key **exists only in the main process**. The UI layer never receives it — it only sees "Configured" and the last 4 characters.
- If the OS credential store is unavailable, the app warns you *before* the key leaves the settings form: it could then only be obfuscated, not encrypted. Fix the system service first if you can.
- To remove a key: "Delete key" next to the field → "Delete it" → "Save".

---

## Per-provider guides

These are the same steps the in-app help center and the setup wizard show.

### DeepSeek (recommended for AI answers)

Used for: AI answers and inline transcript translation. Default model `deepseek-flash` (fastest first token, also reads images).

1. Open the [DeepSeek open platform](https://platform.deepseek.com/).
2. Sign in with your phone number or email; create an account on first use.
3. Go to the "API keys" page in the left sidebar.
4. Click "Create API key" and give it a recognisable name (e.g. MeetingAssistant).
5. Copy the key immediately — it is usually shown in full only once.
6. Come back to MeetingAssistant and paste it into the AI-answers card.
7. Click "Save and test connection". If the balance is insufficient, top up on the platform and retry.

Common problems:

- `Insufficient Balance`: the key is valid, the account just needs a top-up.
- The key is shown once: if you lost it, delete it and create another — the account is unaffected.

Model options: `deepseek-flash` (fast, default, reads images), `deepseek-v4-pro` (strongest reasoning; good for review, not for snap answers).

> DeepSeek accepts only those two names. The older `deepseek-chat` / `deepseek-v4-flash` / `deepseek-v4.1-flash`
> fail with HTTP 400 (`The supported API model names are deepseek-flash, deepseek-v4-pro`); after upgrading, the app
> rewrites a stored old name to `deepseek-flash` for you.

### Kimi · Moonshot

Used for: AI answers. `kimi-k3` also reads screenshots, so the vision slot can reuse the same key. Default model `kimi-k3`.

1. Open the [Kimi platform](https://platform.kimi.com/).
2. Sign in with a phone verification code; account verification is required before API calls work.
3. Go to the [API Keys page](https://platform.moonshot.cn/console/api-keys).
4. Click "Create API Key" and give it a recognisable name (e.g. MeetingAssistant).
5. Copy it immediately — the full key is shown once, afterwards only the tail remains.
6. Come back to MeetingAssistant, paste the key, and keep the default model or set it to `kimi-k3`.
7. Click "Test connection". A 401 usually means a truncated key or an unverified account.

Notes:

- The whole `moonshot-v1` line, the `kimi-k2` line and `kimi-latest` are **retired** and will be rejected; current names are `kimi-k3`, `kimi-k2.6` and `kimi-k2.7-code`.
- If answering live feels slow, `kimi-k2.7-code-highspeed` outputs faster at the cost of depth.

### SiliconFlow

Used for: one key across many vendors (DeepSeek, Qwen, GLM, …). Example model `deepseek-ai/DeepSeek-V3`.

1. Open the [SiliconFlow console](https://cloud.siliconflow.cn/).
2. Register with an email or phone number and complete identity verification.
3. Go to "Account → API Keys" and click "New API Key".
4. Copy the generated key (a long `sk-` string).
5. In the Model Hub, find the model and copy its FULL model ID (e.g. `deepseek-ai/DeepSeek-V3`, including the organisation prefix).
6. Paste the key here and put that model ID in the "Model" field.
7. Click "Test connection"; "model not found" almost always means a missing prefix or a case mismatch.

Notes:

- It is an aggregator: the model name must be the full "organisation/model" form, byte-identical to the Model Hub entry — `DeepSeek-V3` alone will fail.
- Keep the base URL ending in `/v1` — not `/v1/`, and never without the version segment.
- `Pro/deepseek-ai/DeepSeek-R1` thinks before answering: good for review, too slow to answer live.

### Volcano Ark · Doubao

Used for: AI answers (Doubao Seed accepts images). Default model `doubao-seed-2-1-pro-260628`.

1. Open the [Volcano Ark console](https://console.volcengine.com/ark) with a Volcengine account.
2. On first use, activate Ark and accept the model terms.
3. Create an API Key under [API Key Management (Beijing region)](https://ark.volcengine.com/region:cn-beijing/apikey).
4. Copy it right away — the full key is displayed once at creation.
5. Enable the model in the Model Market and note its Model Name (e.g. `doubao-seed-2-1-pro-260628`).
6. Paste the key here and enter that Model Name in the model field.
7. Click "Test connection"; an unenabled model reports a permission error, not an invalid key.

Notes:

- Ark model names carry a dated suffix (`-260628`) and stop resolving once superseded; copy the current Model Name when the API rejects it.
- An `ep-xxxxx` value is also accepted, but that is the id of an inference endpoint you created, not a model name.

### Alibaba Cloud Model Studio · mainland (recommended for live ASR)

Used for: cloud streaming speech recognition with `fun-asr-realtime` (default) or `paraformer-realtime-v2`, endpoint `wss://dashscope.aliyuncs.com/api-ws/v1/inference`.

1. Open the [Model Studio console](https://bailian.console.aliyun.com/?tab=model).
2. Sign in with your Alibaba Cloud account; register first if you have none.
3. Follow the prompt to activate the Model Studio (Bailian) service.
4. Complete real-name verification — accounts without it cannot create a usable API key.
5. Stay in the main account default workspace (sub-accounts or custom workspaces may lack realtime ASR access).
6. Open the "API-KEY" page from the avatar menu in the top-right corner.
7. Click "Create my API-KEY" and confirm with the default workspace selected.
8. Copy the key, come back to MeetingAssistant and paste it into the speech-recognition card.
9. Click "Save and test connection".

Common problems:

- Permission denied / Access denied: usually Model Studio is not activated, or real-name verification is missing.
- "Model not found": usually means the account belongs to the international site, which uses a different endpoint.
- Key missing after creation: switch back to the main account default workspace on the "API-KEY" page.

> **International accounts (Beta)**: the [international Model Studio console](https://modelstudio.console.aliyun.com/?tab=playground) can create keys too, but its realtime ASR endpoint differs from the mainland one and is still being verified, so this release ships no preset for it. Prefer a mainland account for dependable live captions.

### MiMo · Xiaomi (one key for both ASR and answers, Beta)

Used for: `mimo-v2.5-asr` per-segment ASR, `mimo-v2.5-pro` answers and `mimo-v2.5` screenshot Q&A, all on `https://api.xiaomimimo.com/v1`.

1. Open the [MiMo open platform](https://platform.xiaomimimo.com/).
2. Sign in with your Xiaomi account; register first if you have none.
3. Go to the "API Keys" page in the console.
4. Create a new API key and confirm the name.
5. Copy the key (it starts with `sk-`) — it is usually shown in full only once.
6. Come back to MeetingAssistant and paste it into the field.
7. One key can serve both speech recognition and AI answers (the minimal plan); this is still Beta.
8. Click "Save and test connection"; switch to the recommended plan if ASR is unavailable.

> Per-segment recognition returns whole sentences, so captions trail the speaker more than the streaming plan does. That is the design, not a fault.

### Google Gemini (optional, for screenshot Q&A)

Used for: the vision model, `https://generativelanguage.googleapis.com/v1beta/openai`, model `gemini-2.5-flash`. Screenshot Q&A is optional; skipping it does not affect transcription or text answers.

1. Open the [API key page in Google AI Studio](https://aistudio.google.com/app/apikey).
2. Sign in with your Google account.
3. Click "Create API key" and pick or create a Google Cloud project when asked.
4. Copy the key and paste it into the vision key field (Settings → Vision & Search).
5. Google is usually unreachable directly from mainland China — set a local proxy in "Vision proxy" (e.g. `127.0.0.1:7897`).
6. Visual Q&A is optional and can be skipped; the screenshot button then reports it is not configured.

> For a direct connection inside mainland China, use MiMo's vision model `mimo-v2.5` instead and leave the proxy empty.

### Custom (OpenAI-compatible services)

1. Prepare an OpenAI-compatible base URL (ending in `/v1`) and a model name.
2. Fill in the base URL, model and API key under Settings → Advanced.
3. For safety, MeetingAssistant only ever hands the OS browser a URL from its built-in allowlist of official provider pages — visit a custom provider's site yourself.

---

## When the connection test fails

Every key field has a "Test connection" button. It normalises the wildly different provider errors into a fixed set of codes so you can tell a key problem from a network or account problem. The full table and what to do about each code is in [TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md).
