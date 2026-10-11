# MeetingAssistant v1.0.3

功能版本 · Linux 原生可用，做题模式的算法题终于能读了

> ⚠️ 安装包**未做代码签名**，Windows 会弹安全提醒；请只从本项目的 Releases 页面下载。
> ⚠️ The installers are **not code-signed**, so Windows will warn you. Download only from this project's Releases page.

---

## 中文

### 下载哪个

| 文件 | 类型 | 适合 |
|---|---|---|
| `MeetingAssistant-1.0.3-win-x64.exe` | 安装版（NSIS，当前用户，无需管理员） | 常规使用。从 v1.0.2 / v1.0.1 直接覆盖安装即可，设置与会话数据不会被删除 |
| `MeetingAssistant-1.0.3-win-x64-portable.exe` | 免安装版 | 不想安装、临时使用。首次启动需解压，比安装版慢几秒 |
| `MeetingAssistant-1.0.3-linux-amd64.deb` | Debian 包 | Ubuntu / Debian 用户**首选**。安装脚本会把 Chromium 沙箱组件配好（含 Ubuntu 23.10+ 的非特权命名空间限制） |
| `MeetingAssistant-1.0.3-linux-x86_64.AppImage` | 免安装单文件 | 其他发行版。`chmod +x` 后直接运行；它带不了上面那套沙箱配置，个别系统上起不来就改用 `.deb` |

Windows 两个包功能完全一致，共用 `%APPDATA%\MeetingAssistant\`；数据要随身携带时，启动前设 `MC_USERDATA`。
Linux 的配置目录是 `~/.config/MeetingAssistant/`。
macOS 本次**仍然没有**安装包，可从源码运行，见 [INSTALL_MACOS.en.md](INSTALL_MACOS.en.md)。

### 校验下载（SHA256）

每个产物旁边都有同名的 `.sha256`，内容是 CI 构建时算出的哈希。

```powershell
Get-FileHash .\MeetingAssistant-1.0.3-win-x64.exe -Algorithm SHA256
```

```bash
sha256sum -c MeetingAssistant-1.0.3-linux-amd64.deb.sha256
```

---

### 一、Linux 原生支持（这一版最大的变化）

以前只能在 Windows 上用，macOS 靠源码。这一版 Linux 是一等公民，并且是**打包发布**的：

- **听系统声音**走 PipeWire 环回，不用装虚拟声卡、不用「立体声混音」。原理是应用自己把当前播放设备的 monitor 端接上一条 `pw-record`，所以你听到什么它就转什么。缺 `pw-record` 时不会崩，会退回手动选输入设备，并在设置里写明为什么。
- **全局快捷键**在原生 Wayland 下注册不上（这是 Mutter 的限制，不是本应用的 bug），所以应用启动时会带 X11（XWayland）后端**自动重启一次**。想改回去：设置 → 界面 → 显示后端。
- **开机自启**写 XDG autostart 条目，逻辑与 Windows 的注册表项等价。
- 叠加窗在 Linux 上当前按**不透明**渲染。这是上游合成器的已知行为，透明度滑杆在 Linux 上因此看不出变化。
- 完整环境配置（含本地 ASR 的 Python 侧配方）见 [docs/linux/SETUP.zh-CN.md](../linux/SETUP.zh-CN.md)。

### 二、做题模式：算法题的回答现在是一块真正的代码

之前的算法题答案是**一段被压平的纯文本**：缩进没了、长行在手机上被拆成碎片、复制下来不能编译。这一版：

- 答案里的 ``` 围栏代码块渲染成**代码块**：等宽字体、语法高亮（内置一个只认关键字符号的小分词器，没有引入 highlight.js）、按语言标出文件名。
- **超长行默认不折行，左右横滚**看全行；每个代码块带三个按钮：**换行**（切软换行，续行会缩进，和新起的语句一眼能分）、**复制**、**下载**。桌面窗口和手机页面**两端一致**。
- 提示词也改了：算法题现在要求模型把代码放进带语言标签的围栏里、保留题目给定的函数签名、一个函数一个代码块，块外的说明只留「开头一句思路 + 结尾一行复杂度」。
- 手机是第二块屏，所以**做题子模式（行测 / 技术 / 性格 / 开放）和「再检查一遍」也进了手机控制栏**，在手机上切换，电脑窗口的徽章同步跟着变。不想给这两项权限：设置 → 通用 → 手机显示 → 允许远程控制里对应两项取消勾选。

### 三、答完题，AI 会自己复查一遍

技术子模式（以及自动识别出的编码题）答完之后，模型会**再读一遍自己的答案**，判断有没有错：

