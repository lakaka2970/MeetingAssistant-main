# MeetingAssistant 优化计划（包体 / 延迟）

> 分支：`feat/linux-support`　基线版本：v1.0.2
> 所有数字均为本机实测（Ubuntu 24.04 / GNOME Wayland / PipeWire 1.0.5 / Electron 41.1.1）。
> 复测工具：`node tools/asar-report.mjs`（包体构成）、`node tools/linux-verify.mjs`（功能 + 启动时序，8 项在本机会话可断言，另 2 项只在 Wayland 会话生效）。

## 0. 基线

打包产物 `release/linux-unpacked`（`npx electron-builder --dir --linux`）：

| 组成 | 基线 | 优化后 |
| --- | --- | --- |
| **合计** | **994.7 MB** | **349 MB（-64.9%）** |
| `resources/app.asar` | 140.2 MB | 52.3 MB（S9/S10 后逻辑体积 114.6→95.9 MB） |
| `resources/app.asar.unpacked` | 558.7 MB | 62.8 MB |
| └ `onnxruntime-node` | 469.1 MB | 21.3 MB |
| └ `@huggingface/transformers` | 32 MB | 10.4 MB |
| `locales/` | 46 MB | ~1.5 MB（zh-CN + en-US） |
| Electron 运行时（`meeting-assistant` + pak/GL/icu） | ~253 MB | ~251 MB（未动） |

音频与启动（基线）：`LinuxLoopbackCapture.start()` 405 ms（7 次串行 `pw-link`）+ 首帧 150 ms +
固定 500 ms 起始静默丢弃 ⇒ **▶ 到第一段音频 ~575 ms**；帧粒度 1024 样本 / 64 ms
（由 `clock.quantum=1024` 决定，`--latency 100/50/20/10` 实测无效）。

答题链路既有常量：VAD `hangoverMs=300` / `minSpeechMs=250` / `preRollMs=300` / `maxSegmentMs=10000`；
worker `PARTIAL_INTERVAL_MS=1400` / `RING_MS=300` / `STREAM_IDLE_CLOSE_MS=10000`；
连续回答防抖 `1100 ms`（`src/App.tsx`）与模型 gate 并行；`GATE_TIMEOUT_MS=1200`；`SPEC_DEBOUNCE_MS=300` / `SPEC_REUSE_WAIT_MS=400`。

---

## 1. 包体（已完成）

