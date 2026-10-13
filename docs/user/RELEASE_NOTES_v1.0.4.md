# MeetingAssistant v1.0.4

补丁 + 功能版本 · 修好了「检查更新」，并让它真的能装上 · A patch and a feature: the update check works, and can now install

> ⚠️ 安装包**未做代码签名**，Windows 会弹安全提醒；请只从本项目的 Releases 页面下载。
> ⚠️ The installers are **not code-signed**, so Windows will warn you. Download only from this project's Releases page.

> 完整变更对比 / Full diff: [v1.0.3...v1.0.4](https://github.com/lakaka2970/MeetingAssistant-main/compare/v1.0.3...v1.0.4)

---

## 中文

### 下载哪个

| 文件 | 类型 | 能不能自己更新 |
|---|---|---|
| `MeetingAssistant-1.0.4-win-x64.exe` | 安装版（NSIS，当前用户，无需管理员） | **能**，本版的新功能就是这个 |
| `MeetingAssistant-1.0.4-linux-amd64.deb` | Debian 包 | 不能（本版范围外，仍用「打开下载页面」） |
| `MeetingAssistant-1.0.4-linux-x86_64.AppImage` | 免安装单文件 | 不能（同上） |

从 v1.0.3 / v1.0.2 直接覆盖安装即可，设置与会话数据不会被删除（`%APPDATA%\MeetingAssistant\`，卸载也不清）。
Windows 只有一个包。**本版起不再发布免安装版（portable）**：v1.0.0–v1.0.3 期间它一共被下载 2 次，安装版是 5 次；它每个 Release 多占 118 MB，"没有管理员权限也能装"这点当前用户的 NSIS 安装版本来就覆盖了（静默、不弹 UAC），而它又是唯一一种 electron-updater 装不了的 Windows 形态——继续发它，等于继续发一个用不上本次新功能的包。手上还有旧 portable 的人：直接用安装版覆盖安装即可，设置与数据都在 `%APPDATA%\MeetingAssistant\`，不会丢。Linux 配置目录是 `~/.config/MeetingAssistant/`；macOS 本次**仍然没有**安装包。

### 这个版本做两件事

#### 一、修好被 v1.0.3 发布方式打断的「检查更新」

现象：v1.0.3 发布后，任何机器上点托盘 **检查更新**（或开启了「启动后自动检查一次」）都回答

```
检查失败：响应里没有可识别的版本号
```

而且这一次失败会把当天的自动检查额度用掉，用户看到的是"更新检查永远不可用"。

原因：这个功能只读 GitHub Release 的 `tag_name`。v1.0.3 是通过**不打 tag** 的方式发布的，`tag_name` 变成 GitHub 自己生成的 `untagged-80a09d0fbd742b197601`，版本号只剩在 Release 标题里。网页看着一切正常，程序读不到版本。

修复：`tag_name` 仍是唯一权威——打了 tag 的 Release 判断结果不受标题影响；只有 `tag_name` 解析不出版本时才回退读标题，且**同样要求它能解析成 `1.2.3` 这种纯数字版本**，解析不出照旧回答失败。「不猜」这条规矩没动。`html_url` 仍只接受 `https://` 才交给系统打开。

本机对**线上真实 payload** 验证过（不只跑单测）：

| 客户端版本 | 修复前 | 修复后 |
|---|---|---|
| 1.0.3 | `检查失败：响应里没有可识别的版本号` | `已是最新（v1.0.3）` |
| 1.0.2 | `检查失败：响应里没有可识别的版本号` | `发现新版本 v1.0.3` |

同时 CI 的发布步骤补上了 `tag_name` / `name`，`latest.yml` 也纳入产物——下面那件事依赖它。

#### 二、有新版本时，可以在应用里装

设置 → 通用 → 更新检查 多了一个开关：**发现新版本时提示我下载并安装**。**默认关闭**。打开后的流程是：

1. 托盘或设置里**检查更新** → 发现新版本；
2. 托盘多一行 **下载并安装 v1.0.4**，浮层出现一条安装状态条；点它才开始下载（约 118 MiB），状态条显示真实百分比；
3. 下载完成后状态条变成 **安装并重启**，点它会弹出**第二次确认**——写明应用会退出、安装完自动重新打开、正在进行的转写会中断；
4. 你点确认，才交给安装程序静默覆盖安装并重启。设置、会话、题库都不会丢。

三条它**不会**做：不会自己下载（没点第 2 步就不动网络）、不会自己安装（没点第 4 步就不动）、不会自己重启。这三条不是承诺在注释里，是被测试钉住的：库的三个默认值（`autoDownload`、`autoInstallOnAppQuit`、`disableWebInstaller` 在 electron-updater 6.8.10 里前两个默认是 `true`）都被显式覆盖，并有对照测试防止以后被改回去。

**这台机器能不能用，应用会直接告诉你**：Linux 包、开发环境、以及 v1.0.4 之前留下的旧 portable 文件都不会出现那个开关可用的样子——设置里会写明具体是哪一种（例如"当前是免安装版（portable），只有安装版能自己更新"），而不是给你一个点不动的按钮。识别逻辑保留着，正是为了给还在用旧文件的人一个说法。

**未签名这件事在自动更新里意味着什么**，说清楚不藏：

| 层 | 有什么 | 没什么 |
|---|---|---|
| 传输 | 到 github.com / objects.githubusercontent.com 的 https | 无证书钉扎 |
| 完整性 | `latest.yml` 里的 SHA-512 逐文件校验 | 与每个产物旁边的 `.sha256` 手动校验并存 |
| 来源真实性 | GitHub 账号与 Releases 页面 | **没有代码签名**，因此没有 Authenticode 可验（electron-updater 在没有 `publisherName` 时不执行签名校验） |

结论：这条链的安全性等于"github.com 的 https 没被中间人换包"。所以本版**没有**把"更新源镜像"这个口子开放出来——镜像上的 `latest.yml` 被换掉时，手上只剩一个和文件同源分发的哈希，那不构成独立防线。连不上 GitHub 的用户继续用「打开下载页面」自己下。

### 谁应该升级

- 依赖托盘「检查更新」的人：现在它才真的在工作。
- 用 **Windows 安装版**、希望不用自己找下载页的人。
- 其他人可以不着急：除上述两点外没有其他改动，转录、回答、做题、双屏的行为与 v1.0.3 相同。

### 已知问题与本版没测的

- **隐身（🕶）在部分机器的整屏共享里显示为一个纯黑矩形，而不是让窗口消失。本版没有改动隐身逻辑**，已测到的边界记录在这里供后续定位：
  - 本机实测（Windows 11 26200 / Electron 41，跑 v1.0.3 应用本体）：隐身开启时窗口 `GetWindowDisplayAffinity` 为 `WDA_EXCLUDEFROMCAPTURE`，GDI 抓屏与系统屏幕捕获 API **两条路径**、30fps 逐帧跨越「—」隐藏 → 托盘/快捷键唤回的往返，读到的都是"窗口从捕获中消失"（与该点应用退出后的桌面基线一致），无黑帧；窗口句柄整个往返未重建。
  - `v1.0.2...v1.0.3` 里 Windows 的隐身路径一行没改，所以不是这一版的回归。
  - 黑矩形连窗口自身的透明边框一起涂黑，而应用从不绘制纯黑像素（面板深色 `22,26,34`、浅色 `246,248,251`）→ 不是本地渲染坏掉，而是捕获那侧退化成"按窗口矩形涂黑"。
  - **缺的一手数据**：看到黑块那台机器用的会议软件、共享整屏还是单个窗口、Windows 版本。没有这些数据，任何针对它的改动都是猜测。
- 自动更新的**真机覆盖安装验收**（装一次、看版本号变化、看数据是否完好）在本机仍未完成：它需要真的覆盖安装一次（`nsis.oneClick: true` + 当前用户安装，所以是静默覆盖、**不会弹 UAC**），等用户放行后再做。本版已完成的是这些：
  - 真实 `npm run dist:win` 构建产出了 `latest.yml`（含 SHA-512 与大小）与包内 `resources/app-update.yml`，内容已读回核对；`app-update.yml` 里**没有** `publisherName`，因此 electron-updater 不执行 Authenticode 校验——"未签名"在代码里的真实含义就是这个，没有更多。
  - `npm run smoke:updater` 用打包后的应用真的走到了库那一层：读完 feed、发出请求、把结果如实报出来。当前报的是
    `Cannot find latest.yml in the latest release artifacts … 404`，因为线上最新那个 Release（v1.0.3）是 untagged 的、也没有 `latest.yml` 产物。这条链路要能用，需要 CI 按本版改过的发布步骤产出**带 tag、带 latest.yml** 的 Release。
  - **第一个能用上"应用内安装"的是下一个版本的安装者**：v1.0.4 装不了比自己更新的版本，而线上还没有比自己新的、带清单的 Release。所以下一次发版（v1.0.5）才是这条链路的真正验收点。
- Linux / macOS 的自动安装：本版不做，已在设置里说明。portable 自本版起不再是发布产物，但识别与提示逻辑保留——专门给还在用旧文件的人。
- 未签名、本地转写需自备 Python 环境、macOS 无安装包、阿里云国际站与 MiMo 方案为 Beta、手机显示用自签证书、读题依赖本地 OCR 或视觉模型：与之前版本相同，逐条见 [RELEASE_NOTES_v1.0.0.md](RELEASE_NOTES_v1.0.0.md)。

---

## English

### What this version does

**1. It repairs the tray update check, which v1.0.3's release process broke.** Every 检查更新 click answered `failed: no recognizable version in the response`, and the failure also burned that day's automatic-check allowance. The reader looked only at a release's `tag_name`, and v1.0.3 was published untagged, so GitHub had put `untagged-80a09d0fbd742b197601` there and the version only in the title. The tag stays the authority; the title is consulted only when the tag is not a version, and only if it parses as a plain `1.2.3`. It is never guessed and the release URL is still required to be https. Verified against the live GitHub payload: a 1.0.3 install reports "up to date", a 1.0.2 install reports "v1.0.3 available" — both used to fail.

**2. It can install the update for you — on Windows, only after two clicks, never by itself.** Settings → General gains **Offer to download and install a newer release**, off by default. With it on: a check that finds a newer release adds **Download and install v1.0.4** to the tray menu and a status strip in the overlay; the download (≈118 MiB) starts only on that click and shows real progress; when it finishes the strip asks for **Install and restart**, which opens a confirmation spelling out that the app will quit and reopen and that a transcription in progress is interrupted. Only then does the installer run. It does not download unasked, does not install unasked, and does not restart unasked — those are enforced in code with a test over a stand-in updater, because electron-updater's own defaults for `autoDownload` and `autoInstallOnAppQuit` are `true`.

Machines that cannot self-update say so instead of showing a dead button: the Linux packages, a dev run and the portable exes left over from earlier releases each get their own reason in Settings.

Unsigned builds, stated plainly: integrity comes from the SHA-512 in the install manifest, transport is https to GitHub, and there is no Authenticode to verify because there is no signing. That is also why no "mirror update source" is exposed in this version — a third-party-hosted manifest plus a same-origin checksum is one layer, not two. Users who cannot reach GitHub keep **Open download page**.

### Known issues and what was not tested

- **Stealth (🕶) still shows as a solid black rectangle in some machines' full-screen shares instead of hiding the window. This release changes no stealth code.** Measured here (Windows 11 26200, Electron 41, the real v1.0.3 app): the window's `GetWindowDisplayAffinity` is `WDA_EXCLUDEFROMCAPTURE`, and both GDI BitBlt and the OS screen-capture API sampled it as *absent* across two hide→show round trips filmed at 30fps, matching the desktop baseline at the same pixel after the app was killed; the HWND is never recreated. Nothing in `v1.0.2...v1.0.3` touched the Windows stealth path. The slab covers the window's own transparent border too, and the app never paints pure black (panels are `22,26,34` / `246,248,251`), so the black is substituted on the capture side, not rendered locally. Missing evidence: which meeting client, full screen or single window, which Windows build, on the machine that sees it.
- The **real overwrite-install acceptance** (install once, confirm the version changes and the data survives the UAC prompt) has not been run — it needs a live install on this machine. What has been verified:
  - a real `npm run dist:win` produced `latest.yml` (SHA-512 + size) and the packaged `resources/app-update.yml`, both read back; the manifest carries **no `publisherName`**, which is what "unsigned" actually means in code here — electron-updater performs no Authenticode check.
  - `npm run smoke:updater` drives the packaged app all the way into the library: it reads the feed, makes the request and reports the answer. Today that answer is `Cannot find latest.yml in the latest release artifacts … 404`, because the newest published release (v1.0.3) is untagged and carries no `latest.yml`. The path works only once CI publishes a tagged release with the manifest, which is what this version's workflow change does.
  - **the first installer of this feature is the next release's**: v1.0.4 cannot install anything newer than itself, and nothing newer exists yet. v1.0.5 is where the live round trip gets its real acceptance.
- No self-update for Linux / macOS in this version, as stated in Settings. The portable exe is no longer published at all — 2 downloads across four releases, 118 MB per release, nothing the per-user NSIS build does not already cover, and the one Windows shape electron-updater cannot install. Anyone still running one: install the NSIS build over it, settings and sessions are kept.
- Unsigned installers, local ASR needs its own Python environment, no macOS package, Alibaba Cloud International and MiMo are Beta, the phone display uses a self-signed certificate, reading questions needs local OCR or a vision model — unchanged from earlier versions; see [RELEASE_NOTES_v1.0.0.md](RELEASE_NOTES_v1.0.0.md).
