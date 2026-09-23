# MeetingAssistant 会议助手

[![CI](https://github.com/lakaka2970/MeetingAssistant-main/actions/workflows/ci.yml/badge.svg)](https://github.com/lakaka2970/MeetingAssistant-main/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> 实时会议 / 面试助手：一边流式转写对方的话，一边用 AI 生成你可以**照着念**的第一人称回答。
> Windows / macOS · 本地优先 · BYOK（自带 Key，没有账号系统、没有中间服务器）

Real-time meeting/interview assistant for Windows and macOS: streaming ASR captions of the other
party plus first-person AI answers you can read aloud. Local-first, bring-your-own-key, no bot joins
your meeting — it just listens to your system audio. 中文文档为主，English summary at the bottom。

> 📄 本文档有可离线分发的 PDF 版本：[README.pdf](README.pdf)（排版同上，适合打印或投屏阅读）。

---

## ✨ 核心功能

- **实时流式转写**：通过系统回环音频采集对方声音，**不碰会议软件**——Teams、Zoom、飞书、腾讯会议、任意视频都能用，不需要机器人入会、不需要抓包。
- **第一人称 AI 回答**：在对方任意一句上点 **⚡答**，提词卡流式生成可直接照着念的回答；打开 **持续答** 后，只有真的在提问才会自动触发——明显的寒暄与流程安排（「把这个链接发我一下」）由本地启发式免费挡掉，拿不准的一句才花一次极小的分类调用判断，判定超时或失败一律回退成"照答"。
- **📝 做题模式（在线测评/笔试）**：标题栏 **做题** 打开一个**小窗悬浮面板**，它对录屏 / 共享 / 截图不可见（强制开启，无开关）。框选屏幕上的题目 → 读题 → **先查你本机的题库**：命中就直接把库里的答案和字母亮出来（**约 1ms，完全离线**），没命中才交给 AI，AI 也不确定时再按你的开关联网检索。四种题型各自绑定不同目录、各有答法：
  - **行测/申论**、**代码/技术**：绑定本地题库目录（递归读取 `.md/.txt/.json/.csv/.pdf`）。真题包常见的**「题目卷 + 答案卷」成对 PDF**（`…-学生版.pdf` / `…-答案版.pdf`，答案卷里是 `N.【答案】D。解析：…` 或 `1~5 BACDB`）会按 **(节, 题号)** 自动配对——**两卷的节名对不上时宁可不配**，绝不把英语的答案配到数量关系上；屏幕把选项打乱时，答案按**选项文字重新锚定**回字母。
  - **性格/心理测评**：先按"招聘方看重什么"生成一份**固定人设**（可用网络检索生成，也可手填），随后整场测评都照这份人设作答，并显式规避"全部非常符合"这类会触发装好/测谎校验的答法，反向表述的题自动把方向调转。
  - **精度优先的取舍**：只有「原题级命中 + 客观题 + 能锚定到屏幕选项」才会免模型直答；相近题会同时列出来让你确认；库里没有的题一律走 AI（并按需联网），不会硬凑一个答案。成堆下载来的题库必然互相重复：同一道题自动合并（保留解析最全的那份），**不同文件答案互相矛盾的题会被标成“答案不一致”而不是猜一个**；题干只是一句通用指令（如图形推理的「选择最合适的一项填入问号处」）时也不直答——真正的题在图里，文字认不出来。
  - **可以只绑一个总目录**：四个题型都指向同一个 `题库` 根目录也可以（本机是纯字面索引，多出的内容只会让候选变多，不影响命中速度）。代价是别的题型里的长篇资料可能作为「相近题」被列出来让你确认——它们永远不会被当成原题直接作答。
  - **读屏有两条路**：装 `npm i tesseract.js`（约 2MB 语言包，全离线）则截图先在本机识别文字，读不到题再交给视觉模型；没装就需要一个**支持图片的 API Key**（Gemini / 智谱 / Groq / 百炼 / MiMo / Ollama 等）。两者都没有时框选会直接说明缺什么，此时可用「题库自检」右侧的 **作答这题**：把题干粘贴进去，同样走 题库 → AI → 网络 的完整链路。
- **提词主视图 + 转录导轨**：左栏是一条**转录导轨**——每句一行、说话人分色、实时_partial_ 钉在底部；导轨右缘的细条可**拖拽调宽**（10%–50%，默认 16%，重启保留）。点导轨任意处，完整转录面板以**覆盖层**弹出（逐句 ⚡答、翻译、清屏都在里面），看完收起，布局不动。
- **右下角延迟 HUD**：状态栏右侧显示「话落→出字」端到端延迟（末条 / p50 / p95）、首字延迟与推理耗时；悬停每项都有解释，用于判断慢在防抖门控、检索还是模型本身。
- **手机显示（局域网）**：设置里打开 **手机显示** 后，本机变成一个只在局域网里说话的网页服务，**手机浏览器扫码即看**——左边实时转写、上面大字显示当前答案（流式逐字、公式照常排版）。它挂在主进程的事件源上，**不经过界面窗口**，所以电脑这边可以彻底隐身、不开任何窗口，屏幕上没有任何东西会被共享或拍到。同时它也接管「**后台截屏答题**」：按下截屏热键 → 拍屏 → 读题 → **先查本机题库** → 答案直接出现在手机上，全程不用回头看电脑。延迟在这条链路上是显式量：手机上每次 ping/pong 校准两机时钟差后显示真实端到端毫秒数，设置面板显示线路延迟与「因手机跟不上而丢弃」的计数。
  - 配对走「**6 位配对码 → 长期令牌**」：配对码**只显示在这台电脑上**，绝不回传给发起请求的设备，所以同一局域网里别人无法自助连进来；令牌存在手机本地，之后免配对直连。
  - 默认 HTTPS（自签证书）：一是加密局域网这一段，二是手机浏览器的 **屏幕常亮 API 只在安全上下文存在**，明文 http 下手机亮到一半就息屏。手机首次访问会提示证书不受信任——**只有报 `ERR_CERT_AUTHORITY_INVALID` 时**才有「高级 → 继续前往」可点；连接窗里备了一颗 **「改用 HTTP」** 按钮，专治那些不提供绕过入口的安卓浏览器（代价是手机不能保持常亮，按钮旁写明了）。也可以下载 `/server.crt` 装进信任列表彻底消除警告。自签证书**挡得住被动嗅探，挡不住主动中间人**，仅限可信局域网。
  - **Windows 防火墙**：第一次监听端口时系统会弹窗，请允许「专用网络」；拒绝后手机会一直连不上而电脑侧毫无异常。
- **回答可控**：`答:中 / 答:EN` 切换回答语言；`纯文本 / 多模态` 在文本大模型与视觉模型（可**截图提问**）之间切换。
- **公式与排版正常显示**：回答里的 `$…$` / `$$…$$` / `\(…\)` / `\[…\]` 由 KaTeX 排版（含 `$ … $` 这种两端带空格的写法），`**加粗**`、`*斜体*`、`` `代码` ``、`### 小标题` 也直接渲染，不再把 markdown 原样吐在屏幕上。
- **贴合你的阅历**：提词卡上 **📄简历 / 📋JD** 导入资料（`.md/.txt/.docx/.pdf`），本地解析、本地建立索引，只在提问时作为上下文发给大模型——资料本身不离开你的电脑。不同面试是不同的会话，各自绑定自己的资料与答案库。
- **提前准备的答案优先亮出来**：资料或笔记里写成 `问：… 答：…` / `Q: … A: …` / `【问题】…【回答】…` 的段落会被自动识别成问答对并按「问题」建索引。面试官的问题命中时，提词卡**先原样显示你准备的答案**（本地检索，几十毫秒内可见），再由 AI 在其基础上充实成可以直接念的完整回答——这条路径完全离线。
- **知识库没有答案才联网**：只有本地知识库毫无命中时，才会把问题发给你自己配置的搜索引擎（Tavily / Brave / SerpAPI，BYOK，默认关闭），检索结果作为回答依据并附上来源；一次检索最多等 2.5 秒，超时即放弃、绝不影响出词。
- **会话可删除**：提词卡上 🗑 删除整场对话（对话、转录、已索引的简历/JD 与其准备答案一并清除，有二次确认）。
- **本地优先**：默认语音识别是本地 FunASR，音频**不出本机**；云端方案（阿里云百炼等）只在你自己配置后才会发送音频。
- **隐身模式**：`隐身开/关` 让窗口对录屏 / 屏幕共享 / 截图不可见（Windows 有效，macOS 尽力而为），窗口默认也不出现在任务栏——隐藏后用快捷键（默认 `Control+B`）或系统托盘找回。
- **BYOK 隐私边界**：API Key 用系统加密存储在本机；没有账号、没有服务器、不代收任何费用，费用直接付给服务商。
- **为普通用户设计**：首次启动 5 步配置向导（含方案卡片、图文 Key 教程、声音检测、**真实连接测试**，14 个统一错误代码）；状态栏芯片一眼看清转写 / AI / 声音是否可用；诊断报告不含 Key、转写与简历内容，可直接贴进 issue。
- **中英双语界面**：向导里选择语言，应用启动即用该语言；系统托盘提供「开始 / 停止转写 / 新建会话 / 设置 / 服务状态 / 帮助与教程 / 检查更新 / 退出」。

## 🖥️ 界面与操作详解

主界面就三块：**标题栏**（开关与模式）、左侧**转录导轨**（对方说了什么）、右侧**提词卡**（你可以怎么答）。
下面是每个功能从点击到出结果的完整操作路径。

### 1. 实时转写：开始 / 停止 / 调宽 / 展开

1. 让电脑播放有人说话的内容（会议、视频、播客都行）——采集的是**系统回环音频**，不需要麦克风、不需要会议软件配合。
2. 点标题栏 **▶ 开始**，转录导轨开始逐句出字（每句一行，说话人分色，实时识别中的半句钉在底部显示 `_partial`）。
3. 点标题栏 **⏸ 停止**（或托盘菜单「停止转写」）结束采集。
4. 导轨右缘有一根细条，**按住拖拽**即可调宽（10%–50%，默认 16%，重启后保留）。
5. 点导轨任意处，**完整转录面板**以覆盖层弹出——逐句 ⚡答、翻译、清屏都在面板里，点空白处收起，整体布局不动。
6. 想把自己的发言也单独转写：打开标题栏 **🎤麦克风**（建议戴耳机，避免扬声器回声被二次采集）。

### 2. AI 回答：⚡答 / 持续答 / 回答语言 / 双通道

- **手动答**：在导轨或转录面板里对方那句话上点 **⚡答**，提词卡流式生成一段第一人称、可直接照着念的回答。
- **持续答**：打开标题栏 **持续答**，AI 自动接话。门控是三层：明显的寒暄与流程安排（「把这个链接发我一下」）由本地启发式免费挡掉；拿不准的一句才花一次极小的分类调用判断；**判定超时或失败一律回退成「照答」**，宁可多答不漏答。
- **回答语言**：标题栏 **答:中 / 答:EN** 切换。此外，在任意一句上选择「翻译」可把该句转录内联翻译成另一语言。
- **文本 / 视觉双通道**：标题栏 **纯文本 / 多模态** 切换回答用的模型。多模态下可以**截图提问**（把屏幕上的内容作为图片发给视觉模型）。
- **删除会话**：提词卡 **🗑** 一次删掉整场对话（对话、转录、该会话已索引的简历/JD 与准备答案全部清除），有二次确认。不同面试建不同会话（托盘「新建会话」），资料与答案库按会话隔离。

### 3. 简历 / JD 知识库：导入 → 准备答案 → 命中

1. 提词卡上点 **📄简历** 或 **📋JD**，选本地文件（`.md/.txt/.docx/.pdf`）。解析与索引**全部在本机**完成，资料本身不出电脑，只有在提问时才作为上下文发给你配置的大模型。
2. **准备答案优先亮出**：资料或笔记里写成 `问：… 答：…` / `Q: … A: …` / `【问题】…【回答】…` 的段落会被自动识别成问答对、按「问题」建索引。面试官的问题命中时，提词卡**先原样显示你准备的答案**（本地检索，几十毫秒），再由 AI 在其基础上充实成可以直接念的完整回答——这条路径完全离线、不花一次网络请求。
3. **联网兜底**：只有本地知识库毫无命中时，才会把问题发给你配置的搜索引擎（设置 → 视觉与搜索 → 网络检索兜底：Tavily / Brave / SerpAPI，各自带免费额度，默认关闭）。一次检索最多等 **2.5 秒**，超时即放弃、绝不影响出词；检索结果作为回答依据并附上来源。
4. 想先看看某个目录能被识别出多少条准备答案：`npm run qa:inventory -- <目录>`（干跑，不调模型）。

### 4. 做题模式（在线测评 / 笔试）

1. 点标题栏 **做题**，打开一个**小窗悬浮面板**——它对录屏 / 共享 / 截图强制不可见，没有开关可关。
2. 四个题型各绑定一个本地目录（设置内指定），先选对题型再开始：

| 题型 | 绑定内容 | 答法 |
|---|---|---|
| 行测 / 申论 | `.md/.txt/.json/.csv/.pdf` 题库目录 | 原题命中直接给库里的答案与字母（≈1ms、离线）；真题包「学生版 + 答案版」成对 PDF 按 (节, 题号) 自动配对，节名对不上宁可不配 |
| 代码 / 技术 | 同上 | 同上；屏幕把选项打乱时，答案按选项文字重新锚定回字母 |
| 性格 / 心理测评 | 一份**固定人设**（可联网生成也可手填） | 整场照人设作答；显式规避「全部非常符合」这类触发装好/测谎校验的答法；反向表述自动调转方向 |
| 其他 | 任意目录 | 同行测链路 |

3. **框选答题**：在小窗里拖框选中屏幕上的题目区域 → 读题（装了 `tesseract.js` 先本机 OCR，读不到再交视觉模型；两者都没有会直接说明缺什么）→ **先查本机题库**，命中即答；没命中才交 AI，AI 不确定时再按需联网。
4. 快捷键：`Ctrl+Shift+S` 整屏截屏答题 · `Ctrl+Alt+A` 答最新一句 · `Ctrl+Alt+S` 框选截屏答题。
5. 精度底线：只有「原题级命中 + 客观题 + 能锚定到屏幕选项」才免模型直答；相近题只列出来让你确认；题库里答案互相矛盾的题会标成「答案不一致」而不是猜一个；纯图形题（题干只是「选择最合适的一项」）不直答。
6. 没有视觉模型也没有 OCR 时：用小窗里 **作答这题**——把题干粘进去，同样走 题库 → AI → 网络 的完整链路。
7. 干跑验证题库：`npm run exam:selftest -- <题库目录> [题目…]`。

### 5. 手机显示（双屏提词）

完整 7 步配对流程见下文 **「📱 单屏 / 双屏」**；这里补充操作细节：

- **入口**：标题栏 **双屏** 分段控件，或 设置 → 通用 → 手机显示 → 打开连接窗口。进入双屏时**自动打开持续答**，主窗自动隐藏并强制隐身。
- **手机上看到什么**：左边实时转写流，上方大字显示当前答案（流式逐字、公式照常排版）。每次 ping/pong 校准两机时钟差，所以手机上打印的毫秒数是真实端到端延迟；设置面板另有线路延迟与「因手机跟不上而丢弃」计数。
- **免看电脑截屏答题**：连接窗口勾选 **「截屏热键只送手机」** 后按 `Ctrl+Shift+S` 或 `Ctrl+Alt+S`——拍屏、读题、查题库、答案直出手机，电脑这边不弹任何窗。不勾选时 `Ctrl+Alt+S` 恢复常规行为（弹做题小窗等你拖框）。
- **常亮**：手机上必须点一次 **「常亮」**（浏览器规定须用户点击才允许保持亮屏），且只在 https 下可用——这就是默认自签 HTTPS 的第二个理由。
- **证书**：想彻底消除警告，可从 `/server.crt` 下载证书装进手机信任列表。自签证书挡得住被动嗅探，挡不住主动中间人，**仅限可信局域网**。
- **隐私边界**：只有你主动开启后才监听端口；数据只在电脑与手机间直连，不经任何第三方；关开关即停。默认端口 **18765**。

### 6. 隐身、快捷键与托盘找回

- **隐身开/关**（标题栏）：窗口对录屏 / 屏幕共享 / 截图不可见（Windows 有效，macOS 尽力而为）。
- 主窗默认**不出现在任务栏**。点 **—** 隐藏后，找回窗口两条路：
  1. 按呼出快捷键（默认 `Control+B`，设置 → 通用 可改）；
  2. 点系统托盘 MeetingAssistant 图标（或右键菜单「显示窗口」）。第一次隐藏时有一次气泡提示。
- 托盘菜单全集：**开始 / 停止转写、新建会话、设置、服务状态、帮助与教程、检查更新、退出**。

### 7. 延迟 HUD：慢在哪一步，一眼看出

状态栏右侧常驻显示：**「话落→出字」端到端延迟**（末条 / p50 / p95）、**首字延迟**（LLM 第一个字）、**推理耗时**。鼠标悬停每一项都有解释。用途：判断慢在防抖门控、检索还是模型本身——p50 高是普遍慢，末条飙高是偶发卡顿。

### 8. 状态芯片、诊断报告与向导重开

- 状态栏芯片一眼看清**转写 / AI / 声音**是否可用，无需打开设置。
- 出问题先查应用内 **帮助与教程**（托盘或 设置 → 帮助与教程，离线可读），再查 [TROUBLESHOOTING.zh-CN.md](docs/user/TROUBLESHOOTING.zh-CN.md) 的 14 个错误代码表。
- 要提 issue：设置 → 通用 → **诊断信息**（或标题栏 `⋯` 菜单）生成报告——不含 Key、转写与简历内容，仅复制到剪贴板、不落盘。
- 配置向导随时重开：**⚙ 设置 → 重新运行配置向导**（主窗口保持运行，不会退出应用）。

## 📸 界面预览

| 浅色 | 深色 |
|---|---|
| ![浅色主界面](docs/main-light.png) | ![深色主界面](docs/main-dark.png) |

- 双语实时演示：![demo-bilingual.gif](docs/demo-bilingual.gif)
- 完整演示视频：[MeetingAssistant-demo.mp4](docs/MeetingAssistant-demo.mp4)

## 🔌 支持的 AI 服务（BYOK）

| 能力 | 服务 |
|---|---|
| 流式语音识别（云端） | 阿里云百炼实时识别（推荐）· MiMo（Beta） |
| 分段语音识别 | MiMo · 自定义 OpenAI 兼容服务 |
| 本地语音识别 | FunASR（默认）· MOSS-Transcribe-Diarize（实验）· Whisper（离线兜底） |
| 文本大模型 | DeepSeek（推荐）· 智谱 · Groq · Gemini · Ollama（本地）· 自定义 OpenAI 兼容 |
| 多模态大模型 | Gemini（默认经本地代理）· 自定义视觉模型 |

语音识别与 AI 回答通常各需要一个 Key，同一服务商可复用；
「极简配置」方案只需注册一个平台（MiMo，语音识别与回答共用 1 个 Key）。Key 领取教程见 [API_KEYS.zh-CN.md](docs/user/API_KEYS.zh-CN.md)。

## 🔑 获取并填写 API Key（LLM / 语音识别）

### 先弄清楚要几个 Key

| 你要用的功能 | 需要的 Key | 填在哪里 |
|---|---|---|
| 云端实时转写（推荐） | 阿里云百炼 Key | 向导第 3 步「语音识别」卡片；或 设置 → **语音识别** |
| AI 回答（推荐） | DeepSeek Key | 向导第 3 步「AI 回答」卡片；或 设置 → **模型** |
| 只要一个平台搞定两者 | MiMo Key（Beta） | 向导「极简配置」方案，勾选共用 |
| 截图问答 / 做题读题 | 任一**支持图片**的模型 Key（Gemini / 智谱 / Groq / MiMo / 百炼…） | 设置 → **视觉与搜索**（国内连 Google 需填「视觉代理」，如 `127.0.0.1:7897`） |
| 联网检索兜底（可选） | Tavily / Brave / SerpAPI Key | 设置 → **视觉与搜索** → 网络检索兜底（默认关闭；开了没填 Key 会静默跳过联网） |
| 本地转写（FunASR/MOSS/Whisper）/ 本地回答（Ollama） | 不需要云端 Key | 见下文「本地语音识别」；Ollama 在 设置 → 模型 选本地方案，API Key 留空 |

> 语音识别与 AI 回答是**两个独立的服务商**，通常各需一个 Key；同一服务商（如 MiMo）可以复用同一个。

### 通用填写步骤（每个服务商都一样）

1. 到服务商控制台注册并**实名认证**（国内平台不实名建不了可用的 Key）。
2. 在「API Keys / API-KEY / API 密钥」页面**新建**一个 Key，起个好认的名字（例如 `MeetingAssistant`）。
3. **立刻复制**——绝大多数平台的 Key 只完整显示这一次，关窗后就再也看不到了（丢了就删掉重建，不影响账号）。
4. 回到 MeetingAssistant 粘贴：优先走**首次启动的 5 步配置向导第 3 步**（每张卡片带图文教程和「打开官方密钥页面」按钮）；错过向导则在 **设置** 对应 Tab 的输入框粘贴。也可以点「从剪贴板粘贴」。
5. 点 **「保存并测试连接」**。保存时自动去掉首尾空格、包裹的引号和 `Bearer ` 前缀——多粘了这些也没关系。
6. 测试失败时卡片给出**归一化错误代码**与下一步建议（Key 错 / 余额不足 / 网络不通一眼分清），也可选「暂时保存并稍后重试」。完整代码表见 [TROUBLESHOOTING.zh-CN.md](docs/user/TROUBLESHOOTING.zh-CN.md)。

### 各服务商要点

**DeepSeek（推荐用于 AI 回答）** — [platform.deepseek.com](https://platform.deepseek.com/)：登录后进左侧「API keys」→「创建 API key」→ 复制。默认模型 `deepseek-flash`（首字最快、能读图），强推理档 `deepseek-v4-pro`（适合复盘不适合抢答）；**只接受这两个模型名**，旧名会报 400（应用会把你存过的旧名自动改成 `deepseek-flash`）。提示 `Insufficient Balance` 说明 Key 有效、只需充值。

**阿里云百炼 · 中国大陆站（推荐用于实时转写）** — [bailian.console.aliyun.com](https://bailian.console.aliyun.com/?tab=model)：注册阿里云账号 → 开通「百炼」→ **实名认证** → 停留在**主账号默认业务空间**（子账号/自建空间可能没有实时语音识别权限）→ 右上角头像菜单「API-KEY」→「创建我的 API-KEY」→ 复制。默认模型 `fun-asr-realtime`。报 `Access denied` 多为未开通/未实名；报 `Model not found` 多半是账号属于国际站（国际站接入地址不同，本版本未提供预设，求稳定实时字幕请用大陆站账号）。

**MiMo · 小米（一个 Key 兼顾转写与回答，Beta）** — [platform.xiaomimimo.com](https://platform.xiaomimimo.com/)：小米账号登录 → 控制台「API Keys」→ 新建 → 复制以 `sk-` 开头的 Key。同一 Key 同时填给语音识别与 AI 回答（极简配置方案）。注意它是**分段识别**，按整句返回、字幕跟随性弱于流式方案——这是方案特性，不是故障。

**智谱 GLM（国内直连，有免费档）** — [open.bigmodel.cn](https://open.bigmodel.cn/)：手机号登录（首次需注册+实名）→ 头像菜单「API 密钥」→「新建 API Key」→ 复制。`GLM-4-Flash` 免费额度充足、首字极快，适合低延迟兜底；`GLM-4.6` 是中文质量档，适合行为面与复杂问答；同一账号同一 Key。

**Groq（英文编码题极速档）** — [console.groq.com](https://console.groq.com/)：注册登录 →「API Keys」创建并复制（以 `gsk_` 开头）。服务器在海外，中国大陆网络通常需要本机代理。免费档有速率限制。

**Google Gemini（可选，截图问答）** — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)：Google 账号登录 →「Create API key」→ 选/建一个 Cloud 项目 → 复制，粘贴到 设置 → 视觉与搜索 的视觉 Key。国内通常无法直连：在「视觉代理」填本机代理地址（如 `127.0.0.1:7897`）。不想折腾代理可改用 MiMo 的 `mimo-v2.5` 做视觉，代理留空。截图问答是可选功能，跳过不影响转写和文字回答。

**Ollama（完全本地，零 Key 零费用）** — 本机安装并启动 [ollama.com](https://ollama.com/) 客户端（默认监听 `127.0.0.1:11434`）→ 命令行 `ollama pull qwen2.5:7b` → 设置里 Base URL 填 `http://127.0.0.1:11434/v1`、模型名与拉取的一致、**API Key 留空**。速度取决于本机硬件，优势是回答完全不经过网络。测试失败先确认 Ollama 在跑（它默认只监听本机回环）。

**自定义 OpenAI 兼容服务** — 准备一个以 `/v1` 结尾的 Base URL、模型名与 Key，填在 **设置 → 模型 → 高级设置**。出于安全考虑，应用只会用系统浏览器打开内置允许列表里的官方页面，自定义服务商的页面请自行访问。

### Key 存在哪里、安全边界

- Key 用**系统凭据服务加密**后写入本机配置：Windows 用 DPAPI，macOS 用钥匙串。系统凭据服务不可用时，应用会在保存**前**弹警告（此时只能弱保护/混淆）。
- 解密后的 Key **只存在于主进程**，界面层永远拿不到，只能看到「已配置」与后 4 位。
- 删除 Key：设置里对应输入框旁「删除 Key」→「确认删除」→「保存」。
- **费用**：BYOK——Key 在服务商处创建、服务商直接向你计费；本应用没有账号、没有服务器、不代收、不分成、不加价。「测试连接」每次只发一个极小真实请求（1 个 token / 约 1.4 秒音频 / 一张 64×64 图），只在你点击时发生。
- Key 泄露 = 别人花你的额度：别贴进聊天记录、截图或公开仓库；泄露了去服务商控制台删掉重建即可，账号不受影响。

## ⚡ 快速开始（普通用户）

全程不需要安装 Node.js / Python，也不需要敲命令（本地转写才需要自备 Python，见下文）。

1. 从 [Releases 页面](https://github.com/lakaka2970/MeetingAssistant-main/releases/latest) 下载
   `MeetingAssistant-<版本>-win-x64.exe`（安装版）或 `...-portable.exe`（免安装版）；
   建议核对旁边的 `.exe.sha256` 校验文件。
2. 启动后跟着 **5 步配置向导**走：欢迎 → 选择方案 → 配置服务（粘贴 Key 并「保存并测试连接」）→ 连接测试（检测电脑声音）→ 完成。
3. 播放会议 / 视频，点标题栏 **▶ 开始**，转录导轨开始出字（点导轨展开全部转录）。
4. 在对方那句上点 **⚡答** 生成回答；打开 **持续答** 自动接话；在提词卡导入 **📄简历 / 📋JD** 让回答贴合你的经历。

> Windows SmartScreen 会提示「已保护你的电脑」——安装包**未做代码签名**（不影响功能），确认来源后点「更多信息 → 仍要运行」即可。

详细走查：[QUICK_START.zh-CN.md](docs/user/QUICK_START.zh-CN.md) · 安装说明：[INSTALL_WINDOWS.zh-CN.md](docs/user/INSTALL_WINDOWS.zh-CN.md) · 故障排查：[TROUBLESHOOTING.zh-CN.md](docs/user/TROUBLESHOOTING.zh-CN.md)

macOS 暂无安装包，需从源码运行（系统声音需 BlackHole 虚拟音频设备）：[INSTALL_MACOS.en.md](docs/user/INSTALL_MACOS.en.md)

## 📱 单屏 / 双屏

标题栏有一个分段控件 **单屏｜双屏**，它决定「答案显示在哪里」：

| | 单屏（原有行为） | 双屏 |
|---|---|---|
| 显示 | 这台电脑的悬浮窗 | 局域网里的手机浏览器 |
| 电脑屏幕 | 看得见窗口 | 主窗自动隐藏、强制隐身，共享/录制里什么都拍不到 |
| 触发 | 点转写气泡上的 ⚡答 | `Ctrl+Shift+S` 整屏截屏答题 · `Ctrl+Alt+A` 答最新一句 · `Ctrl+Alt+S` 框选截屏答题 |
| 持续答 | 自己开 | 进入双屏时自动打开 |

点 **双屏** 会立刻弹出一个**连接窗口**：大二维码、可复制的地址、6 位配对码、已配对设备与在线状态。手机扫码 → 输配对码 → 连上后这个窗口自己收起、主窗随之隐藏。之后要再看二维码，点标题栏的 **双屏**（已在双屏时再点一次就是重新呼出），或 **设置 → 通用 → 手机显示 → 打开连接窗口**。

电脑负责听、查本机题库与资料、调 AI；手机只负责给你看。转写与答案都来自主进程的事件源，**不经过界面窗口**，所以窗口隐藏与否不影响手机收到内容。

连接与配对步骤：

1. 手机与电脑连**同一个 Wi-Fi**（手机别开移动数据兜底，否则它会走别的网段）。
2. 电脑点标题栏 **双屏** —— 连接窗口立刻弹出。
3. 手机相机扫那个**二维码**（手动输地址也行，形如 `https://192.168.10.23:18765/`）。
4. 手机上点「请求配对」后，**回到连接窗口看 6 位配对码**（配对码不会显示在手机上），输进手机即可。
   之后令牌存在手机本地，重开页面直接连。
5. 手机上点一次 **「常亮」**（浏览器要求必须由你点一下才允许保持亮屏）。
6. 电脑上点 **▶ 开始**，转写与答案就会持续推送到手机。
7. 想在**完全不看电脑**的情况下截屏答题：在连接窗口里勾选 **「截屏热键只送手机」**，
   然后按 `Ctrl+Shift+S` 或 `Ctrl+Alt+S`（勾选后两者行为相同：都整屏抓取、答案直送手机，
   电脑这边不弹任何窗口）——拍屏、读题、**先查本机题库**、答案直接出在手机。
   不勾选时 `Ctrl+Alt+S` 恢复常规行为：弹出做题小窗、等你拖框选题目区域。
   读题这一步需要**视觉模型**或本地 OCR：两者都没有时，链路会直接告诉你缺哪一个，
   而不是默默给你一个空答案。用 DeepSeek 的话，视觉模型选 **DeepSeek 视觉·flash**
   即可与文本共用同一个 Key（设置 → 视觉模型）。

**连不上时的排查顺序**：① Windows 第一次监听会弹防火墙提示，必须点「允许」并勾选**专用网络**
（拒绝之后的表现是手机永远连不上、电脑侧毫无异常）；② 确认手机和电脑在同一网段；
③ 连接窗如果显示「未监听」，看它旁边给出的原因（多半是端口被占用）；
④ 手机报证书错误时**分清是哪一种**：`ERR_CERT_AUTHORITY_INVALID` 点「高级 → 继续前往」即可；
若报的是 `ERR_CERT_INVALID`，那是**硬拦、没有任何绕过入口**，直接点连接窗里的 **「改用 HTTP」**；
⑤ 若地址是 `http://` 而手机浏览器仍报 `ERR_PROTOCOL_ERROR`，是浏览器把地址自动升级成了 https——
请完整输入 `http://` 前缀，或关掉浏览器的「始终使用安全连接」。

> 隐私边界：这条链路只在你**主动开启**后才监听端口；数据只在电脑与手机之间直连，不经过任何第三方
> 服务器；关掉开关即停止监听。默认端口 **18765**。

## 💻 本地语音识别（可选，免云端）

应用**自动拉起并回收**本地 sidecar 进程，你只需在设置里选好方案，模型首次运行自动下载。

### FunASR（默认本地方案）

Python 3.10 conda 环境 + `funasr` + `torch`（NVIDIA GPU 推荐）：

```bash
conda create -n funasr python=3.10 -y
conda activate funasr
pip install "torch==2.11.0" --index-url https://download.pytorch.org/whl/cu128   # 按你的 GPU 选择
pip install -r requirements-funasr.txt
```

模型（paraformer ≈880MB / Nano ≈1.7GB）首次运行自动从 ModelScope 下载。解释器查找顺序：
`MC_FUNASR_PYTHON` → 项目 `.venv` → `C:\ProgramData\miniconda3\envs\funasr` → `python`（PATH）。

### MOSS-Transcribe-Diarize 0.9B（实验）

隔离的 Python 3.12 环境，避免 Transformers 5.x 干扰 FunASR：

```powershell
conda create -n moss-asr python=3.12 -y
conda run -n moss-asr python -m pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
conda run -n moss-asr python -m pip install -r requirements-moss.txt
```

首次运行从 Hugging Face 下载约 1.7GB BF16 权重，设备顺序 CUDA BF16 → CPU。可用 `MC_MOSS_PYTHON` / `MC_MOSS_DEVICE` 覆盖解释器与设备。注意 MOSS 非流式模型，按约 700ms 静音分段整句返回。

### Whisper turbo（离线兜底）

把 [`onnx-community/whisper-large-v3-turbo-ONNX`](https://huggingface.co/onnx-community/whisper-large-v3-turbo-ONNX)
放入 `%APPDATA%/MeetingAssistant/models/onnx-community/whisper-large-v3-turbo-ONNX/`，编码器走 DirectML GPU。

完整平台配置见 [docs/windows/SETUP.zh-CN.md](docs/windows/SETUP.zh-CN.md)（Windows）与 [docs/macos/SETUP.md](docs/macos/SETUP.md)（macOS）。

## 🛠 从源码开发

### 环境要求

| 组件 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（64 位）；macOS 14+（Apple silicon） |
| 运行时 | Node.js ≥ 20 与 npm |
| LLM Key | 任意 OpenAI 兼容 API Key（推荐 DeepSeek） |

### 安装与运行

```bash
git clone https://github.com/lakaka2970/MeetingAssistant-main.git
cd MeetingAssistant-main
start.bat          # Windows 一键启动：首次运行自动自检并装配环境，或手动 npm install && npm start
```

> Windows 下双击 `start.bat` 即可，不必先手动执行安装与构建：它会依次自检 Node.js ≥ 20（缺失时给出安装指引）、安装 npm 依赖（默认源失败时自动写入 `.npmrc` 国内镜像并重试一次）、校验 transformers.js 补丁、补下载 Electron 二进制（失败自动改用镜像）、构建，最后启动应用；本地 ASR / OCR / 原生音频等可选能力只做提示，不阻塞启动。逻辑在 `tools/start-check.ps1`（`start.bat` 只是纯 ASCII 壳，cmd 对 UTF-8 批处理会截行）。

> 🇨🇳 npm / Electron 下载慢时，在项目根目录建 `.npmrc`：
> `registry=https://registry.npmmirror.com` 与 `electron_mirror=https://npmmirror.com/mirrors/electron/`

### 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式（electron-vite dev，热更新） |
| `npm run build` / `npm start` | 构建 / 预览构建产物 |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm test` / `npm run test:python` | 单元测试 / Python sidecar 测试 |
| `npm run verify` | 类型检查 + 测试 + 构建（提交前推荐） |
| `npm run dist:win` | 打包 Windows 安装包（NSIS + portable） |
| `npm run smoke:*` | 各能力冒烟测试（ASR / LLM / RAG / E2E） |
| `npm run smoke:companion` | 手机显示冒烟：真启动主进程，验证端口监听与页面/脚本/证书/KaTeX 均可取 |
| `npm run qa:inventory -- <目录>` | 干跑面试知识库：看某目录能被识别出多少条「准备的答案」 |
| `npm run exam:selftest -- <题库目录> [题目…]` | 干跑做题题库：绑定→配对→检索→给出答案与耗时（不调模型） |

### 可选：原生音频后端（Rust）

默认 `audio.captureBackend = webaudio`，开箱即用。想要 Windows WASAPI 回环直采（无需虚拟声卡）
可构建 `rust/` 下的 napi-rs 模块（`cd rust && npm install && npm run build:release`），产物
`resources/native/meeting-assistant-audio.node` 缺失时自动回退 Web Audio 路径。详见 [rust/README.md](rust/README.md)。

## 📁 项目结构

```
electron/     # 主进程：悬浮窗、隐身、快捷键、设置、IPC、ASR/LLM/RAG 宿主、托盘、做题小窗与题库（electron/exam/）、局域网手机显示（electron/companion/）
src/          # 渲染进程（React）：转录面板、回答会话、知识库、设置、配置向导、做题小窗（src/exam/）
shared/       # 纯数据模块（渲染/主进程共用）：服务商目录、协议、平台、题库解析与检索、人设引擎、判题门控
resources/    # 随包发布的只读载荷：Python sidecar 脚本、托盘图标、内置技能、手机显示页（resources/companion/）
electron/asr/ # 语音识别后端路由（FunASR sidecar / MOSS / 云端 / Whisper）
electron/llm/ # LLM 适配与路由（流式、多模态、失败回退）
electron/rag/ # 简历/JD 索引与检索（本地解析，提问时注入上下文）
tools/        # Python sidecar 服务器与冒烟脚本（funasr_stream_server.py 等）
rust/         # 可选原生音频采集（napi-rs + WASAPI/cpal）
docs/         # 用户文档（快速开始 / API Key / 故障排查 / 平台配置）与截图素材
```

## ✅ 测试与质量

CI（`.github/workflows/ci.yml`）在 Windows 上自动执行：`typecheck` → `npm test` → `test:python`
→ `build` → `verify:patched`（确认 transformers.js 补丁未被依赖安装覆盖）。
本地提交前可跑 `npm run verify`。诊断问题：应用内 **设置 → 通用 → 诊断信息**（或标题栏 `⋯` 菜单）
生成不含敏感内容的诊断报告（仅复制到剪贴板，不落盘），可随 issue 提交。

## 📚 文档索引

| 文档 | 说明 |
|---|---|
| [QUICK_START.zh-CN.md](docs/user/QUICK_START.zh-CN.md) / [EN](docs/user/QUICK_START.en.md) | 面向普通用户的五步快速开始 |
| [API_KEYS.zh-CN.md](docs/user/API_KEYS.zh-CN.md) / [EN](docs/user/API_KEYS.en.md) | 各服务商 Key 领取教程 |
| [README.pdf](README.pdf) | 本文档的 PDF 版（离线分发 / 打印） |
| [TROUBLESHOOTING.zh-CN.md](docs/user/TROUBLESHOOTING.zh-CN.md) / [EN](docs/user/TROUBLESHOOTING.en.md) | 错误代码表与排查指南 |
| [INSTALL_WINDOWS.zh-CN.md](docs/user/INSTALL_WINDOWS.zh-CN.md) / [EN](docs/user/INSTALL_WINDOWS.en.md) | Windows 安装说明（含 SHA256 校验） |
| [INSTALL_MACOS.en.md](docs/user/INSTALL_MACOS.en.md) | macOS 从源码安装与 BlackHole 音频路由 |
| [docs/windows/SETUP.md](docs/windows/SETUP.md) / [zh-CN](docs/windows/SETUP.zh-CN.md) | Windows 平台完整配置（Python / 本地 ASR） |
| [docs/macos/SETUP.md](docs/macos/SETUP.md) | macOS 平台完整配置 |
| [RELEASE_NOTES_v1.0.0.md](docs/user/RELEASE_NOTES_v1.0.0.md) | 版本说明与已知问题 |

## 📄 开源许可

[Apache License 2.0](LICENSE)

---

## English

**MeetingAssistant** is a real-time meeting / interview assistant for Windows and macOS. It captures
the other party through **system loopback audio** (no bot, no integration—works with any meeting app),
transcribes it with streaming ASR, and generates **first-person answers you can read aloud**, powered
by your own BYOK (bring-your-own-key) LLM provider. It is local-first: the default ASR backend
(FunASR) runs on your machine and audio never leaves it unless you configure a cloud provider.
A printable/offline copy of this document is available as [README.pdf](README.pdf).

**Highlights**

- Streaming ASR: local FunASR (default), Alibaba Cloud Bailian realtime (recommended cloud), MiMo, experimental MOSS-Transcribe-Diarize, offline Whisper fallback
- Per-line ⚡Ans answers + 🎤 optional mic channel; text (`纯文本`) or multimodal/vision mode with screenshot Q&A
- Knowledge panel: import your resume/JD (`.md/.txt/.docx/.pdf`), parsed and indexed locally, only sent to your LLM as context when asking; each session is one interview with its own material
- Prepared answers surface first: `问：… 答：…` / `Q: … A: …` / `【问题】…【回答】…` blocks in your documents or notes are auto-detected and indexed by question; on a hit the prompt card shows your prepared answer verbatim (local, tens of ms) and the AI only enriches it — no network on that path
- Exam mode (做题模式): a separate small floating window, forcibly invisible to screen capture, for online assessments. Drag over the question on screen → it is read (local OCR first, vision model otherwise) → **your local question bank answers it in ~1 ms, offline**; the LLM only covers what the bank lacks, and the web only on an explicit opt-in. Four sub-modes, each bound to its own folder: aptitude/essay, coding/technical, personality, other. Paired real-exam PDFs (`…-学生版.pdf` + `…-答案版.pdf`, keys like `N.【答案】D。解析：…` or `1~5 BACDB`) are joined by (section, number) and **refuse to pair when the two papers' sections disagree** — a wrong answer with confidence is the one outcome this must never produce; when the OA page shuffles the options, the answer is re-anchored onto the option text and the on-screen letter. Reading the screen needs either `npm i tesseract.js` (offline, tried first) or a vision-capable key; with neither, paste the stem into the bank field and use **Answer this** for the same bank → AI → web chain. Binding one shared parent folder to all four sub-modes is fine — the index is literal, so extra material can only ever surface as a "similar question" to confirm, never as a direct answer.
- Phone display over the LAN (设置 → 手机显示): the machine becomes a local-only web service and a phone browser shows the live transcript plus the current answer in large type — streamed token by token, maths typeset with KaTeX. The bridge taps the ASR/LLM/exam event sources **inside the main process**, not the UI, so the PC side can stay hidden or never open a window at all: nothing on this screen is in a shared capture. It also carries the headless screen-answer path — with 「截屏热键只出答案到手机」 on, one press of the screenshot hotkey captures the screen, reads it, **checks your local question bank first** and puts the answer on the phone without raising a window. Latency is an explicit quantity here, not a vibe: the phone calibrates the two clocks with ping/pong so the milliseconds it prints are real end-to-end cost, and the settings row shows wire latency plus how many frames were dropped because a phone could not keep up. Pairing is a 6-digit code → long-lived token, where **the code is only ever displayed on this machine** and never sent back to the device that asked, so nothing else on the LAN can pair itself. HTTPS with a self-signed cert is the default — it encrypts the LAN hop *and* is the only context where the browser's screen Wake Lock exists, so the phone does not dim mid-meeting. Self-signed stops passive sniffing, not an active man-in-the-middle: trusted networks only. Off unless you enable it; default port 18765.
- Two modes stay apart by construction: exam banks and the personality persona live in their own store and never enter the interview RAG index, so civil-service arithmetic cannot start answering interview questions, or the other way round.
- Continuous answering is now gated: greetings and logistics never cost a model call, only a genuinely ambiguous line gets one tiny classifier request, and any timeout or failure falls back to answering.
- Web search is the fallback, not the default: only a question the knowledge base cannot answer at all reaches your own search key (Tavily / Brave / SerpAPI, off by default), under a hard 2.5 s deadline, and the answer cites what came back
- Journal maths render properly: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` are typeset with KaTeX (space-padded `$ … $` included), and `**bold**`, `*italic*`, `` `code` `` and `### headings` are rendered instead of shown raw
- Sessions are deletable: 🗑 drops the conversation, its transcript and everything its resume/JD contributed to the index, after a confirmation
- BYOK: keys encrypted on-device; no account system, no servers, no reseller fees
- Stealth mode hides the window from screen share/screenshots (effective on Windows); global hotkey `Ctrl+B` + system tray to bring it back
- 5-step first-run wizard, real connection tests (14 normalized error codes), status chips, local diagnostics, in-app help — bilingual UI (中文 / English)

**Operating guide (short version)** — the full click-level walkthrough is in the Chinese sections
「界面与操作详解」/「单屏 / 双屏」above; the same docs exist in English under `docs/user/`:

- **Transcribe**: play any audio on the PC → title bar **▶ Start**; the rail shows one line per
  sentence. Drag the thin strip on the rail's right edge to resize (10–50%); click the rail to open
  the full-transcript overlay. Optional **🎤 Mic** transcribes your own speech on a separate channel.
- **Answer**: click **⚡Ans** on any line; toggle **Auto-answer** for continuous mode (gated),
  **答:中/答:EN** for answer language, **plain-text/multimodal** to switch to the vision model
  (screenshot Q&A). **🗑** deletes the whole session (transcript, indexed resume/JD, prepared answers).
- **Resume/JD**: **📄Resume / 📋JD** on the prompt card import `.md/.txt/.docx/.pdf`, parsed and
  indexed locally. `Q:/A:` blocks surface your prepared answer verbatim before the AI enriches it;
  web search (Tavily/Brave/SerpAPI, off by default, 2.5 s cap) only fires when the local KB misses.
- **Exam mode**: title bar **做题** opens a capture-invisible panel bound to per-mode bank folders;
  drag-select a question (or `Ctrl+Shift+S` full-screen / `Ctrl+Alt+A` last line / `Ctrl+Alt+S`
  region) → local bank first (~1 ms, offline) → LLM → optional web. See the Chinese section for the
  four sub-modes and the accuracy rules.
- **Phone display**: title bar **dual-screen** (or Settings → General → Phone display) opens the
  pairing window — scan the QR, enter the 6-digit code **shown only on the PC**, tap **Keep awake**
  on the phone. Hotkeys can be set to deliver answers phone-only without raising any window.
- **Hidden window**: default summon hotkey `Ctrl+B`, or the tray menu (start/stop, new session,
  settings, service status, help, update check, quit).
- **Latency HUD** (bottom-right): end-to-end speech→caption (last / p50 / p95), first-token and
  reasoning time — each entry has a hover explanation.

**Getting and filling API keys** — a key is a credential you create in a provider's console; it is
not your password, it spends your money, and it can be revoked any time. You normally need two:
one for speech recognition (Alibaba Cloud Bailian, mainland account) and one for AI answers
(DeepSeek recommended); MiMo covers both with a single key (Beta); Zhipu GLM-4-Flash offers a
generous free tier; Groq is a fast overseas lane; Ollama needs no key at all (local, leave the key
field empty, base URL `http://127.0.0.1:11434/v1`). Fill them in **step 3 of the first-run wizard**
(each card has a tutorial and an "open key page" button) or under the matching Settings tab
(**Speech recognition / Model / Vision & search** — the latter also holds the optional vision-model
key, its proxy field, and the web-search fallback keys). Always press **"Save and test
connection"**: it strips stray quotes/`Bearer ` prefixes, then sends one tiny real request and
reports a normalized error code on failure. Keys are encrypted via DPAPI (Windows) / Keychain
(macOS), live only in the main process, and the UI only ever shows the last 4 characters. Step-by-step
per-provider instructions: [API_KEYS.en.md](docs/user/API_KEYS.en.md).

**Install (Windows)**: download the NSIS installer or portable `.exe` from the
[Releases page](https://github.com/lakaka2970/MeetingAssistant-main/releases/latest) and verify the
SHA256 sidecar file. macOS: run from source (needs a virtual audio device such as BlackHole) — see
[INSTALL_MACOS.en.md](docs/user/INSTALL_MACOS.en.md).

**Run from source**: `git clone … && npm install && npm run build && npm start` (Node ≥ 20). Full
walkthrough: [QUICK_START.en.md](docs/user/QUICK_START.en.md). Key guides:
[API_KEYS.en.md](docs/user/API_KEYS.en.md). Troubleshooting:
[TROUBLESHOOTING.en.md](docs/user/TROUBLESHOOTING.en.md).

**Supported providers**: DeepSeek, Alibaba Cloud DashScope (CN/INTL), MiMo, Zhipu, Groq, Gemini,
Ollama, plus any OpenAI-compatible endpoint — see `shared/providerCatalog.ts` (single source of truth).

**License**: [Apache-2.0](LICENSE). The installers are not code-signed (`v1.0.0`) — download only from
this project's Releases page.