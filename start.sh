#!/usr/bin/env bash
# One-click launcher for Linux and macOS — the counterpart of start.bat.
#
# Same contract as tools/start-check.ps1: self-check the environment, install
# what is missing, build, report optional capabilities without failing on them,
# then launch. `--check` stops before launching (used by CI and by anyone who
# only wants the environment report).
#
# The Windows launcher is a .bat only because cmd.exe is the target; on Linux a
# shell script is the honest equivalent — and start.bat genuinely cannot work
# here (PowerShell + Windows paths).
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$repo_root"

check_only=0
[[ "${1:-}" == "--check" ]] && check_only=1

fail() { echo "      $1"; exit 1; }

# If this variable leaks in from a parent shell, Electron runs as plain Node and
# dies immediately — the exact failure the Windows launcher guards against.
unset ELECTRON_RUN_AS_NODE

echo
echo '============================================================'
echo ' MeetingAssistant 一键启动 · 首次运行会自动检测并装配环境'
echo '============================================================'

echo
echo '[1/6] 检查 Node.js 运行环境...'
command -v node >/dev/null 2>&1 || fail '未检测到 node。安装：sudo apt install nodejs npm，或用 nvm（https://github.com/nvm-sh/nvm）。'
command -v npm >/dev/null 2>&1 || fail '未检测到 npm。同上，装 Node.js LTS 即可（自带 npm）。'
node_major=$(node -p 'process.versions.node.split(".")[0]')
[[ "$node_major" -ge 20 ]] || fail "Node.js 版本过低（当前 $(node -v)），需要 ≥ 20。"
echo "      Node.js $(node -v)：OK"

echo
echo '[2/6] 安装依赖（已存在则跳过）...'
if [[ ! -d node_modules ]]; then
  echo '      首次安装需要下载 Electron（约 100 MB），请稍候…'
  npm install --no-audit --no-fund || fail 'npm install 失败：网络受限时可建 .npmrc 写入 registry=https://registry.npmmirror.com 后重试。'
fi

echo
echo '[3/6] 检查 transformers.js 补丁...'
npm run verify:patched >/dev/null 2>&1 || fail '补丁未生效（常见于带缓存的 node_modules 或 --ignore-scripts）。删除 node_modules 后重新运行本脚本，postinstall 会自动重打补丁。'
echo '      补丁：OK'

echo
echo '[4/6] 检查 Electron 运行时...'
electron_bin=node_modules/electron/dist/electron
if [[ ! -x "$electron_bin" ]]; then
  echo '      依赖已装但 Electron 二进制缺失，正在补下载...'
  node node_modules/electron/install.js \
    || { echo '      默认地址下载失败，改用国内镜像重试一次...'; ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/' node node_modules/electron/install.js; } \
    || fail 'Electron 二进制下载失败：检查网络后重新运行本脚本。'
fi
echo "      Electron：OK"

echo
echo '[5/6] 构建应用...'
npm run build >/dev/null || fail '构建失败，请运行 npm run verify 查看完整错误输出。'
echo '      构建：OK'

echo
echo '[6/6] 可选能力自检（缺失只提示，不影响启动）：'

# System-audio capture is the one Linux capability with a hard package
# dependency; say which package rather than letting the app look broken.
if command -v pw-record >/dev/null 2>&1 && command -v wpctl >/dev/null 2>&1; then
  echo '      · 系统声音环回采集（PipeWire）：已就绪'
elif command -v pw-record >/dev/null 2>&1 || command -v wpctl >/dev/null 2>&1; then
  echo '      · 系统声音环回采集：不完整，需要 pw-record 与 wpctl 两个命令（sudo apt install pipewire-utils wireplumber）。'
else
  echo '      · 系统声音环回采集：不可用。将退化为“手动选择输入设备”，详见 docs/linux/SETUP.zh-CN.md。'
fi

if [[ "$(uname -s)" == 'Linux' && "${XDG_SESSION_TYPE:-}" == 'wayland' ]]; then
  echo '      · 显示后端：Wayland 会话。开发态不会自重启，本脚本会带上 --ozone-platform=x11，否则全局快捷键注册不上。'
fi

# `command -v` is not a valid [[ ]] condition, so settle it in a flag first.
funasr_ready=0
[[ -n "${MC_FUNASR_PYTHON:-}" ]] && funasr_ready=1
[[ -x .venv/bin/python ]] && funasr_ready=1
if [[ $funasr_ready -eq 1 ]]; then
  echo '      · 本地转写 FunASR：已就绪'
else
  echo '      · 本地转写 FunASR：未检测到。想用本地免云方案，按 docs/linux/SETUP.zh-CN.md 建 .venv 并安装 requirements-funasr.txt；云端转写不受影响。'
fi

models_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
if [[ -d "$models_home/MeetingAssistant/models/onnx-community" ]]; then
  echo '      · 本地 Whisper：模型目录已存在'
else
  echo '      · 本地 Whisper（离线兜底）：未下载模型。见 docs/linux/SETUP.zh-CN.md。'
fi

if [[ "$(uname -s)" == 'Linux' ]] && [[ -d "$models_home/MeetingAssistant" ]]; then
  echo "      · 数据目录：$models_home/MeetingAssistant"
fi

if [[ $check_only -eq 1 ]]; then
  echo
  echo '自检完成（--check：未启动应用）。'
  exit 0
fi

echo
echo '启动 MeetingAssistant...'
launch_args=(.)
if [[ "$(uname -s)" == 'Linux' && "${XDG_SESSION_TYPE:-}" == 'wayland' ]]; then
  launch_args+=(--ozone-platform=x11)
fi
npx electron "${launch_args[@]}"