| ID | 动作 | 收益 | 证据 / 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| S1 | 排除 CUDA + TensorRT provider | **-327 MB** | `shared/platform.ts` 在 Linux 只要 `['cpu']`、Windows 只要 `['dml','cpu']`；打包树里 `find -name "*jsep*"`/provider 已为空，`linux-verify` 10/10 | ✅ |
| S2 | 排除跨平台残留：`napi-v3/{darwin,win32,linux/arm64}`、musl 版 canvas 与 libvips | **-142 MB** | `app.asar.unpacked` 558.7→83.5 MB | ✅ |
| S3 | `electronLanguages: [zh-CN, en-US]` | **-44 MB** | `locales/` 从 ~50 个 .pak 剩 2 个 | ✅ |
| S4 | 排除 `onnxruntime-web`（52 MB wasm + 各 ort.*.js 变体） | **-66 MB** | `transformers.node.mjs` 里 ort-web 被 webpack 标为 `(ignored)`；打包树中导入 `transformers.node.mjs` 成功（真实 Electron 主进程，非 `RUN_AS_NODE`） | ✅ |
| S5 | 排除 `libonnxruntime.so.1.21.0`（binding 的 DT_NEEDED/RUNPATH 只指向 `libonnxruntime.so.1`） | **-21 MB** | `readelf -d` 实测 + `ldd` 在打包树内解析成功 | ✅ |
| S8 | 排除 transformers 的 jsep wasm（dev 树名 `jsep.wasm`，打包树名 `ort-wasm-simd-threaded.jsep.wasm`，两种拼写都列） | **-21 MB** | node bundle 中 `ort-wasm`/`jsep` 引用数为 0；移走文件后导入与 spec 均通过 | ✅ |
| S7 | 排除 `pdfjs-dist/build`、`web`（pdf-parse 实际 import `pdfjs-dist/legacy/build/pdf.mjs`） | **-8 MB** | 移走两目录后 `docparse.spec.ts` + `globalKnowledgeImport.spec.ts` 14 项全过 | ✅ |
| S9 | 排除 PDF 树里剩余的浏览器件：pdf-parse 的 `dist/pdf-parse/web`、`dist/worker`，pdfjs 的 `legacy/web`、独立的 `image_decoders`/`legacy/image_decoders`/`wasm`、`pdf.min.mjs`/`pdf.worker.min.mjs`/`pdf.sandbox*.mjs` | **-13 MB**（解包态 368→355 MB） | 十个路径一次移出 node_modules（24 MB）后 `docparse` + `globalKnowledgeImport` + `knowledgeFiles` 19 项全过，装回后复跑仍全过。`grep -rl image_decoders node_modules/pdfjs-dist` 在这两个目录自身之外零命中，`legacy/build/pdf.worker.mjs` 内联了 OpenJPEG/JPX（13 处命中）⇒ 扫描版/JPEG2000 PDF 不靠那两个目录 | ✅ |
| S10 | 排除 `@huggingface/transformers` 的 6 个浏览器构建（`transformers.js`、`.min.js`、`.web.js`、`.web.min.js`、`node.min.mjs`、`node.min.cjs`） | **-6 MB**（解包态 355→349 MB，asar 逻辑体积 -6 MB，deb 只 -0.4 MB） | 两个 Node 构建里对这 6 个名字的引用数为 0；移走后按 `engine.ts` 的同一套 `require.resolve` + 动态 import 仍加载成功（856 个导出，`env` 在场），`verify:patched` 通过。**`transformers.node.cjs` 必须保留**：它是 `engine.ts:129` / `embedWorker.ts:26` 的定位锚点 | ✅ |
| S11 | ~~排除 `@napi-rs/canvas`（29.8 MB skia 预编译）~~ | **实测后取消** | 移走 `canvas-linux-x64-gnu` 后 pdfjs 只 warn `Cannot load "@napi-rs/canvas"`，但紧接着 `ReferenceError: DOMMatrix is not defined`（`src/display/canvas.js:63`），docparse 与知识导入两条 PDF 用例双双失败。文本抽取路径依赖它，不只是渲染 | ❌ 不做 |
| S12 | Windows 侧排除 `onnxruntime-node/bin/napi-v3/{darwin,linux}` 与 `win32/arm64` | **解包态 -503 MB**（darwin 65 + linux 404 + win32/arm64 34） | `dist/binding.js` 只 `require('../bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node')`，另外三棵树在 win32/x64 上没有任何代码路径能到；这个 tarball 在任何宿主上都装着全部三个平台，所以不是本机现象。`win32/x64` 只有三个文件（binding 280 KB、onnxruntime.dll 16 MB、DirectML.dll 18.5 MB）且整个保留。平台级 `files` 会替换全局，所以 `win.files` 重列了全局清单——`test/packagingFiles.spec.ts` 钉住这三件事：正向着陆、全局排除一条都不能掉、任何排除不得命中自己平台的 binding | ✅ |
| S6 | ~~排除 `LICENSES.chromium.html`（19 MB）~~ | **实测后取消** | 19.13 MB 原文 → **xz -9 后 180 KB**（deb 与 AppImage 的 squashfs 默认都是 xz），gzip 也只有 2.1 MB。它只在解包目录里显得大，在用户下载的产物里近乎零成本；而它是 Chromium 及大量第三方组件的许可声明，删掉是拿合规换 0.18 MB。**保留。** | ❌ 不做 |

实施要点（踩到的坑，写进配置注释）：

- **平台级 `files` 会整体替换全局 `files`，不是合并。** 只写负向 pattern 会丢掉正向的 `out/**`，
  electron-builder 回落到"全收"，实测把 308 个条目（含 6.5 MB 演示视频、README.pdf、测试夹具）塞进 app.asar。
  因此 `linux.files` 完整重列了全局清单再追加 Linux 专属负向项，两处需同步维护。
