# MeetingAssistant v1.0.1

补丁版本 · A patch release for the teleprompter itself

> ⚠️ 安装包**未做代码签名**，Windows 会弹安全提醒；请只从本项目的 Releases 页面下载。
> ⚠️ The installers are **not code-signed**, so Windows will warn you. Download only from this project's Releases page.

---

## 中文

### 下载哪个

| 文件 | 类型 | 适合 |
|---|---|---|
| `MeetingAssistant-1.0.1-win-x64.exe` | 安装版（NSIS，当前用户，无需管理员） | 常规使用。从 v1.0.0 直接覆盖安装即可，设置与会话数据不会被删除 |
| `MeetingAssistant-1.0.1-win-x64-portable.exe` | 免安装版 | 不想安装、临时使用。首次启动需解压，比安装版慢几秒 |

两者功能完全一致，共用 `%APPDATA%\MeetingAssistant\`。需要数据随身携带时，启动前设置 `MC_USERDATA` 指向自己的目录。
macOS 本次**仍然没有**安装包，可从源码运行，见 [INSTALL_MACOS.en.md](INSTALL_MACOS.en.md)。

### 校验下载（SHA256）

每个 `.exe` 旁边都有同名的 `.exe.sha256`，内容是 CI 构建时算出的哈希。下载后在 PowerShell 里执行：

```powershell
Get-FileHash .\MeetingAssistant-1.0.1-win-x64.exe -Algorithm SHA256
```

把输出与 `.sha256` 文件里的值比对，一致再运行。

### 升级必读：三个默认行为变了

1. **回答默认不再请求「思考」**。v1.0.0 的默认值是"跟随服务商默认"，于是支持思考模式的模型（DeepSeek 思考版、百炼 Qwen3 等）常常在**你没要求的情况下开着思考**——首字延迟和 token 都在为你看不到的推理过程付费。现在默认值是 **关闭**，从旧版本升级上来的机器也一样（老 `settings.json` 里没有这个字段，读取时按「关闭」补齐）。想要思考回答：设置 → 模型 → **思考强度** → 低 / 中 / 高（该下拉框只对支持思考模式的模型出现）。选「跟随默认」则完全不向服务商发送思考参数。
2. **重复导入同一个知识文件会被跳过**。先按 mtime + 大小做廉价判断，再按正文哈希确认，内容没变就**不解析、不重新嵌入、不动索引**，导入结果里显示为「未变化」。再点一次「导入文件」不再是全量重建。
3. **手机远程控制默认开启**。手机上出现控制区不是你配置出来的——它默认就开着。判断依据是：能连上的设备刚刚被你自己拿在手里、并输入过那颗**只在电脑上显示**的 6 位配对码。不想开：设置 → 通用 → 手机显示 → 取消勾选 **允许手机远程控制**，手机上的控制区整体消失；只想开一部分：下面六个逐项开关（未授权的那项会**从手机页面上移除**，而不是变灰）。

### 这个版本新增了什么

**主界面（会议中真的能用的形状）**

- 转录导轨改成**聊天气泡**：每句一个泡泡、说话人分色、整句在泡内换行。**⧉ 复制 / 译 / ⚡答** 三个按钮在鼠标悬停（或键盘 Tab 聚焦）到那句时才出现，不再常驻占宽度。
- **点泡泡不再弹出整屏转录面板**。面板改由导轨右上角的 **⤢** 打开（框选提问、清屏仍然在那里），点 ✕ 回到导轨；导轨右缘细条拖拽调宽（10%–50%，重启保留）照旧。
- 提词卡的**历史回答可折叠**：一行「历史回答 · N」，▸ 展开、▾ 收起，**默认收起**，把纵向空间留给当前回答；展开与否会记住，重启保留。

**提示词引擎（对远程模型的输出做优化与匹配）**

- 标题栏新增 **🎚 回答风格**：**内容量**（精简 / 标准 / 详尽）× **专业度**（口语 / 职场 / 技术）× **应答人设**，**会议中随时改，下一条回答就生效**。每档都写明念完要多久（精简约 15-25 秒 / 标准约 30-60 秒 / 详尽约 90-150 秒）。默认「标准 + 职场」，输出长度与 v1.0.0 一致。
- **应答人设库**（设置 → 通用 → 高级设置 → 应答人设库）：提前写好最多 12 套「我是谁、我怎么说话」，会前用 🎚 选一套启用。也可以点 **从简历/JD 生成初稿**，让模型按你导入的资料起草一套人设（约 10-30 秒），**草稿填进输入框、你改完点保存才生效**。启用的人设只影响口吻、立场与详略，不会替你编造简历里没有的经历。
- **提示词进阶**（同一入口）：直接编辑系统提示词的三层——基础人设模板 / 回答风格指令 / 自定义追加指令。输入框里的**灰字就是内置原文，留空即用内置**；下方有**最终拼接预览**，告诉你这一次真正发给模型的前缀是多少字。每层都能单独「恢复默认」。
- 这些改动都落在**可缓存的稳定前缀**上：装完新版本什么都不设置时，发给模型的提示词与 v1.0.0 **逐字节相同**（有测试钉住这一点），升级本身不会改变既有回答风格。

**知识库与资料导入**

- 简历、岗位JD 与知识目录都接受 **`.md/.txt/.docx/.pdf/.pptx`**（PPT 新增支持）。`.doc/.ppt/.xls` 那类 97-2003 老格式仍不支持——没有可靠的纯 JS 解析器，导入时会明确提示先转成 `.docx/.pptx`，而不是把乱码写进索引。
- **单文件（可多选）导入**：设置 → 知识库 里除了原有的 **导入文件夹…**，新增 **导入文件…**（一次选一个或几个），一份 PDF 不必再为它专门建目录。
- **逐文件进度与失败原因**：导入过程按文件实时上报（`导入中 12/37…`），每个文件一行结果——已入库 / 未变化 / 已跳过 / 失败，并给出原因：**格式不支持**、**抽不出文字**（扫描版或图片型 PDF）、**解析失败**（悬停看原始错误）、**索引未就绪，未写入**。不再出现"点了导入之后界面像冻住"。
- **导入后自动做本地节摘要**：每份入库文档会被切成节（PPTX 按幻灯片、带标题的按标题层级、其余按长度分组），每节存一条短摘要进索引，用来回答"这套方案的评测方法是什么"这类**跨节、文档级**的问题。每篇最多 40 节、单次检索最多带 2 条摘要，避免摘要挤掉原文。这一步**全在本机完成、不调用模型、不产生任何费用**，摘要是抽取式的（标题路径 + 该节第一句），只做定位不做改写。
- PPTX 抽取现在包含**演讲备注与表格**并按幻灯片分节——写在讲者备注里的答案能被检索到。
- 修好一条旧通道的真 bug：把文件按纯文本读进「个人知识库」（`knowledge.md`）的那条导入通道，**选 PDF 会把二进制当文本存进索引**。现在它与其他导入共用同一个确定性解析器，抽不出文字时不会覆盖已有资料。（当前界面里没有指向它的按钮，普通用户不会碰到；修它是为了让旧数据不再被写坏。）
- 大目录导入更快：索引落盘从"每条记录写一次磁盘"改为防抖批量写，整批只写一次。

**双屏：在手机上实时改设置**

- 手机页面顶部新增 **控制** 栏，展开后正好六件事：远程 **开始 / 停止转录**、**持续答** 开关、切换 **回答内容量** 与 **专业度**、**输入问题**（纯文本，单条最多 500 字）、回看本次会议 **历史回答**（最新 60 条，点一条看全文）。
- **颜色就是电脑上的真实状态**：转录中=红、持续答开=绿，与桌面用的语义色一致。**点了不等于生效**——1.5 秒内没等到桌面回状态，那一项会标 **「未确认」**；连点会提示「操作太快，请稍候」（每秒最多 5 条命令）。
- 电脑侧**不会为远程操作弹任何提示**（设计如此：双屏时电脑已经隐身），是否生效只看手机。
- 手机能碰到的只有上面这几项。**改不了 Key、模型、会话，也拿不到你的简历或 JD 文本**；转录与持续答远程开关动的就是电脑上的那两个真实开关。

### 已知问题

- **安装包未签名 / 无自动更新 / 本地转写需自备 Python / macOS 无安装包 / 阿里云国际站为 Beta / MiMo 极简方案为 Beta / macOS 隐身尽力而为 / 手机显示用自签证书 / 读题依赖本地 OCR 或视觉模型**：与 v1.0.0 相同，逐条说明见 [RELEASE_NOTES_v1.0.0.md](RELEASE_NOTES_v1.0.0.md)。
- **手机上的授权只在连接那一刻读取一次**：在电脑上取消勾选某项之后，**已经连着**的手机页面仍会显示那个按钮，点了会被拒绝并给出文字原因；要立刻让按钮消失，重开一次手机页面（或关掉双屏再开）。
- **思考强度不能在手机上远程切换**：本版本手机只开放内容量与专业度两档，思考强度仍在电脑的 设置 → 模型。
- **手机端不能截屏提问，也不能切换会话**：文本提问是手机端唯一的主动提问方式；整屏截屏仍在电脑上按热键（可配成「只送手机」）。
- 节摘要是**抽取式定位**，不是模型总结：它帮你找到那一节，不会替你归纳一份 PPT 的结论。
- **扫描版 / 纯图片 PDF 抽不出文字**，会被跳过并标注原因（本版本不含 OCR）。
- README 首页的两张主界面截图仍是 v1.0.0 的界面（气泡导轨、折叠的历史回答、🎚 按钮都没有反映），需要重拍。

遇到问题：先看应用内「帮助与教程」和 [TROUBLESHOOTING.zh-CN.md](TROUBLESHOOTING.zh-CN.md)（双屏连不上在第九、十节），仍未解决就带上诊断信息到 [GitHub Issues](https://github.com/lakaka2970/MeetingAssistant-main/issues)。

---

## English

### Which file to download

| File | Type | Best for |
|---|---|---|
| `MeetingAssistant-1.0.1-win-x64.exe` | Installer (NSIS, per-user, no admin) | Normal use. Install straight over v1.0.0 — settings and sessions are kept |
| `MeetingAssistant-1.0.1-win-x64-portable.exe` | Portable | Not installing anything. Unpacks itself at launch, so the first start is a few seconds slower |

Both are functionally identical and share `%APPDATA%\MeetingAssistant\`. For a travelling profile, set `MC_USERDATA` to your own folder before launching.
There is still **no macOS build**; run from source — see [INSTALL_MACOS.en.md](INSTALL_MACOS.en.md).

### Verify your download (SHA256)

Every `.exe` ships with a matching `.exe.sha256` containing the hash CI computed at build time. After downloading, run in PowerShell:

```powershell
Get-FileHash .\MeetingAssistant-1.0.1-win-x64.exe -Algorithm SHA256
```

Compare it with the value in the `.sha256` file before running the installer.

### Read this first: three defaults changed

1. **Answers no longer ask for "thinking" by default.** v1.0.0 left the switch to the provider, so thinking-capable models (DeepSeek's thinking tier, Qwen3 on DashScope, …) often reasoned **without being asked** — you paid in first-token latency and tokens for reasoning you never saw. The default is now **off**, including on upgraded machines (an old `settings.json` has no such field, and it loads as off). Want it: Settings → Model → **Thinking effort** → low / medium / high (the control only appears for models that expose a thinking mode). "Follow default" sends no thinking parameter at all.
2. **Re-importing an unchanged file is skipped.** A cheap mtime + size check first, then a content hash; if nothing changed the file is not parsed, not re-embedded and the index is not touched — the result list says "unchanged". Pressing "Import files" again is no longer a full rebuild.
3. **Remote control from the phone is on by default.** The control bar appearing on your phone is not something you configured — it ships enabled. The reasoning: a device that got this far was held in your hand and typed the 6-digit code that **only ever shows on this PC**. Rather not: Settings → General → Phone display → untick **Allow remote control from the phone** and the whole control area disappears from the phone page; or keep it on and use the six per-item grants underneath (a revoked item is **removed** from the phone page, not greyed out).

### What is new in this release

**The main view (shaped for actual meeting use)**

- The transcript rail is now **chat bubbles**: one bubble per sentence, coloured by speaker, wrapping inside the bubble. **⧉ copy / translate / ⚡Ans** appear when you hover (or Tab to) that line instead of sitting there taking width.
- **Clicking a bubble no longer opens the full transcript panel.** That panel is behind the **⤢** button in the rail header now (selection-to-ask and clear still live there); ✕ returns you to the rail. Dragging the thin strip on the rail's right edge still resizes it (10–50%, persisted).
- The prompt card's **answer history collapses**: one "Answer history · N" row, ▸ to expand, ▾ to hide, **collapsed by default** so the vertical space goes to the answer you are reading — and the choice is remembered across restarts.

**The prompt engine (shaping what a remote model sends back)**

- New **🎚 Answer style** in the title bar: **length** (brief / standard / detailed) × **register** (plain / work / tech) × **persona** — **switchable mid-meeting, the next answer uses it**. Each rung states how long it takes to read aloud (brief ≈15-25 s, standard ≈30-60 s, detailed ≈90-150 s). The default pair, standard + work, produces answers the length v1.0.0 produced.
- **Persona library** (Settings → General → Advanced → Persona library): write up to 12 first-person "who am I when I answer" profiles in advance and pick one per meeting with 🎚. Or press **Draft from resume/JD** and the model drafts one from the material you imported (10-30 s) — the draft lands in the editor and **nothing is stored until you save**. An active persona changes tone, stance and how much it says; it never invents experience your resume does not contain.
- **Advanced prompt editor** (same entry): edit the three layers of the system prompt directly — base persona template / style directives / custom appended instructions. The grey text in each box **is** the built-in wording, and leaving a box empty uses it; a **final assembled preview** shows how many characters actually go to the model this session, and each layer restores to default on its own.
- All of this rides the **cacheable stable prefix**: install v1.0.1 and change nothing, and the prompt sent to the model is **byte-for-byte what v1.0.0 sent** (a test pins it), so upgrading alone cannot shift your answers.

**Knowledge base and document import**

- Resume, JD and the knowledge folder now accept **`.md/.txt/.docx/.pdf/.pptx`** (PowerPoint is new). Legacy 97-2003 `.doc/.ppt/.xls` are still unsupported — there is no reliable pure-JS parser, so the importer tells you to convert instead of indexing garbage.
- **Single-file import (multi-select works too)**: next to "Import folder", the knowledge tab gains **Import files**, so one PDF no longer needs its own directory.
- **Per-file progress and reasons**: importing reports each file as it settles (`Importing 12/37…`) with one row per file — imported / unchanged / skipped / failed — and a reason: **unsupported format**, **no extractable text** (scanned or image-only PDF), **parse failed** (hover for the raw error), **index not ready, nothing written**. No more "I clicked import and the window looks frozen".
- **Automatic local section summaries after import**: every document that goes in is cut into sections (per slide for PPTX, per heading level for headed documents, by length otherwise), and each section stores one short summary record in the index. That is what answers document-level questions such as "how does this design evaluate its options", which a ~300-character chunk can never match. Capped at 40 sections per document and 2 per retrieval so summaries cannot crowd the source text out. This runs **entirely on your machine, calls no model and costs nothing**, and it is extractive (heading path + the section's first sentence) — a locator, not a rewrite.
- PPTX extraction now includes **speaker notes and tables**, sectioned per slide, so answers written in the notes are retrievable.
- A real bug in an old channel is fixed: the path that reads a file into the personal knowledge base (`knowledge.md`) as plain text **stored a picked PDF's binary bytes into the index**. It now shares the same deterministic parser every other import uses, and a document with no text layer no longer overwrites what was already there. (No button in the current UI points at that channel, so this is about keeping old data from being corrupted rather than a path you can click.)
- Large folders import faster: index persistence is debounced into one batched write per import instead of one rewrite per record.

**Dual-screen: change settings from the phone**

- The phone page grows a **控制 / control** bar with exactly six things: remote **start / stop transcription**, the **continuous answering** switch, **answer length** and **register**, a **text question box** (plain text, up to 500 characters), and this meeting's **answer history** (the last 60 answers, tap one for the full text).
- **Colours are the desktop's real state**: red = capturing, green = continuous — the same semantic colours the PC uses. A tap is not a confirmation: if the desktop does not report the value back within 1.5 s the item is marked **未确认 / unconfirmed**, and tapping fast shows "too fast, wait a moment" (max 5 commands per second).
- **Nothing pops up on the desktop** for a remote command — that is deliberate, since the PC window is already hidden in dual-screen mode. The phone is the only place that says whether it landed.
- The phone can touch those six things and nothing else. **It cannot change keys, models or sessions, and never sees your resume or JD text**; the remote transcript and continuous switches drive the same real switches on the desktop.

### Known issues

- **Unsigned installers / no auto-update / local transcription needs your own Python / no macOS package / Alibaba Cloud international is Beta / the MiMo plan is Beta / stealth on macOS is best-effort / the phone display uses a self-signed certificate / reading the screen needs local OCR or a vision model**: unchanged from v1.0.0 — each one is spelled out in its English section, [RELEASE_NOTES_v1.0.0.md](RELEASE_NOTES_v1.0.0.md).
- **The phone reads its grants once, at connect time**: after you untick an item on the PC, a phone page that is **already connected** keeps showing that button; tapping it is refused with a text reason. Reload the phone page (or toggle dual-screen off and on) to make the button disappear immediately.
- **Thinking effort is not remotely controllable**: this release exposes only length and register on the phone; thinking stays in Settings → Model on the PC.
- **No screenshot asking and no session switching from the phone**: the text box is the phone's only active question path; full-screen capture stays on the PC hotkey (which can be set to deliver to the phone only).
- Section summaries are **extractive locators**, not model-written abstracts: they find the section, they do not conclude the deck for you.
- **Scanned or image-only PDFs yield no text** and are skipped with a reason (no OCR in this release).
- The two screenshots on the README's first page still show the v1.0.0 interface (no bubbles, no collapsed history, no 🎚 button) and need re-photographing.

Problems: start with the in-app **Help & guides** and [TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md) (phone connection failures: sections 9 and 10); if that does not solve it, bring the diagnostics report to [GitHub Issues](https://github.com/lakaka2970/MeetingAssistant-main/issues).