- 结论是一条**单独的卡片**出现在答案下方，按颜色分三种：「复核：没发现问题」（绿）、「复核：已订正」（黄，附修订稿，**原答案仍然保留在旁边可以对照**）、「复核未完成」（红，比如没配大模型 Key，会写明原因，原答案不受影响）。
- **它不会拖慢首答**：复核是在答案已经完整上屏之后才另起的一次往返，首答的出现时间不受这个功能影响。
- **题库直答的题不触发复核**——题库里已经是确定答案，再让模型挑错只会把确定性换成不确定性。这种题你仍然可以手动点「再检查一遍」。
- 手机上可以附一句「错在哪」的备注，复核会带着它去查。

### 四、三家国内大模型平台

新增 **Kimi / 月之暗面**、**硅基流动 SiliconFlow**、**火山方舟 Ark（豆包）**。配置步骤和原有平台一样，都是**选平台 → 填 Key → 填模型名**三步，模型名可以直接选内置的，也可以自己填：

| 平台 | 默认模型 | 备注 |
|---|---|---|
| Kimi / 月之暗面 | `kimi-k3` | 能读截图，所以做题模式一个 Key 就够；另有 `kimi-k2.7-code-highspeed` 出字更快 |
| 硅基流动 | `deepseek-ai/DeepSeek-V3` | 组织名/模型名形式；`Pro/deepseek-ai/DeepSeek-R1` 是可选项 |
| 火山方舟 | `doubao-seed-2-1-pro-260628` | 带日期版本号；也能填你自己创建的接入点 ID（`ep-…`）。模型要先在「模型广场」开通 |

**一个必须说的坑**：Kimi 把 `temperature` 按模型**固定**（`kimi-k3` 与 k2.7-code 系列固定 1.0，文档写明传入其他值报错）。本应用以前的请求体永远带一个 `temperature`，所以现在对 Kimi 的接口**不再发送这个字段**，让服务端用它自己的固定值——否则每一次作答、包括「测试连接」都会失败。SiliconFlow 与火山方舟没有这个约束，行为不变。

逐平台配置与拿 Key 的位置见 [API_KEYS.zh-CN.md](API_KEYS.zh-CN.md)。

---

### 安装包小了多少

这版删的都是**加载不到的文件**，每一条都有证据，不是猜的。

| 产物 | v1.0.2 | v1.0.3 |
|---|---|---|
| Linux 解包目录 | 994.7 MB（首个可用构建） | **349 MB（-64.9%）** |
| `linux-amd64.deb` | 无（v1.0.2 不发 Linux） | SIZE_DEB |
| `linux-x86_64.AppImage` | 无 | SIZE_APPIMAGE |
| `win-x64.exe`（NSIS） | 181.2 MiB | SIZE_WIN |
| `win-x64-portable.exe` | 181.1 MiB | SIZE_WIN_PORTABLE |

Windows 这一版少了 **503 MB 解包态的死重**：`onnxruntime-node` 一个 npm 包里同时装着 darwin、linux、win32 三套原生二进制，而运行时只解析 `bin/napi-v3/${platform}/${arch}` —— 也就是说 win32/x64 的包里有 65 MB darwin + 404 MB linux（CUDA、TensorRT 全在里面）+ 34 MB win32/arm64 是**永远读不到**的。v1.0.2 的 .exe 照样装了。另外提升到全局的与平台无关裁剪（浏览器版 ONNX Runtime、transformers.js 的浏览器构建、pdfjs 的浏览器件、只保留 zh-CN / en-US 两套语言包）合计约 158 MB，Windows 和 Linux 都吃到。

**功能没有因为裁剪受损**：每一项排除都有对应的验证（打包树里真实导入、相关单测在文件被移走后仍全过），发版前又在成品包上跑了 `tools/packaged-smoke.mjs` 与 `tools/linux-verify.mjs`。两条实测的否掉项也留在文档里：`@napi-rs/canvas` 看着只服务渲染，移走后 PDF **文本抽取**直接 `DOMMatrix is not defined`；`LICENSES.chromium.html` 那 19 MB 在 xz 之后只值 180 KB，删它是拿合规换零头。

### 回答链路快了多少

| 环节 | v1.0.2 | v1.0.3 | 口径 |
|---|---|---|---|
| 本地语音识别：说完 → 出字 | ~1850 ms | **872–882 ms** | 同一段录音 5 连播，5/5 转写正确；默认生效 |
| Linux：点 ▶ → 第一段音频 | ~575 ms | **211 ms** | 接线并行化 + 脏帧按值过滤 |
| 应用到首字（我们自己那一段） | 1–4 ms | **1–2 ms（p50）** | 离线 mock、零首字延迟、无需 Key；预算 50 ms |
| 句子结束 → 发出请求 | 固定等 1100 ms | 不变 | 投机作答已实现但**默认关闭** |