- 与平台无关的裁剪（S3/S4/S7/S8/S9/S10，合计 ~158 MB 解包态）在全局 `files` 里，Windows 也吃到；
  Windows 真正的大头是 S12——`onnxruntime-node` 一个包里带着三个平台的原生二进制，而
  `dist/binding.js` 只解析 `bin/napi-v3/${platform}/${arch}`，所以 v1.0.2 的 .exe 里白装了
  darwin 65 MB + linux 404 MB（CUDA/TensorRT 都在里面）+ win32/arm64 34 MB = **503 MB**。

## 2. 延迟

| ID | 动作 | 结果 | 状态 |
| --- | --- | --- | --- |
| L2 | 环回接线并行化（`pw-link -i`/`-o` 并发、disconnect/connect 各一批并发、校验改为轮询而非固定 sleep），并去掉 `start()` 里固定的 150 ms 存活等待 | **▶→首帧 575 ms → 211 ms**（`linux-verify` 断言 <400 ms，已在 CI 口径内） | ✅ |
| L3 | 起始脏帧改为按值过滤（非有限值或 \|sample\|>1 即丢），窗口 1 s，替代固定 500 ms 全丢 | 与 L2 合并生效；4 个新单测覆盖（满幅±1 合法、1.09 判脏、窗口关闭后不再过滤） | ✅ |
| L5 | 推测检索未命中时并行发起真实检索 | **分析后放弃**：`specCache.get()` 返回 null 时本就不等待，400 ms 窗只在"推测确已在飞行"时才付，而此时它比冷启动更可能先完成。并行会让每次答题多跑一遍 embed+检索，本地 CPU 代价换不到稳定收益 | ❌ 不做 |
| L7 | 启动期把 sidecar / RAG 预热推迟 | **实测无效**：本地(拉起 Python sidecar) vs 云端(不拉起) 三次对比，热键就绪 422/428/430 ms 与 430/438/444 ms 基本一致；sidecar 在热键之后才 spawn。单次测出的 300 ms 差是噪声 | ❌ 不做 |
| L1 | desktop 条目 Exec 带 `--ozone-platform=x11`，取消运行时自重启 | **实测后不做**。成品包现在能构建（见 §9），机制查清了：`AppImageTarget` 自己拼 Exec（`[AppRun, …(executableArgs ?? defaultArgs), '%U']`），deb 走 `linux.executableArgs`，两处都能注入静态 flag。但静态 flag 会**盖掉用户在设置里选的 `ui.displayBackend`**（wayland 那档就永远到不了），而自重启只付一次、且在窗口出现之前。本机这轮打包验证跑在 `XDG_SESSION_TYPE=x11` 的会话里，重启分支根本没触发；Wayland 会话里仍是那 ~190 ms | ❌ 不做 |
| L4 | ~~连续回答 1100 ms 防抖改自适应~~ → 改为**投机发送 + 可撤销**（见 §5 实测） | 数据推翻了原方案：本地链路开销只有 1–4 ms，防抖的 1100 ms 不是"省成本"而是纯等待。正确做法是句子一关闭就发起请求并在需要时 abort，而不是猜一个更短的等待时间 | 🔧 待实施 |
| L6 | partial 间隔可配（云端 700~900 ms） | 未做：收益（字幕跟手感）只能连真实引擎评估 | ⏸ 需线上环境 |

**不动项**：VAD `hangoverMs`/`preRollMs`（再低会切字）、PipeWire 量子（调 256 换 CPU 与爆音风险，而它只占 64 ms，远小于 300 ms 挂起）。

## 3. 当前启动时序（打包态，三次中位数）

```
187 ms  读 settings.json → 决定显示后端 → 自重启
430 ms  全局热键注册完成（XWayland）
455 ms  托盘创建
339 ms  PipeWire 环回判定可用
211 ms  ▶ → 首个 PCM 帧抵达 ASR 宿主
```

## 4. 验收口径

