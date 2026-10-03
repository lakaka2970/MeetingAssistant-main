# Linux Setup Guide

[简体中文](SETUP.zh-CN.md) · [Windows guide](../windows/SETUP.md) · [macOS guide](../macos/SETUP.md)

MeetingAssistant runs natively on Linux with **system loopback audio**, global
hotkeys, screen-anchored screenshot Q&A, a tray item and login autostart — all
verified on Ubuntu 24.04 (GNOME / Wayland, PipeWire 1.0.5, Electron 41).

One capability is *not* available on Linux: content protection. See
[Stealth](#stealth-honest-about-it).

## Requirements

| Component | Requirement |
|---|---|
| OS | Any distro with **PipeWire** + WirePlumber (Fedora 34+, Ubuntu 22.04+, Debian 12+, Arch) |
| Runtime | Node.js ≥ 20 and npm |
| System-audio capture | `pw-record` (from the `pipewire-utils` / `pipewire-tools` package) and `wpctl` (from `wireplumber`) |
| LLM | Any OpenAI-compatible API key — DeepSeek recommended |
| Local streaming ASR *(default)* | Python 3.10–3.12 with `requirements-funasr.txt`; CPU works, NVIDIA GPU faster |
| Experimental MOSS ASR *(optional)* | isolated Python env with `requirements-moss.txt` |
| Local Whisper *(offline fallback)* | `whisper-large-v3-turbo` ONNX weights, **CPU only** (DirectML is Windows-only) |
| Cloud ASR *(optional)* | Alibaba Cloud DashScope or MiMo key |

```bash
# Debian/Ubuntu — pw-record and wpctl
sudo apt install pipewire-utils wireplumber
```

## Install & run

```bash
git clone https://github.com/lakaka2970/MeetingAssistant-main.git
cd MeetingAssistant-main
npm install          # postinstall applies patches/ — do not skip it
npm run dev          # or: npm run build && npm start
```

> 🇨🇳 If npm / Electron downloads are slow in China, create a `.npmrc` containing
> `registry=https://registry.npmmirror.com` and
> `electron_mirror=https://npmmirror.com/mirrors/electron/`.

To check a **packaged** build (this is what the hotkey relaunch and autostart
behaviour apply to):

```bash
npx electron-builder --dir --linux     # → release/linux-unpacked/meeting-assistant
node tools/linux-verify.mjs            # 8 functional assertions (+2 Wayland-only) and a size/latency report
npm run dist:linux                     # → the two artifacts below
```

### Prebuilt packages

```bash
sudo apt install ./MeetingAssistant-<version>-linux-amd64.deb   # or: sudo dpkg -i <same file>
chmod +x MeetingAssistant-<version>-linux-x86_64.AppImage && ./MeetingAssistant-<version>-linux-x86_64.AppImage
```

The `.deb` is the better default on Ubuntu 22.10+ and anything else that restricts
unprivileged user namespaces: its `postinst` probes `unshare --user` and, when the
kernel says no, sets the setuid bit on `chrome-sandbox` and installs an AppArmor
profile for `/opt/MeetingAssistant/meeting-assistant`. An AppImage cannot do either
(it extracts as you, and its mount is `nosuid`), so on such a kernel it aborts with
Chromium's `setuid_sandbox_host.cc` message instead of starting. Both artifacts need
`libfuse3` only — the shipped AppImage uses the libappimage static runtime, not the
old runtime that demanded `libfuse2`.

## Audio capture — how it reaches the other party

Electron's `audio: 'loopback'` display-media token is Windows-only, and Chromium
on Linux will not hand a sink monitor to `getUserMedia` (measured:
`enumerateDevices()` returns only the physical microphone). So the app taps the
output at the PipeWire graph level instead:

1. it starts `pw-record --target <sink>` with the sample format the ASR host
   wants (16 kHz mono float32, resampled by PipeWire itself), and
2. **re-links** the stream's input ports from the microphone onto the sink's
   `monitor_FL/FR` ports with `pw-link` — WirePlumber otherwise ignores
   `--target` and connects the default source.

The link table is read back and the capture refuses to start if the graph does
not end up on the monitor, because silently recording the local microphone and
presenting it as "the other party" would be worse than recording nothing.
Pressing **▶ Start** therefore needs no virtual sound card and changes nothing
in your audio routing — you keep hearing the meeting normally.

- **Multiple outputs** (speakers + HDMI): Settings → Audio devices lists the
  PipeWire outputs; pick the one you are actually listening to. Leaving it on
  *Default output* follows whatever PipeWire is playing to.
- **Without `pw-record`** the backend is reported unavailable and the app falls
  back to a selectable input device. If you build your own route that carries
  the meeting audio into a capture device, choose it there; the app makes no
  claim about how that device was created.

## Global hotkeys and the display backend

Under a native Wayland session no client can grab keys globally, so
`globalShortcut` fails for every accelerator. The app therefore defaults to the
X11 backend (XWayland) on Linux, where hotkeys, translucent overlays and screen
capture all work.

- Packaged builds honour the stored choice by **relaunching once** with
  `--ozone-platform=x11`; the first process exits before opening a window, so
  the restart is invisible.
- `Electron_OZONE_PLATFORM_HINT` and `app.commandLine.appendSwitch()` have no
  effect here (measured on Electron 41) — only the real command line does.
- A dev build does not relaunch (that would break `electron-vite dev`); pass the
  flag yourself: `npx electron . --ozone-platform=x11`.
- Switch back in Settings → General → *Display backend* if you prefer native
  Wayland rendering; you lose the global hotkeys and keep the tray.

Defaults: **Control+B** hide/show · **Control+Shift+S** screenshot Q&A ·
**Control+Alt+A** answer the latest line.

## Local streaming FunASR (default ASR backend)

```bash
uv venv .venv --python 3.12      # or: python3 -m venv .venv
# CPU builds of torch/torchaudio — required on a machine without NVIDIA, since
# the default index serves CUDA wheels
uv pip install --python .venv 'torch==2.11.0' --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv 'torchaudio==2.11.0+cpu' --index-url https://download.pytorch.org/whl/cpu --reinstall-package torchaudio
uv pip install --python .venv -r requirements-funasr.txt 'transformers>=4.44,<5'
```

Neither extra is optional, both measured on a clean Ubuntu box:

- installing `requirements-funasr.txt` alone resolves `transformers` down to
  4.12.2 (2021), which pins `tokenizers==0.10.3` — no wheels exist for it, so it
  tries to build from source and dies for want of a Rust toolchain. A modern
  floor fixes it.
- without the CPU index, `torch`/`torchaudio` arrive as CUDA builds: gigabytes
  larger, and `import torchaudio` then fails with a missing `libcudart.so.13`.
  Reinstalling `torchaudio==2.11.0` from the CPU index is a no-op (same version
  string), so it needs the explicit `+cpu` label plus `--reinstall-package`.

The app **auto-spawns and reaps** the sidecar (`tools/funasr_stream_server.py`,
`ws://127.0.0.1:10097`, own process group, killed with `SIGTERM` on quit) —
selecting the preset in Settings is all you do. Interpreter resolution order:
`MC_FUNASR_PYTHON` → project `.venv/bin/python` → `python3` → `python`.
First run downloads the model (≈880 MB paraformer, ≈2.1 GB Nano, from ModelScope).
If the engine dies, the error names `requirements-funasr.txt` rather than a conda
environment — conda is a Windows-side arrangement.

Self-check (the combination verified here):

```bash
MC_VERBOSE_LOGS=1 MC_USERDATA=/tmp/asr-check npm run smoke:e2e:local
```

## Experimental MOSS-Transcribe-Diarize 0.9B

Keep it in its own environment so the Transformers 5.x stack cannot disturb FunASR:

```bash
python3 -m venv .venv-moss
.venv-moss/bin/pip install -r requirements-moss.txt
```

Selecting “MOSS-Transcribe 0.9B” auto-starts `tools/moss_asr_server.py`
(~1.7 GB of weights on first run; device order CUDA → CPU). Override with
`MC_MOSS_PYTHON`, force a device with `MC_MOSS_DEVICE=cuda:0` / `cpu`.
MOSS is not a native streaming model: one decode after ~700 ms of trailing
silence, no word-by-word partials.

## Local Whisper turbo (offline fallback)

Place [`onnx-community/whisper-large-v3-turbo-ONNX`](https://huggingface.co/onnx-community/whisper-large-v3-turbo-ONNX)
under `~/.config/MeetingAssistant/models/onnx-community/whisper-large-v3-turbo-ONNX/`
(`encoder_model_fp16.onnx`, `decoder_model_merged_quantized.onnx`, plus config
and tokenizer files). On Linux it runs on the **CPU** execution provider only.
`MC_MODELS_DIR` overrides the directory; `node tools/asr-harness.mjs --cpu`
checks the whole path.

## Stealth, honestly

`setContentProtection()` is implemented for Windows and macOS only, so on Linux
the overlay **does appear in screen recordings and shares** — the 🕶 button says
so in its tooltip instead of promising otherwise. Window positioning, the
frameless transparent overlay and `desktopCapturer` screenshot capture all work
(verified on both Wayland and X11).

## Login autostart

Enabling it writes `~/.config/autostart/com.lakaka2970.meetingassistant.desktop`
(the XDG mechanism GNOME and KDE actually read, since Electron's
`setLoginItemSettings` does nothing on Linux). Packaged builds only — a dev
build never registers `node_modules/electron/dist/electron` at login. The entry
points at `$APPIMAGE` when running from an AppImage, so a mount path that
changes per boot is not baked in.

## Data locations

- Settings / sessions / materials: `~/.config/MeetingAssistant/` (`$XDG_CONFIG_HOME` honoured)
- API keys: encrypted at rest via the Secret Service (`safeStorage`); the app
  warns in Settings if the backend is unavailable and keys would be stored plain
- Tray icon needs a StatusNotifierHost (Ubuntu's default GNOME ships one);
  without it the app degrades to "no tray" and the hotkeys become the way back
