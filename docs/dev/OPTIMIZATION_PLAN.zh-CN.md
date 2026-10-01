# MeetingAssistant 优化计划（包体 / 延迟）

> 分支：`feat/linux-support`　基线版本：v1.0.2
> 所有数字均为本机实测（Ubuntu 24.04 / GNOME Wayland / PipeWire 1.0.5 / Electron 41.1.1）。
> 复测工具：`node tools/asar-report.mjs`（包体构成）、`node tools/linux-verify.mjs`（功能 + 启动时序，10 项断言）。

## 0. 基线

打包产物 `release/linux-unpacked`（`npx electron-builder --dir --linux`）：

| 组成 | 基线 | 优化后 |
| --- | --- | --- |
| **合计** | **994.7 MB** | **366.3 MB（-63.2%）** |
| `resources/app.asar` | 140.2 MB | 52.3 MB |
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
| S6 | 排除 `LICENSES.chromium.html`（19 MB） | -19 MB | 合规取舍，需产品确认 | ⏸ 待定 |

实施要点（踩到的坑，写进配置注释）：

- **平台级 `files` 会整体替换全局 `files`，不是合并。** 只写负向 pattern 会丢掉正向的 `out/**`，
  electron-builder 回落到"全收"，实测把 308 个条目（含 6.5 MB 演示视频、README.pdf、测试夹具）塞进 app.asar。
  因此 `linux.files` 完整重列了全局清单再追加 Linux 专属负向项，两处需同步维护。
- 与平台无关的裁剪（S4/S8/S7/ort-web）已提升到全局 `files`，Windows 包同样省 ~500 MB；
  `win` 未写自己的 `files`，因此继承全局。

## 2. 延迟

| ID | 动作 | 结果 | 状态 |
| --- | --- | --- | --- |
| L2 | 环回接线并行化（`pw-link -i`/`-o` 并发、disconnect/connect 各一批并发、校验改为轮询而非固定 sleep），并去掉 `start()` 里固定的 150 ms 存活等待 | **▶→首帧 575 ms → 211 ms**（`linux-verify` 断言 <400 ms，已在 CI 口径内） | ✅ |
| L3 | 起始脏帧改为按值过滤（非有限值或 \|sample\|>1 即丢），窗口 1 s，替代固定 500 ms 全丢 | 与 L2 合并生效；4 个新单测覆盖（满幅±1 合法、1.09 判脏、窗口关闭后不再过滤） | ✅ |
| L5 | 推测检索未命中时并行发起真实检索 | **分析后放弃**：`specCache.get()` 返回 null 时本就不等待，400 ms 窗只在"推测确已在飞行"时才付，而此时它比冷启动更可能先完成。并行会让每次答题多跑一遍 embed+检索，本地 CPU 代价换不到稳定收益 | ❌ 不做 |
| L7 | 启动期把 sidecar / RAG 预热推迟 | **实测无效**：本地(拉起 Python sidecar) vs 云端(不拉起) 三次对比，热键就绪 422/428/430 ms 与 430/438/444 ms 基本一致；sidecar 在热键之后才 spawn。单次测出的 300 ms 差是噪声 | ❌ 不做 |
| L1 | desktop 条目 Exec 带 `--ozone-platform=x11`，取消运行时自重启 | 未做：deb 的 Exec 可行，但 AppImage 的 .desktop 由运行时生成、且 `AppRun` 参数注入方式在不同 linuxdeploy 版本不一致，本机无法验证成品包（AppImage/deb 构建未跑）。当前自重启代价仅 ~190 ms 且发生在窗口出现前、用户不可见 | ⏸ 待成品包能构建后再做 |
| L4 | 连续回答 1100 ms 防抖改自适应 | 未做：属于答题行为变更，本机没有可用 LLM key，无法验证"不抢答半句"这条底线；已单列留给有 key 的环境 | ⏸ 需线上环境 |
| L6 | partial 间隔可配（云端 700~900 ms） | 未做：同上，收益（字幕跟手感）只能连真实引擎评估 | ⏸ 需线上环境 |

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

每步改动都要满足：`npm run typecheck` && `npm test`（当前 **1034** 个测试）&&
`node tools/linux-verify.mjs` **10/10**，包体改动另附 `node tools/asar-report.mjs` 前后对比。

尚不能在本机验证的：本地 Whisper 实际推理（未下载 ~1.5 GB 模型）、云端 ASR/LLM 往返、AppImage/deb 成品包。
这些在文档中标为 ⏸，不应被当作已完成。