每步改动都要满足：`npm run typecheck` && `npm test`（当前 **1055** 个测试）&&
`node tools/linux-verify.mjs` **8/8**（Wayland 那两条在非 Wayland 会话里按设计 SKIP），包体改动另附
`node tools/asar-report.mjs` 前后对比，答题链路改动附 `npm run latency:local`（离线门禁，TTFT p95 ≤ 50 ms）。

尚不能在本机验证的：本地 Whisper 实际推理（未下载 ~1.5 GB 模型）、云端 ASR/LLM 往返。
这些在文档中标为 ⏸，不应被当作已完成。

（2026-10-03 更新：AppImage / deb 成品包已能构建并实测通过，见 §9。）

## 5. 答题链路实测（2026-10-02，本地 mock provider）

方法：`tools/mock-llm-server.mjs` 提供延迟已知的 SSE 服务，生产适配器 `electron/llm/adapter.ts`
直接打过去（`tools/latency-local.sh`，已固化为回归门禁，预算 50 ms）。这样能把"我们自己的开销"
从"网络 + 服务商"里干净地剥出来——不需要 API Key，也没有链路抖动。

| 场景 | TTFT（首字） | 说明 |
| --- | --- | --- |
| gate（376 字提示） | min 1 / p50 2 / p95 14 ms | 14 ms 是首次调用的 JIT/连接预热 |
| answer-short（62 字） | min 0 / p50 1 / p95 2 ms | |
| answer-context（432 字） | min 0 / p50 1 / p95 1 ms | |
| 线性校验（mock 首字 300 ms、每 chunk 40 ms） | 测得 303 ms；总 746 ms ≈ 300+11×40 | 偏差 3–6 ms，即适配器全链路开销 |
| 提示词组装 `buildAnswerMessages`（最坏 1.58 万字 / 16 条消息） | **0.032 ms/次** | 稳定前缀约 1.15 万字 |

结论：**应用侧从"拿到句子"到"开始收字"只花 1–4 ms**，最坏情况的提示词组装也可以忽略。
因此答题链路上余下的延迟只有两个来源——服务商往返，以及我们自己设的定时器。

由此推翻原 L4 方案。`src/App.tsx` 现在是"句子关闭后固定等 1100 ms 再发请求"（gate 已与之并行）。
既然发请求本身不要钱似的花 1 ms，等 1100 ms 就不是在省成本，而是在拿用户体验换"句子可能还没说完"的确定性。
正确的做法是把它反过来：

- 句子一 `segment`（且 `reason === 'silence'`，不含 maxlen 截断）就**立即发起**回答请求；
- 保留现有 `heuristic()` 的 skip 判断，明显是寒暄/残句的直接不发；
- 若在窗口内又来了一句把问题接续上了（例如"...是怎么安排的" 后面跟 "能具体说说吗"），
  用 `chatStream` 已支持的 `AbortSignal` 撤销旧请求、发新的（主进程已有 requestId 语义可复用）；
- gate 保持并行，但预算要跟着重定：1200 ms 现在是纯 provider 时间，且不再被防抖遮住——
  超过较小预算（如 600 ms）就直接播答案，因为 gate 失败本来也是回落"照答"。

代价与边界（必须先同意再动手）：残句会造成**重复计费**（一次 abort + 一次重发）；
被 abort 的请求仍可能产生上游费用；对连续快问快答的场景需要限流，避免同一时刻挂着多个未完成请求。
这条改动会影响用户看到的实际花费，属于需要产品决策的变更，不由我单方面落地。

仍未测到、也不假装测过的：
1. **服务商真实 TTFT**：需要 Key 只经使用者本人的 shell（我的执行策略禁止我在命令里使用凭据）。
   命令：`read -rs MC_LLM_KEY && export MC_LLM_KEY && npm run latency:llm -- --runs=9`
2. **语音→文字的端到端**：本机没有 FunASR 依赖与 Whisper 模型，这段只能等环境就绪后实测。

### 2026-10-11 新增：答后复核回合与代码块显示

