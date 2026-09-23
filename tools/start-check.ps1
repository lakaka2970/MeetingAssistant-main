# One-click launcher (developer build) with a first-run environment self-check.
# Invoked by the ASCII-only start.bat wrapper: cmd.exe mis-seeks byte offsets in
# UTF-8 batch files under code page 65001, so every Chinese message lives here.
# Requires Windows PowerShell 5.1 (ships with Windows 10/11). Save as UTF-8 with BOM.
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
# if this var leaks in, electron.exe runs as plain Node and crashes
$env:ELECTRON_RUN_AS_NODE = $null

function Pause-Exit([int]$code) {
  Write-Host ''
  Write-Host '请按任意键退出...' -NoNewline
  # redirected stdin (tests/CI) makes ReadKey throw; just return there
  try { [Console]::ReadKey($true) | Out-Null } catch { }
  Write-Host ''
  exit $code
}

function Show-NodeHowTo {
  Write-Host ''
  Write-Host '  安装方式任选其一：'
  Write-Host '    1．官网下载 LTS 安装包：https://nodejs.org/zh-cn'
  Write-Host '    2．国内镜像下载 zip 解压即用：https://npmmirror.com/mirrors/node/'
  Write-Host '    3．命令行安装（PowerShell，需自行确认 UAC）：'
  Write-Host '        winget install OpenJS.NodeJS.LTS'
  Write-Host '  装好后关闭本窗口，重新双击 start.bat 即可。'
}

Write-Host ''
Write-Host '============================================================'
Write-Host ' MeetingAssistant 一键启动 · 首次运行会自动检测并装配环境'
Write-Host '============================================================'

Write-Host ''
Write-Host '[1/6] 检查 Node.js 运行环境...'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '      未检测到 Node.js。这是本应用唯一需要系统安装的依赖。'
  Show-NodeHowTo
  Pause-Exit 1
}
$nodeVersion = (& node --version 2>$null) | Select-Object -First 1
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 20) {
  if ($nodeMajor -eq 0) {
    Write-Host '      检测到 node 命令但无法取得版本号，视为未正确安装。'
  } else {
    Write-Host "      Node.js 版本过旧（$nodeVersion，需要 20 及以上）。"
  }
  Show-NodeHowTo
  Pause-Exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host '      检测到 Node.js 但缺少 npm。请重装 Node.js（自带 npm），'
  Write-Host '      或在安装器里勾选「Add to PATH」后重新双击。'
  Pause-Exit 1
}
Write-Host "      Node.js $nodeMajor.x 与 npm：OK"

Write-Host ''
Write-Host '[2/6] 检查 npm 依赖...'
if (-not (Test-Path (Join-Path $repoRoot 'node_modules') -PathType Container)) {
  Write-Host '      首次运行：正在安装依赖（含 Electron，可能需要几分钟）...'
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-Path (Join-Path $repoRoot '.npmrc'))) {
      Write-Host ''
      Write-Host '      默认源安装失败，自动写入国内镜像配置 .npmrc 后重试一次...'
      Set-Content -Path (Join-Path $repoRoot '.npmrc') -Encoding ASCII -Value @(
        'registry=https://registry.npmmirror.com',
        'electron_mirror=https://npmmirror.com/mirrors/electron/'
      )
      & npm.cmd install
    }
    if ($LASTEXITCODE -ne 0) {
      Write-Host ''
      Write-Host '  依赖安装失败，通常是网络或代理问题：'
      Write-Host '    · 检查能否访问 https://registry.npmjs.org 或配置 npm 代理：npm config get proxy'
      Write-Host '    · 项目根目录已有 .npmrc 时未覆盖它，可确认其中镜像仍然可用'
      Write-Host '    · 修复后删除 node_modules 目录，重新双击本脚本'
      Pause-Exit 1
    }
  }
}
Write-Host '      依赖：OK'

Write-Host ''
Write-Host '[3/6] 校验 transformers.js 补丁...'
& npm.cmd run verify:patched *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '      补丁未生效（常见于带缓存的 node_modules 或 --ignore-scripts）。'
  Write-Host '      请删除 node_modules 目录后重新双击，postinstall 会自动重打补丁。'
  Pause-Exit 1
}
Write-Host '      补丁：OK'

Write-Host ''
Write-Host '[4/6] 检查 Electron 运行时...'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) {
  Write-Host '      依赖已装但 Electron 二进制缺失，正在补下载...'
  & node (Join-Path $repoRoot 'node_modules\electron\install.js')
  if ($LASTEXITCODE -ne 0) {
    Write-Host '      默认地址下载失败，改用国内镜像重试一次...'
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    & node (Join-Path $repoRoot 'node_modules\electron\install.js')
    $env:ELECTRON_MIRROR = $null
    if ($LASTEXITCODE -ne 0) {
      Write-Host '      Electron 二进制下载失败：请检查网络后重新双击本脚本。'
      Pause-Exit 1
    }
  }
}
Write-Host '      Electron：OK'

Write-Host ''
Write-Host '[5/6] 构建应用...'
& npm.cmd run build
if ($LASTEXITCODE -ne 0) {
  Write-Host '      构建失败，请查看上方错误输出（提交前自检可运行 npm run verify）。'
  Pause-Exit 1
}

Write-Host ''
Write-Host '[6/6] 可选能力自检（缺失只提示，不影响启动）：'
$funasrPy = $env:MC_FUNASR_PYTHON
if ($funasrPy -and (Test-Path $funasrPy)) {
  Write-Host '      · 本地转写 FunASR：已就绪'
} elseif (Test-Path 'C:\ProgramData\miniconda3\envs\funasr\python.exe') {
  Write-Host '      · 本地转写 FunASR：已就绪'
} else {
  Write-Host '      · 本地转写 FunASR：未检测到。想用本地免云方案，按 docs/windows/SETUP.zh-CN.md 准备 Python 环境；云端转写不受影响。'
}
if (Test-Path 'C:\ProgramData\miniconda3\envs\moss-asr\python.exe') {
  Write-Host '      · 本地转写 MOSS：已就绪'
} else {
  Write-Host '      · 本地转写 MOSS：未检测到（实验性可选方案，同上文档）。'
}
if (Test-Path (Join-Path $repoRoot 'node_modules\tesseract.js') -PathType Container) {
  Write-Host '      · 做题本地 OCR：已安装'
} else {
  Write-Host '      · 做题本地 OCR：未安装。安装后截屏读题先走本机识别：npm i tesseract.js；不装则需要支持图片的模型 Key。'
}
if (Test-Path (Join-Path $repoRoot 'resources\native\meeting-assistant-audio.node')) {
  Write-Host '      · 原生音频后端：已构建'
} else {
  Write-Host '      · 原生音频后端：未构建（可选）。缺失自动回退 Web Audio，无需处理；详见 rust/README.md。'
}

Write-Host ''
Write-Host '启动 MeetingAssistant...'
Start-Process -FilePath $electronExe -ArgumentList '.' -WorkingDirectory $repoRoot
exit 0