前两项是用户真正能感觉到的。第三项是本版新增的**回归门禁**：以后任何人把开销量改到 50 ms 以上，CI 直接红。
第四项为什么不动：投机作答在真实音频上的命中率、撤销率和重复计费增量都没测过，它影响的是你的账单，不该由一个默认值替你做决定。想试：**设置 → 通用 → 提前作答（实验）**。

答后复核那一次往返**不占首答的时间**（首答的 `done` 事件先发出，复核之后才启动），自身耗时随复核事件单独下发，日志里是 `[exam] check turn=… verdict=… ms=…`。

### 已知问题与本版没测的

- 没测的写在前面：**服务商真实 TTFT**（需要你自己的 Key）、**真机上「语音结束 → 首答可见」的墙钟**、**桌面 Electron 窗口里代码块的呈现**、手机页复核卡 20 秒自动收尾的体感。这几项本机条件不够，文档里标的是「待测」，没有当成已完成。
- 未签名、无自动更新（只有托盘里的手动检查）、本地转写需自备 Python 环境、macOS 无安装包、阿里云国际站与 MiMo 方案为 Beta、手机显示用自签证书、读题依赖本地 OCR 或视觉模型：与之前版本相同，逐条见 [RELEASE_NOTES_v1.0.0.md](RELEASE_NOTES_v1.0.0.md)。
- Linux 特有的两条边界写在上面第一节；起不来先看 [TROUBLESHOOTING.zh-CN.md](TROUBLESHOOTING.zh-CN.md) 第十三节。

---

## English

### Which file to download

| File | Kind | For |
|---|---|---|
| `MeetingAssistant-1.0.3-win-x64.exe` | Installer (NSIS, current user, no admin) | Normal use. Install straight over v1.0.2 / v1.0.1 — settings and session data are kept |
| `MeetingAssistant-1.0.3-win-x64-portable.exe` | Portable | No install. First launch unpacks, so it is a few seconds slower |
| `MeetingAssistant-1.0.3-linux-amd64.deb` | Debian package | **Preferred on Ubuntu / Debian.** The installer configures Chromium's sandbox helper, including on Ubuntu 23.10+ where unprivileged user namespaces are restricted |
| `MeetingAssistant-1.0.3-linux-x86_64.AppImage` | Single-file, no install | Other distros. `chmod +x` and run. It structurally cannot carry that sandbox setup — if it refuses to start, use the `.deb` |