**结构结论（by construction，无需测量）**：算法题答完会自动追加一轮模型自查。主进程
（`electron/main.ts`）把自动回合放在 `send({ kind: 'done', text, origin, ms })` **之后**，
以 `void runExamCheck(...)` 启动、不等待——`done` 与它携带的 `ms` 在复核开始前已经定稿，
所以**首答的出现时间不受这个功能影响**。复核自身的时长随 `check` 事件的 `ms` 字段下发，
并记进日志：

```
[exam] check turn=… verdict=… ms=… chars=…
```

它**不会回填进作答记录的 `ms`**——`done` 早已发出，那份 `ms` 定稿时只有 read/bank/model/total
四段，不存在复核字段。
复核与答案走同一个 `chatStream`→同一个适配器，上文实测的应用侧开销（1–4 ms）同样适用；
但它的提示带着整题与整答，provider 侧耗时按"至少一次长答案往返"的量级预期——这是推理，
不是实测。题库直答不触发复核，日志里不会出现任何 `check` 行。

**代码块显示实测（条件：手机页 `resources/companion/`，临时 node http 静态服务直挂 + 浏览器
量取，非 Electron；2026-10-11，558 px 宽视口；样本＝一条 120 列 C++ 长行 + 一个空行 +
一行 4 空格缩进）**：

- 默认态：`white-space: pre`、`overflow-x: auto`、`scrollWidth 1229 > clientWidth 534` → 真的横向可滚，
  长行不再被拆成 identifier 碎片
- 空行不塌：`span.code-line` 实测高 22 px
- 点「换行」后：`aria-pressed=true`、`white-space: pre-wrap`、逐行块 `display:block`、
  `text-indent −19.264px / padding-left 19.264px`（=1.4em 悬挂缩进）；同一长行首行文字左边缘
  从 x=23 起、软换行续行从 x=43 起，而新的源行仍从 x=23 起 → 续行与新语句可区分
- 点「换行」不会触发 hero 折叠（`collapsed` 前后都是 false）

这组数字没有覆盖的：桌面 Electron 窗口里同一代码块的呈现、真机手机浏览器与触摸交互。**待测**。

**待测清单（5 道真算法题，记录机器、provider 与模型名后填入）**：

```bash
npm run latency:llm   # provider TTFT；Key 只经使用者本人的 shell（命令见本节开头）
npm run dev           # 另一终端；做题窗口跑五道算法题，从日志里抄两类行：
                      #   [exam] technical model in <N>ms (read=… bank=… model=…)  ← 首答 ms.total
                      #   [exam] check turn=… verdict=… ms=<N> chars=…           ← 每个复核回合自身耗时
```

每题填三列，填的时候连同条件一起写（本机 / 哪个模型 / 桌面还是手机）：

| # | 首答 `ms.total` | 复核回合 `ms` | 墙钟：语音结束→首答可见→复核卡可见 |
| --- | --- | --- | --- |
| 1–5 | 待测 | 待测 | 待测 |

另两项数字量不了、同样待测：手机页复核卡的 20 s 空闲超时（`CHECK_IDLE_MS`）收卡在真人
感受上对不对，以及桌面 Electron 窗口的复核卡是否如设计先出首答、后出复核卡。

## 6. L4 草案已落地（默认关闭，待评审）

`shared/speculativeAsk.ts`（纯逻辑）+ `src/App.tsx` 接入 + 设置项 `llm.speculativeAsk`
（通用页「提前作答（实验）」，**默认 off**）。

设计取舍：

- 只在 `heuristic().verdict === 'answer'`（句子明显完整）时立即发问——这正是
  `questionGate.ts` 文件注释自己的主张："明显的问题不该再花一次模型往返"。
- 后续句子若判定为**同一句被切碎**，则 `llmCancel` 撤销并按合并后的整句重发，
  并复用同一个 turn（不新增一行，避免屏幕上闪出两个答案）。
- 判据保守：前句无句末标点 / 新句是连接词引导的残句 / 新句短到不能独立成问，
  三者之一才算续接；「这个方案上线了吗？」+「还有灰度是怎么做的？」被判为两个问题，
  因为合并会把两个都不完整的问题拼成一个更糟的复合问题。
