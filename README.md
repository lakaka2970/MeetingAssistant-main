# MeetingAssistant 会议助手

[![CI](https://github.com/lakaka2970/MeetingAssistant-main/actions/workflows/ci.yml/badge.svg)](https://github.com/lakaka2970/MeetingAssistant-main/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> 实时会议 / 面试助手：一边流式转写对方的话，一边用 AI 生成你可以**照着念**的第一人称回答。
> Windows / macOS · 本地优先 · BYOK（自带 Key，没有账号系统、没有中间服务器）

Real-time meeting/interview assistant for Windows and macOS: streaming ASR captions of the other
party plus first-person AI answers you can read aloud. Local-first, bring-your-own-key, no bot joins
your meeting — it just listens to your system audio. 中文文档为主，English summary at the bottom.

---

## ✨ 核心功能

- **实时流式转写**：通过系统回环音频采集对方声音，**不碰会议软件**——Teams、Zoom、飞书、腾讯会议、任意视频都能用，不需要机器人入会、不需要抓包。
- **第一人称 AI 回答**：在对方任意一句上点 **⚡答**，右栏流式生成可直接照着念的回答；打开 **持续答** 后，只有真的在提问才会自动触发——明显的寒暄与流程安排（「把这个链接发我一下」）由本地启发式免费挡掉，拿不准的一句才花一次极小的分类调用判断，判定超时或失败一律回退成"照答"。
- **📝 做题模式（在线测评/笔试）**：标题栏 **做题** 打开一个**小窗悬浮面板**，它对录屏 / 共享 / 截图不可见（强制开启，无开关）。框选屏幕上的题目 → 读题 → **先查你本机的题库**：命中就直接把库里的答案和字母亮出来（**约 1ms，完全离线**），没命中才交给 AI，AI 也不确定时再按你的开关联网检索。四种题型各自绑定不同目录、各有答法：
  - **行测/申论**、**代码/技术**：绑定本地题库目录（递归读取 `.md/.txt/.json/.csv/.pdf`）。真题包常见的**「题目卷 + 答案卷」成对 PDF**（`…-学生版.pdf` / `…-答案版.pdf`，答案卷里是 `N.【答案】D。解析：…` 或 `1~5 BACDB`）会按 **(节, 题号)** 自动配对——**两卷的节名对不上时宁可不配**，绝不把英语的答案配到数量关系上；屏幕把选项打乱时，答案按**选项文字重新锚定**回字母。
  - **性格/心理测评**：先按"招聘方看重什么"生成一份**固定人设**（可用网络检索生成，也可手填），随后整场测评都照这份人设作答，并显式规避"全部非常符合"这类会触发装好/测谎校验的答法，反向表述的题自动把方向调转。
  - **精度优先的取舍**：只有「原题级命中 + 客观题 + 能锚定到屏幕选项」才会免模型直答；相近题会同时列出来让你确认；库里没有的题一律走 AI（并按需联网），不会硬凑一个答案。成堆下载来的题库必然互相重复：同一道题自动合并（保留解析最全的那份），**不同文件答案互相矛盾的题会被标成“答案不一致”而不是猜一个**；题干只是一句通用指令（如图形推理的「选择最合适的一项填入问号处」）时也不直答——真正的题在图里，文字认不出来。
  - **可以只绑一个总目录**：四个题型都指向同一个 `题库` 根目录也可以（本机是纯字面索引，多出的内容只会让候选变多，不影响命中速度）。代价是别的题型里的长篇资料可能作为「相近题」被列出来让你确认——它们永远不会被当成原题直接作答。
  - **读屏有两条路**：装 `npm i tesseract.js`（约 2MB 语言包，全离线）则截图先在本机识别文字，读不到题再交给视觉模型；没装就需要一个**支持图片的 API Key**（Gemini / 智谱 / Groq / 百炼 / MiMo / Ollama 等）。两者都没有时框选会直接说明缺什么，此时可用「题库自检」右侧的 **作答这题**：把题干粘贴进去，同样走 题库 → AI → 网络 的完整链路。
- **手机显示（局域网）**：设置里打开 **手机显示** 后，本机变成一个只在局域网里说话的网页服务，**手机浏览器扫码即看**——左边实时转写、上面大字显示当前答案（流式逐字、公式照常排版）。它挂在主进程的事件源上，**不经过界面窗口**，所以电脑这边可以彻底隐身、不开任何窗口，屏幕上没有任何东西会被共享或拍到。同时它也接管「**后台截屏答题**」：按下截屏热键 → 拍屏 → 读题 → **先查本机题库** → 答案直接出现在手机上，全程不用回头看电脑。延迟在这条链路上是显式量：手机上每次 ping/pong 校准两机时钟差后显示真实端到端毫秒数，设置面板显示线路延迟与「因手机跟不上而丢弃」的计数。
  - 配对走「**6 位配对码 → 长期令牌**」：配对码**只显示在这台电脑上**，绝不回传给发起请求的设备，所以同一局域网里别人无法自助连进来；令牌存在手机本地，之后免配对直连。
  - 默认 HTTPS（自签证书）：一是加密局域网这一段，二是手机浏览器的 **屏幕常亮 API 只在安全上下文存在**，明文 http 下手机亮到一半就息屏。手机首次访问会提示证书不受信任——**只有报 `ERR_CERT_AUTHORITY_INVALID` 时**才有「高级 → 继续前往」可点；连接窗里备了一颗 **「改用 HTTP」** 按钮，专治那些不提供绕过入口的安卓浏览器（代价是手机不能保持常亮，按钮旁写明了）。也可以下载 `/server.crt` 装进信任列表彻底消除警告。自签证书**挡得住被动嗅探，挡不住主动中间人**，仅限可信局域网。
  - **Windows 防火墙**：第一次监听端口时系统会弹窗，请允许「专用网络」；拒绝后手机会一直连不上而电脑侧毫无异常。
- **回答可控**：`答:中 / 答:EN` 切换回答语言；`纯文本 / 多模态` 在文本大模型与视觉模型（可**截图提问**）之间切换。
- **公式与排版正常显示**：回答里的 `$…$` / `$$…$$` / `\(…\)` / `\[…\]` 由 KaTeX 排版（含 `$ … $` 这种两端带空格的写法），`**加粗**`、`*斜体*`、`` `代码` ``、`### 小标题` 也直接渲染，不再把 markdown 原样吐在屏幕上。
- **贴合你的阅历**：右栏 **📄简历 / 📋JD** 导入资料（`.md/.txt/.docx/.pdf`），本地解析、本地建立索引，只在提问时作为上下文发给大模型——资料本身不离开你的电脑。不同面试是不同的会话，各自绑定自己的资料与答案库。
- **提前准备的答案优先亮出来**：资料或笔记里写成 `问：… 答：…` / `Q: … A: …` / `【问题】…【回答】…` 的段落会被自动识别成问答对并按「问题」建索引。面试官的问题命中时，右栏**先原样显示你准备的答案**（本地检索，几十毫秒内可见），再由 AI 在其基础上充实成可以直接念的完整回答——这条路径完全离线。
- **知识库没有答案才联网**：只有本地知识库毫无命中时，才会把问题发给你自己配置的搜索引擎（Tavily / Brave / SerpAPI，BYOK，默认关闭），检索结果作为回答依据并附上来源；一次检索最多等 2.5 秒，超时即放弃、绝不影响出词。
- **会话可删除**：右栏 🗑 删除整场对话（对话、转录、已索引的简历/JD 与其准备答案一并清除，有二次确认）。
- **本地优先**：默认语音识别是本地 FunASR，音频**不出本机**；云端方案（阿里云百炼等）只在你自己配置后才会发送音频。
- **隐身模式**：`隐身开/关` 让窗口对录屏 / 屏幕共享 / 截图不可见（Windows 有效，macOS 尽力而为），窗口默认也不出现在任务栏——隐藏后用快捷键（默认 `Control+B`）或系统托盘找回。
- **BYOK 隐私边界**：API Key 用系统加密存储在本机；没有账号、没有服务器、不代收任何费用，费用直接付给服务商。
- **为普通用户设计**：首次启动 5 步配置向导（含方案卡片、图文 Key 教程、声音检测、**真实连接测试**，14 个统一错误代码）；状态栏芯片一眼看清转写 / AI / 声音是否可用；诊断报告不含 Key、转写与简历内容，可直接贴进 issue。
- **中英双语界面**：向导里选择语言，应用启动即用该语言；系统托盘提供「开始 / 停止转写 / 新建会话 / 设置 / 服务状态 / 帮助与教程 / 检查更新 / 退出」。

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

## ⚡ 快速开始（普通用户）

全程不需要安装 Node.js / Python，也不需要敲命令（本地转写才需要自备 Python，见下文）。

1. 从 [Releases 页面](https://github.com/lakaka2970/MeetingAssistant-main/releases/latest) 下载
   `MeetingAssistant-<版本>-win-x64.exe`（安装版）或 `...-portable.exe`（免安装版）；
   建议核对旁边的 `.exe.sha256` 校验文件。
2. 启动后跟着 **5 步配置向导**走：欢迎 → 选择方案 → 配置服务（粘贴 Key 并「保存并测试连接」）→ 连接测试（检测电脑声音）→ 完成。
3. 播放会议 / 视频，点标题栏 **▶ 开始**，左栏「转录」开始出字。
4. 在对方那句上点 **⚡答** 生成回答；打开 **持续答** 自动接话；在右栏导入 **📄简历 / 📋JD** 让回答贴合你的经历。

> Windows SmartScreen 会提示「已保护你的电脑」——当前为未签名 Beta，确认来源后点「更多信息 → 仍要运行」即可。

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

点 **双屏** 会立刻弹出一个**连接窗口**：大二维码、可复制的地址、6 位配对码、已配对设备与在线状态。手机扫码 → 输配对码 → 连上后这个窗口自己收起、主窗随之隐藏。之后要再看二维码，点标题栏的 **双屏**（已在双屏时再点一次就是重新呼出），或 **设置 → 手机显示 → 打开连接窗口**。

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
   然后按 `Ctrl+Shift+S`（整屏，默认）或 `Ctrl+Alt+S`（弹小窗拖框选区）——拍屏、读题、
   **先查本机题库**、答案直接出在手机，电脑这边不弹任何窗口。
   读题这一步需要**视觉模型**或本地 OCR：两者都没有时，链路会直接告诉你缺哪一个，
   而不是默默给你一个空答案。用 DeepSeek 的话，视觉模型选 **DeepSeek 视觉·v4.1-flash**
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
npm install        # postinstall 会应用 patches/（transformers.js 补丁，勿删）
npm run build
start.bat          # Windows 一键启动（自动构建），或 npm start
```

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
本地提交前可跑 `npm run verify`。诊断问题：应用内 **设置 → 高级设置 → 诊断信息** 生成不
含敏感内容的诊断报告，可随 issue 提交。

## 📚 文档索引

| 文档 | 说明 |
|---|---|
| [QUICK_START.zh-CN.md](docs/user/QUICK_START.zh-CN.md) / [EN](docs/user/QUICK_START.en.md) | 面向普通用户的五步快速开始 |
| [API_KEYS.zh-CN.md](docs/user/API_KEYS.zh-CN.md) / [EN](docs/user/API_KEYS.en.md) | 各服务商 Key 领取教程 |
| [TROUBLESHOOTING.zh-CN.md](docs/user/TROUBLESHOOTING.zh-CN.md) / [EN](docs/user/TROUBLESHOOTING.en.md) | 错误代码表与排查指南 |
| [INSTALL_WINDOWS.zh-CN.md](docs/user/INSTALL_WINDOWS.zh-CN.md) / [EN](docs/user/INSTALL_WINDOWS.en.md) | Windows 安装说明（含 SHA256 校验） |
| [INSTALL_MACOS.en.md](docs/user/INSTALL_MACOS.en.md) | macOS 从源码安装与 BlackHole 音频路由 |
| [docs/windows/SETUP.md](docs/windows/SETUP.md) / [zh-CN](docs/windows/SETUP.zh-CN.md) | Windows 平台完整配置（Python / 本地 ASR） |
| [docs/macos/SETUP.md](docs/macos/SETUP.md) | macOS 平台完整配置 |
| [RELEASE_NOTES_v0.2.0-beta.1.md](docs/user/RELEASE_NOTES_v0.2.0-beta.1.md) | 版本说明与已知问题 |

## 📄 开源许可

[Apache License 2.0](LICENSE)

---

## English

**MeetingAssistant** is a real-time meeting / interview assistant for Windows and macOS. It captures
the other party through **system loopback audio** (no bot, no integration—works with any meeting app),
transcribes it with streaming ASR, and generates **first-person answers you can read aloud**, powered
by your own BYOK (bring-your-own-key) LLM provider. It is local-first: the default ASR backend
(FunASR) runs on your machine and audio never leaves it unless you configure a cloud provider.

**Highlights**

- Streaming ASR: local FunASR (default), Alibaba Cloud Bailian realtime (recommended cloud), MiMo, experimental MOSS-Transcribe-Diarize, offline Whisper fallback
- Per-line ⚡Ans answers + 🎤 optional mic channel; text (`纯文本`) or multimodal/vision mode with screenshot Q&A
- Knowledge panel: import your resume/JD (`.md/.txt/.docx/.pdf`), parsed and indexed locally, only sent to your LLM as context when asking; each session is one interview with its own material
- Prepared answers surface first: `问：… 答：…` / `Q: … A: …` / `【问题】…【回答】…` blocks in your documents or notes are auto-detected and indexed by question; on a hit the pane prints your prepared answer verbatim (local, tens of ms) and the AI only enriches it — no network on that path
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

**License**: [Apache-2.0](LICENSE). This is an unsigned beta (`v0.2.0-beta.1`) — download only from
this project's Releases page.