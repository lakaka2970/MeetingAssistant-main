# Linux 安装与配置

[English](SETUP.md) · [Windows 指南](../windows/SETUP.zh-CN.md) · [macOS 指南](../macos/SETUP.md)

MeetingAssistant 在 Linux 上原生运行，具备**系统声音环回采集**、全局快捷键、
截屏问答、托盘图标与开机自启——均在 Ubuntu 24.04（GNOME / Wayland、PipeWire 1.0.5、
Electron 41）上实测通过。

唯一在 Linux 上**做不到**的是内容保护，见[关于隐身](#关于隐身说实话)。

## 环境要求

| 组件 | 要求 |
|---|---|
| 系统 | 任意使用 **PipeWire** + WirePlumber 的发行版（Fedora 34+、Ubuntu 22.04+、Debian 12+、Arch） |
| 运行环境 | Node.js ≥ 20 与 npm |
| 系统音频采集 | `pw-record`（`pipewire-utils` / `pipewire-tools` 包）与 `wpctl`（`wireplumber` 包） |
| 大模型 | 任意 OpenAI 兼容 API Key，推荐 DeepSeek |
| 本地流式 ASR（默认） | Python 3.10–3.12 安装 `requirements-funasr.txt`；CPU 可用，NVIDIA GPU 更快 |
| 实验性 MOSS ASR（可选） | 独立 Python 环境安装 `requirements-moss.txt` |
| 本地 Whisper（离线兜底） | `whisper-large-v3-turbo` ONNX 权重，**仅 CPU**（DirectML 为 Windows 专有） |
| 云端 ASR（可选） | 阿里云 DashScope 或 MiMo Key |

```bash
# Debian/Ubuntu —— pw-record 与 wpctl
sudo apt install pipewire-utils wireplumber
```

## 安装运行

```bash
git clone https://github.com/lakaka2970/MeetingAssistant-main.git
cd MeetingAssistant-main
npm install          # postinstall 会应用 patches/，不要跳过
npm run dev          # 或 npm run build && npm start
```

> 国内网络若 npm / Electron 下载缓慢，可建 `.npmrc` 写入
> `registry=https://registry.npmmirror.com` 与
> `electron_mirror=https://npmmirror.com/mirrors/electron/`。

验证**打包产物**（自重启与开机自启只在打包态生效）：

```bash
npx electron-builder --dir --linux     # → release/linux-unpacked/meeting-assistant
node tools/linux-verify.mjs            # 10 项功能断言 + 体积/延迟报告
```

## 对方声音是怎么采到的

Electron 的 `audio: 'loopback'` 采集令牌只有 Windows 支持；而 Linux 上 Chromium
不会把 sink 监听源交给 `getUserMedia`（实测 `enumerateDevices()` 只列出物理麦克风）。
所以应用直接在 PipeWire 图上接一根线：

1. 启动 `pw-record --target <输出设备>`，并要求 ASR 宿主需要的格式
   （16 kHz 单声道 float32，由 PipeWire 自己重采样）；
2. 再用 `pw-link` 把该流的输入端口**从麦克风改接到**输出设备的 `monitor_FL/FR`
   端口——否则 WirePlumber 会忽略 `--target`，把流连到默认源（麦克风）。

改接完成后会回读连接表校验；连不上就报错、不启动采集。因为「悄悄把本地麦克风
当成对方的声音」比「什么都不采」更糟。按 ▶ 开始 因此不需要虚拟声卡，也不会改动
你的音频路由——你照常听得到会议声音。

- **多个输出设备**（扬声器 + HDMI）：设置 → 音频设备 会列出 PipeWire 输出，
  选中你实际在听的那个；保持「默认输出设备」则跟随 PipeWire 当前的播放目标。
- **没有 `pw-record`** 时，后端会报告不可用，应用回退到「手动选择输入设备」。
  若你自建了能把会议声音送进某个采集设备的路由，在那里选中它即可；
  应用不对该设备如何产生做任何假设。

## 全局快捷键与显示后端

Wayland 原生会话下没有客户端能全局抓键，`globalShortcut` 会对所有快捷键失败。
因此 Linux 上应用默认使用 X11 后端（XWayland）——快捷键、透明悬浮、截屏都正常。

- 打包态会按存储的选择**自重启一次**并带上 `--ozone-platform=x11`；
  第一个进程在开窗前就退出，用户看不到这次重启。
- `ELECTRON_OZONE_PLATFORM_HINT` 与 `app.commandLine.appendSwitch()` 在这里都无效
  （Electron 41 实测），只有真实命令行参数生效。
- 开发态不自重启（否则 `electron-vite dev` 会当成崩溃退出），请手动加参数：
  `npx electron . --ozone-platform=x11`。
- 想回到原生 Wayland 渲染：设置 → 通用 → 显示后端。代价是失去全局快捷键，只留托盘。

默认快捷键：**Control+B** 显示/隐藏 · **Control+Shift+S** 截屏问答 ·
**Control+Alt+A** 回答最新一句。

## 本地流式 FunASR（默认 ASR）

```bash
uv venv .venv --python 3.12      # 或 python3 -m venv .venv
# CPU 版 torch（本机无 NVIDIA 时必须；默认索引给的是 CUDA 变体）
uv pip install --python .venv 'torch==2.11.0' --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv 'torchaudio==2.11.0+cpu' --index-url https://download.pytorch.org/whl/cpu --reinstall-package torchaudio
uv pip install --python .venv -r requirements-funasr.txt 'transformers>=4.44,<5'
```

两条都不是可选的，实测原因：

- 只按 `requirements-funasr.txt` 装，`transformers` 会被解析到 4.12.2（2021 年），
  它要求 `tokenizers==0.10.3`——那版本没有预编译 wheel，需要 Rust 工具链源码构建，
  干净机器上会直接失败。加一个现代下界即可。
- `torch` / `torchaudio` 不加 CPU 索引时会装成 CUDA 变体：体积大几 GB，且在没有
  NVIDIA 的机器上 `import torchaudio` 会因缺 `libcudart.so.13` 报错。
  注意 `torchaudio==2.11.0` 从 CPU 索引重装时会被判定"已满足"而跳过，必须写
  `+cpu` 并 `--reinstall-package`。

应用会**自动拉起并回收** sidecar（`tools/funasr_stream_server.py`，
`ws://127.0.0.1:10097`，独立进程组，退出时 `SIGTERM`）——在设置里选好预设即可。
解释器查找顺序：`MC_FUNASR_PYTHON` → 项目内 `.venv/bin/python` → `python3` → `python`。
首次运行自动下载模型（paraformer 约 880 MB，Nano 约 2.1 GB，均走 ModelScope）。
引擎异常退出时，报错会指向 `requirements-funasr.txt` 而不是 conda 环境——conda 那是 Windows 侧的约定。

自检（本机实测通过的组合）：

```bash
MC_VERBOSE_LOGS=1 MC_USERDATA=/tmp/asr-check npm run smoke:e2e:local
```

## 实验性 MOSS-Transcribe-Diarize 0.9B

单独建环境，避免它的 Transformers 5.x 依赖影响 FunASR：

```bash
python3 -m venv .venv-moss
.venv-moss/bin/pip install -r requirements-moss.txt
```

在设置里选「MOSS-Transcribe 0.9B」会自动启动 `tools/moss_asr_server.py`
（首次约 1.7 GB 权重，设备顺序 CUDA → CPU），可用 `MC_MOSS_PYTHON` 指定解释器、
`MC_MOSS_DEVICE=cuda:0`/`cpu` 强制设备。MOSS 不是原生流式模型：约 700 ms 尾静音后
整体解码一次，不输出逐词部分结果。

## 本地 Whisper turbo（离线兜底）

把 [`onnx-community/whisper-large-v3-turbo-ONNX`](https://huggingface.co/onnx-community/whisper-large-v3-turbo-ONNX)
放到 `~/.config/MeetingAssistant/models/onnx-community/whisper-large-v3-turbo-ONNX/`
（`encoder_model_fp16.onnx`、`decoder_model_merged_quantized.onnx` 及配置/分词文件）。
Linux 上只用 **CPU** 执行提供者。`MC_MODELS_DIR` 可改目录；
`node tools/asr-harness.mjs --cpu` 可整链路自检。

## 关于隐身（说实话）

`setContentProtection()` 只实现了 Windows 与 macOS，所以在 Linux 上悬浮窗
**仍会出现在录屏与屏幕共享中**——🕶 按钮的提示语直接说明这一点，不做虚假承诺。
窗口定位、无边框透明悬浮、`desktopCapturer` 截屏在 Wayland 与 X11 下都已实测可用。

## 开机自启

开启后写入 `~/.config/autostart/com.lakaka2970.meetingassistant.desktop`
（GNOME/KDE 真正读取的 XDG 机制；Electron 的 `setLoginItemSettings` 在 Linux 上什么都不做）。
仅打包态生效——开发版不会把 `node_modules/electron/dist/electron` 注册到登录项。
从 AppImage 运行时条目指向 `$APPIMAGE`，因此不会写死每次挂载都变化的路径。

## 数据位置

- 设置 / 会话 / 资料：`~/.config/MeetingAssistant/`（尊重 `$XDG_CONFIG_HOME`）
- API Key：经 Secret Service 加密存储（`safeStorage`）；若后端不可用、Key 将明文保存，
  设置页会告警
- 托盘需要 StatusNotifierHost（Ubuntu 默认 GNOME 自带）；没有时应用降级为「无托盘」，
  此时只能靠全局快捷键唤回窗口