- 任何不确定的情况一律退回原有的 1100 ms 折叠窗，所以**猜错的最坏结果等于今天的默认行为**；
  且 speculativeAsk 关闭时代码路径与今天完全一致（planAsk 提前返回）。

已验证：`test/speculativeAsk.spec.ts` 19 项（续接判定 6 项、计划 12 项、簿记 1 项）、
`npm run typecheck`、**1053 个单测全绿**、打包态启动 8/8 通过 + 1 项按会话条件跳过
（本机当前 shell 是 X11 会话，热键照常注册，反向印证了 §2 的后端结论）。

第二阶段补掉了草案自己的三个缺陷：

1. **`reason` 已打通**：VAD → `PendingSegment` → worker 事件 → `asrHost` →
   `TranscriptSegment.reason`（可选字段，旧会话文件与"服务自带 final"的引擎为 undefined），
   所以 `flush`（正在停止采集）不会再被投机发起或合并——那是一句没人会看答案的请求。
2. **已上屏的答案绝不撤销**：`InFlightAsk.streamed` 在首个 delta 到达时置位；
   撤销一行用户正在读的文字比省下 1100 ms 更糟，而且那一次调用的钱已经花出去了。
3. **撤销有预算**：`SPEC_MAX_RETRACTS = 2`。连续被切碎的句子（「你们…」+「那个…」+「上线…」）
   每次合并都是一次废弃请求，超过预算后就照现有内容作答。

仍未验证（评审时必须知道）：真实音频流上的投机命中率与撤销率、重复计费的实际增量。
这两项需要一台接好 ASR 引擎（Python 依赖或已下载的 Whisper 模型）的机器，
因此这一版仍应作为可开可关的实验，不应默认启用。

## 7. 本地 ASR 打通后的实测（2026-10-02）

Python 环境按 §docs/linux/SETUP 的配方建好（`.venv`，CPU 版 torch/torchaudio，
`transformers>=4.44` 下界），`npm run smoke:e2e:local` → **E2E_LOCAL_OK**：
应用自己发现 `.venv/bin/python`、拉起并回收 sidecar、连上 `ws://127.0.0.1:10097`、worker 就绪。
真实链路（PipeWire 监听 → VAD → sidecar → 出字）用打包态 + `MC_E2E_LOOPBACK` 播放测试语音实测：

| 指标 | nano（默认） | paraformer 流式 |
| --- | --- | --- |
| 语音结束 → segment 事件（e2e） | 1796–1947 ms | 1826–1968 ms |
| 转写正确性 | 「测试。」/ "test" ✅ | 「测试。」/ "test" ✅ |
| 首次就绪（含模型下载） | ~2.1 GB | ~880 MB |
| 环回 ▶ → 首个 PCM | 194–201 ms | 同 |

两个结论：

1. **`requirements-funasr.txt` 在干净 Linux 上装不起来**，两处都是硬失败（已修文档并给出可复现配方）：
   `transformers` 被解析到 4.12.2 → `tokenizers==0.10.3` 需 Rust 源码构建；
   torch/torchaudio 默认拿 CUDA 变体，无 NVIDIA 机器上 `import torchaudio` 直接报缺
   `libcudart.so.13`。这属于"包体/依赖"之外的可用性缺口，值得单独做平台化的 requirements 或安装脚本。
2. **~1.85 s 的 ASR e2e 与模型无关**（两个引擎差在噪声范围内）。VAD 挂起只有 300 ms，
   因此剩下 ~1.5 s 不是推理速度，而更可能是链路上的固定偏置——重点怀疑
   `speechEndTs` 的重建方式（`epoch + endMs`，epoch 取自段起始的 `captureTs`）与实际墙钟的偏差，
   以及流式引擎 final 的到达时机。**在拆穿这 1.85 s 之前，它比 1100 ms 防抖更该优先处理**：
   它是用户最先感受到的那段时间，而投机作答只是在其之上再省 1.1 s。