The two Windows builds are functionally identical and share `%APPDATA%\MeetingAssistant\`; set `MC_USERDATA` before launch to carry your data along. Linux keeps its config in `~/.config/MeetingAssistant/`.
There is still **no macOS package** — run from source, see [INSTALL_MACOS.en.md](INSTALL_MACOS.en.md).

### Verifying the download

Every artifact ships with a matching `.sha256` computed by CI at build time.

```powershell
Get-FileHash .\MeetingAssistant-1.0.3-win-x64.exe -Algorithm SHA256
```

```bash
sha256sum -c MeetingAssistant-1.0.3-linux-amd64.deb.sha256
```

### 1. Linux is a first-class, packaged platform

System audio is captured through a PipeWire loopback — no virtual cable, no "stereo mix": the app links the monitor port of the playback device itself, so whatever you hear is what gets transcribed. Missing `pw-record` degrades to a manually chosen input device with the reason shown in Settings. Global hotkeys cannot register on native Wayland, so the app relaunches itself once under the X11 (XWayland) backend — change it under Settings → Interface → Display backend. Autostart is an XDG entry. Overlays render opaque on Linux (known upstream compositor behaviour), so the opacity slider has no visible effect there. Full environment setup, including the local-ASR Python recipe: [docs/linux/SETUP.md](../linux/SETUP.md).

### 2. Algorithm answers are real code blocks now

Fenced answers render as code blocks: monospace, syntax-highlighted by a small in-house tokenizer (no highlight.js dependency), labelled with the language. **Long lines are kept whole and scroll sideways**; every block carries **wrap** (soft wrapping where continuation lines are indented and stay one look apart from new statements), **copy**, and **download** — on the desktop window *and* on the phone. The prompts changed to match: code inside a tagged fence, the given function signature preserved, one block per function, and outside the fence only one line of approach plus one line of complexity. Because the phone is your second screen, the **exam sub-mode picker** and **再检查一遍 / re-check** are in the phone's control bar too, and the PC's badge follows.

### 3. The model re-reads its own answer

In technical mode (and on questions auto-detected as coding), after the answer the model checks itself. The result is a separate card under the answer, colour-coded: "no problem found" (green), "corrected" (amber — a revision comes with it and **the original answer stays visible beside it**), "check did not finish" (red, e.g. no LLM key; it says why and leaves the answer alone). It **never delays the first answer** — the check starts after the answer is fully on screen. Questions answered straight from the bank skip it on purpose: the bank holds a definite answer, and asking a model to find fault trades certainty for uncertainty. You can still press re-check, optionally with a one-line "what went wrong" note the check will look for.

### 4. Three mainland LLM platforms

**Kimi / Moonshot**, **SiliconFlow** and **Volcano Ark (Doubao)** join the existing ones, with the same three steps as every other platform: pick the platform, paste the key, choose or type the model name. Defaults: `kimi-k3` (reads screenshots, so one key covers exam mode; `kimi-k2.7-code-highspeed` outputs faster), `deepseek-ai/DeepSeek-V3`, `doubao-seed-2-1-pro-260628` (dated version; your own `ep-…` endpoint id works too, but enable the model in the Model Market first).

**One trap worth stating**: Kimi pins `temperature` per model — `kimi-k3` and the k2.7-code family are fixed at 1.0 and the docs say any other value is rejected. The app previously always sent a `temperature`, so for Kimi endpoints the field is now **omitted** and the server's pinned value applies. Without this, every Kimi call including 测试连接 would fail. SiliconFlow and Ark are unaffected.

### How much smaller the packages are

Everything removed this release is something the runtime cannot reach, with evidence per line rather than a guess.

| Artifact | v1.0.2 | v1.0.3 |
|---|---|---|
| Linux unpacked | 994.7 MB (first working build) | **349 MB (-64.9%)** |
| `linux-amd64.deb` | none (v1.0.2 shipped no Linux build) | SIZE_DEB |
| `linux-x86_64.AppImage` | none | SIZE_APPIMAGE |
| `win-x64.exe` (NSIS) | 181.2 MiB | SIZE_WIN |
| `win-x64-portable.exe` | 181.1 MiB | SIZE_WIN_PORTABLE |

The Windows payload dropped **503 MB of unreachable bytes**: one npm package (`onnxruntime-node`) carries darwin, linux and win32 natives, while the binding resolves `bin/napi-v3/${platform}/${arch}` — so a win32/x64 installer held 65 MB of darwin, 404 MB of linux (CUDA and TensorRT included) and 34 MB of win32/arm64 that no code path can ever load. v1.0.2 shipped all of it. The platform-independent trims promoted to the global list (browser-only ONNX Runtime, the browser builds of transformers.js, pdfjs' browser pieces, and shipping only zh-CN + en-US locales) account for roughly another 158 MB on both platforms. Nothing was lost to get there: each exclusion is verified by loading the packaged tree without it, and the built package was re-checked with `tools/packaged-smoke.mjs` and `tools/linux-verify.mjs`. Two tempting cuts were measured and **rejected** — `@napi-rs/canvas` (29.8 MB) turns out to carry PDF *text extraction*, which dies without it, and the 19 MB `LICENSES.chromium.html` costs 180 KB after xz.

### How much faster the answer path is

| Stage | v1.0.2 | v1.0.3 | Basis |
|---|---|---|---|
| Local ASR: speech end → text | ~1850 ms | **872–882 ms** | same clip played 5×, 5/5 transcribed correctly; on by default |
| Linux: ▶ → first audio frame | ~575 ms | **211 ms** | parallel link setup + value-based dirty-frame filter |
| App → first token (our own cost) | 1–4 ms | **1–2 ms (p50)** | offline mock, zero first-token delay, no key needed; budget 50 ms |
| Sentence end → request sent | fixed 1100 ms | unchanged | speculative asking implemented but **off by default** |

The first two are what a user feels. The third is a new **regression gate**: if any refactor pushes our own overhead over 50 ms, CI fails. The fourth stayed put because hit rate, retract rate and the duplicate-billing cost of speculative asking have never been measured on real audio — that change spends your money, so a default should not decide it for you. To try it: Settings → General → "Answer early (experimental)".

Not measured, and not claimed: real provider TTFT (needs your key), wall-clock "speech end → first answer visible" on a real machine, the same code block inside the desktop Electron window, and whether the phone's 20 s check-card timeout feels right. See section 13/14 of [TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md) for the Linux and exam-mode symptoms.