因此下一步顺序调整为：先定位 ASR e2e 的构成（P0），再评估投机作答的命中率（P1，需真实语音），
参数化 partial 节奏（P1），最后才是打包产物相关（L1/S6 已判定不做）。

## 8. §7 那个 ~1.85 s 的拆解结果（2026-10-02 已解决）

新增 `tools/latency-asr-local.sh`：用已知录音驱动真实链路（PipeWire 监听 → VAD → sidecar →
出字），并打印 sidecar 侧的端点化等待与解码耗时，把这条链彻底拆开。

**§7 的猜想是错的。** `speechEndTs = epoch + endMs` 的重建偏差实测只有 **3–65 ms**，
不是 1.5 s。真正的构成是：

| 组成 | 修复前 | 说明 |
| --- | --- | --- |
| sidecar 端点化等待 | 1200–1800 ms | 静默按整块 600 ms 累加，700 ms 阈值永远要等第二块 |
| 整句 CPU 解码 | 600–1900 ms | 与输入长度正相关，机器负载敏感 |
| 应用自身 | ≈ 0 | 诚实时钟与旧算术对齐后确认 |

三步修复，每步都带实测：

1. **端点化粒度**：块内改按 100 ms 回溯扫描。`silenceAtTrigger` 达到 700 ms，最好一枪
   e2e 1791 → 1299 ms；句子切分也修好了（原先两次播放被并成一句 11.4 s 的「测试测试」）。
2. **让本地 VAD 来 finalize**：VAD 挂起只有 300 ms，它早就判定"这人说完了"，原先只是发一条
   `status`。改成在 VAD 关闭时结束会话、由下一句的 speech-start 用 300 ms 前滚缓冲重开会话。
   **实测 5 连播 e2e 872–882 ms（原 ~1850 ms），5/5 转写正确。**
   代价：句中停顿超过 300 ms 会被切成两段——这与 1100 ms 答题防抖已有的假设一致。
3. 时钟改为**每会话一份**。按通道共享会让已关闭会话的尾句去查新会话的锚点，返回未来 ~10 s
   的时间（表现为 e2e 负值）。

试过并回退的：把整句缓冲裁到语音区间。解码确实随输入长度缩放，但 `sent_buf` 开头多带一个
600 ms 前滚块、而 `sent_begin_ms` 记在 `samples_seen` 时间轴上，两者差一块，朴素切片会切进
词里（「测试」→「嗯，那咋？」）。注释已留在代码里，要重做得先把前滚偏移算对。

测量台自身修掉两个会静默产出假数据的坑：遗留 sidecar 占着 `:10097` 导致连续两轮测的是旧代码
（现在开跑前检查端口、结束回收子进程），以及 python 进度条把日志写成二进制使 `grep` 失配。

**下一步**：ASR 侧的固定开销已经压到 ~0.9 s，剩下的主要是 CPU 解码。再往下是 provider TTFT
（需用户在自己 shell 里给 key）与投机作答命中率评估。



## 9. v1.0.3 成品包：AppImage / deb 第一次真正跑通（2026-10-03）

`npm run dist:linux` 此前从未产出过用户可执行的 Linux 包。这一轮全部构建并实测。

| 产物 | 字节 | 备注 |
| --- | --- | --- |
| `MeetingAssistant-1.0.2-linux-x86_64.AppImage` | 134,340,209 | 静态 runtime、zstd；版本号发版时再 bump |
| `MeetingAssistant-1.0.2-linux-amd64.deb` | 112,690,400 | |
| `release/linux-unpacked` | 347.7 MB | asar 39.6 MB + unpacked 56.8 MB |

同一棵树上 `node tools/packaged-smoke.mjs`（主窗口 IPC 往返 / 首次向导互斥两场景）与
`node tools/linux-verify.mjs`（8/8：热键、托盘、PipeWire 环回、4.93 s PCM、▶→首帧 227 ms、
autostart 条目）全绿；AppImage 直跑 40 s 无异常，日志走到 `[setup] wizard ready`。

三件以前只能猜的事现在是实测结论：

1. **默认 toolset 的 AppImage 在本机起不来**：只打印 `dlopen(): error loading libfuse.so.2`
   就退出——Ubuntu 24.04.5 只装 `libfuse3-3`，没有 libfuse2。配置里加
   `toolsets.appimage: "1.0.3"` 换 libappimage 静态 runtime 后，同一个产物直接可跑，
   顺带小 11 MB（zstd 替 gzip）。`APPIMAGE_EXTRACT_AND_RUN=1` 是旧 runtime 的绕行方案，
   现在不需要了。
2. **沙箱：deb 会自愈，AppImage 不会**。electron-builder 的 postinst 先 `unshare --user` 探一次，
   不通就 `chmod 4755 /opt/MeetingAssistant/chrome-sandbox`，并另外安装一份路径绑定的
   AppArmor profile（`resources/apparmor-profile`，允许该二进制用 userns）。AppImage 里 SUID
   注定无效（FUSE 挂载带 nosuid，解压后属主又是普通用户）。本机三种起法
   （linux-unpacked 直跑 / AppImage 直跑 / extract-and-run）都没有 FATAL，`unshare -Ur true`
   也成功 ⇒ **当初 start.sh 撞到的 `setuid_sandbox_host.cc:166` 在本机复现不出来**；
   那条 `--no-sandbox` 保留为条件兜底（helper 非 root:root 4755 **且** unshare 失败才加）。
   换静态 runtime 后 AppImage 的 desktop Exec 不再自动带 `--no-sandbox`
   （`AppImageTarget.js` 的 `defaultArgs` 仅在 toolset `0.0.0` 时注入；deb 侧实测
   `Exec=/opt/MeetingAssistant/meeting-assistant %U`），能建命名空间的内核就保留 Chromium 沙箱。
3. **窗口分组**：实测 WM_CLASS = `('meetingassistant', 'MeetingAssistant')`，与 deb desktop 条目里
   `StartupWMClass=meetingassistant` 一致 ⇒ 构建日志那句 `desktopName is not set` 在 X11 路径上
   不影响任务栏关联，不改名（改了只会把用户已 pin 的 `meeting-assistant.desktop` 换掉）。
   顺手修掉真正的文案错：包里的 `Comment` 来自 `package.json` description，原文写着
   "for Windows and macOS"，已改为 Windows and Linux。

包体在 §1 的基础上再降（S9/S10），并记下一条**否掉的**收益：`@napi-rs/canvas` 那 29.8 MB skia
看着只服务渲染，实际移走之后 PDF 文本抽取直接 `DOMMatrix is not defined`（见 S11）。

## 10. v1.0.3 发版核对（2026-10-11）

**应用侧开销量了，没有退化**：当前树上复跑 `npm run latency:local`（离线 mock，零首字延迟，
不需要 Key，也不含网络抖动）——gate TTFT min 1 / p50 2 / p95 14 ms，answer-short 与
answer-context 均 p50 1 / p95 2 ms，预算 50 ms ✓。与 §5 在 2026-10-02 记的数字一致。

**用户能感知的降低只有两处，都不是"LLM 变快"**：

| 环节 | v1.0.2 | v1.0.3 | 生效范围 |
| --- | --- | --- | --- |
| 本地 ASR：语音结束 → segment | ~1850 ms | 872–882 ms（§8，5/5 转写正确） | 本地实时引擎，默认生效，无需设置 |
| Linux：▶ → 首个 PCM 帧 | ~575 ms | 211 ms（§2 L2/L3） | 仅 Linux 环回采集 |
| 句子关闭 → 发出请求 | 固定等 1100 ms | 不变（投机作答在 §6，默认关闭） | — |
| 复核回合 | 无此功能 | 结构上不占首答时间（`done` 已发出才启动） | 做题模式算法题 |

投机作答本版仍不默认启用：真实音频上的命中率、撤销率与重复计费增量都没测过（§6）。
provider TTFT、真机"语音结束→首答可见"的墙钟、桌面 Electron 里代码块的呈现，
本版依旧没有测到，发布说明里按"待测"写，不算已完成。
