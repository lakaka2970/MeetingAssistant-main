# v1.0.4 应用内自动更新 · 设计

日期：2026-10-13 · 状态：已与用户逐段确认，进入实现
分支：`fix/stealth-capture-black-block`（起点 v1.0.3 / a5095c7）

## 0. 这一版要解决的问题

v1.0.2/v1.0.3 的「检查更新」是**只通知**（plan A）：向 GitHub 查一次 `releases/latest`，把结果写在托盘菜单那一行，用户自己打开页面、自己下载、自己装。用户要的是：设置里能开「如果有更新就提示安装」，点了确认以后**由应用自己把新版装上**。

这推翻仓库现有两处硬承诺，必须一起改写，不能只改代码：

- `src/i18n.tsx:707` 中文与 `:1503` 英文的 `updateAutoHint`：「不会下载或安装任何东西，也不自动重启」；
- README 与 `electron/main.ts:624` 注释里的「本程序不会自己下载、安装或重启任何东西」。

## 1. 已确认的四个决策

| # | 决策 | 选定 | 依据（已核事实） |
|---|---|---|---|
| 1 | 自动安装覆盖哪些包形态 | **只做 Windows NSIS 安装版**；portable / Linux 保持「通知 + 打开下载页」，并显式告诉用户为什么按钮是灰的 | electron-builder 官方文档：auto-update 支持 macOS(Squirrel) / Windows(NSIS) / Linux(AppImage, rpm, deb)；portable 的原文是 "Auto-updates require manual implementation" |
| 2 | 什么时候下载那 ~118 MiB | **只在用户点「确认更新」之后下载**；下完再要一次确认才安装 | 不做后台预下载，就不新增一条"没点安装也在灌流量"的承诺 |
| 3 | 下载源 | **GitHub 直连（provider: github）**；镜像更新源的**源选择写成纯函数并测试，但本版不在设置里暴露** | 现有 `update.apiBase` 镜像只作用于查询；安装包在 `objects.githubusercontent.com`。已决定 `verifyUpdateCodeSignature=false`，此时镜像换 `latest.yml` 只剩 sha512 一道防线 |
| 4 | 提示与状态呈现 | **浮层内 `UpdateBanner`**（进度 / 已就绪待确认 / 失败原因），托盘只作触发入口；**不用系统通知** | balloon / Notification 不是受保护窗口，会直接被屏幕共享拍到，等于自己破隐身；Linux 还没有 balloon API |

两条不可绕过的硬前提（不是选项）：**默认关**（`update.autoUpdate` 默认 `false`）；**永不自动重启**（安装只在一次显式确认后发生，`autoInstallOnAppQuit` 关闭）。

## 2. 架构

沿用仓库既有的「纯半在 `shared/`、Electron 只做 plumbing 在 `electron/`」分法（`shared/updateCheck.ts` + `electron/updateCheck.ts`、`shared/trayMenu.ts` + `electron/tray.ts` 是同一个模式）。

```
shared/updateInstall.ts   纯：capability 判定、状态机 reducer、canInstall 门禁、菜单标签、设置门禁
electron/updateInstall.ts 薄：electron-updater 事件 → reducer event；downloadUpdate / quitAndInstall
electron/main.ts          接线：托盘命令、IPC 广播、退出守卫
shared/protocol.ts        IPC 通道与类型
electron/preload.ts       mcApi.updater 桥
src/components/UpdateBanner.tsx  浮层状态条
shared/trayMenu.ts        TrayMenuState.updater → 菜单条目
electron-builder.yml      nsis target 上的 publish: github（产出 latest.yml + 包内 app-update.yml）
.github/workflows/release.yml  ① tag_name/name 补上；latest.yml 进产物清单
```

### 2.1 `shared/updateInstall.ts`（纯模块）

```ts
export type Capability = 'nsis' | 'portable' | 'appimage' | 'deb' | 'dev' | 'unsupported';

/** portable / AppImage 的存在性由环境变量判，这是 electron-builder 打包后的唯一可靠信号 */
export function detectCapability(o: {
  platform: string;
  packaged: boolean;
  env: Record<string, string | undefined>;
}): Capability;

export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; version?: string; reason: string };

export type UpdaterEvent = /* check-start | check-result | download-progress | downloaded | error | ... */;

export function updaterReducer(state: UpdaterState, event: UpdaterEvent): UpdaterState;

/** 唯一允许触发安装的条件：ready + 显式确认。自动路径在这里被挡死，不在注释里 */
export function canInstall(state: UpdaterState, o: { confirmed: boolean; capability: Capability }): boolean;

/** 更新功能对该机器是否可用（含默认关的门禁），返回不可用的原因供 UI 直说 */
export function updaterGate(o: {
  enabled: boolean;
  capability: Capability;
}): { allowed: boolean; reason?: string };

/** 镜像更新源基址：只接受 https://，否则返回 ''（'' = 用 GitHub provider）。
    与同族的 updateApiUrl 保持一致用 '' 而不是 null，实现时改的，这里同步过来 */
export function updaterFeedUrl(base: string): string;
```

### 2.2 设置

`settings.ts` 的 `update` 段新增 `autoUpdate: boolean`，默认 `false`。三处同改并由测试钉住：默认值表、`migrateV1toV2`/归一化、`snapshotToUi` 白名单；`test/settings.spec.ts` 补「手改 settings.json 塞进非布尔值 → 落回 false」。

### 2.3 托盘与 IPC

- `TrayMenuState` 加 `updater?: UpdaterState`；`buildTrayMenu` 在 `updater.kind === 'available' | 'downloading' | 'ready'` 时产出对应条目，命令 `update-download`、`update-install`。
- 新增通道：`updater:state`（main → renderer 广播）、`updater:command`（renderer → main，`check | download | install | dismiss`）。
- 安装确认走**浮层内的确认面板**，不走 `dialog.showMessageBox`（原生对话框不是受保护窗口，同样有被共享拍到的问题）。

### 2.4 打包与发布

- `electron-builder.yml`：`publish` 挂在 **nsis target** 上（目标级），避免 portable / AppImage 产出没人消费的 `latest.yml`。
- CI 产物须含 `release/latest.yml`；`softprops/action-gh-release` 须 `tag_name: ${{ github.ref_name }}` + `name: v${{ github.ref_name }}`——**这是这条特性的前置条件**：untagged release 没有稳定的 `/releases/download/<tag>/latest.yml` 路径，GitHubProvider 取不到通道文件。v1.0.3 正是因为 CI 没传 tag 才发布的 untagged（其 `tag_name` 是 GitHub 生成的 `untagged-80a09d0fbd742b197601`）。
- `win.verifyUpdateCodeSignature`：**这个开关不存在**（electron-builder 26.15.3 无此配置项；`NsisUpdater.verifyUpdateCodeSignature` 的 setter 是 `if (value)`，赋 `false` 是空操作）。真实机制是（读 `node_modules/electron-updater@6.8.10` 源码核实）：
  - `NsisUpdater.doDownloadUpdate` 下载完一定调 `verifySignature(destinationFile)`；
  - `verifySignature` 从包内 `app-update.yml` 读 `publisherName`，**`publisherName == null` 时直接 `return null`，即完全不验**；
  - electron-builder 只在强制签名校验场景才把 `publisherName` 写进 `app-update.yml`，我们不签名 → 所以**从未有过 Authenticode 校验**，不是"我们选择关掉它"。
- `autoInstallOnAppQuit` 在 6.8.10 里**默认 `true`**（`AppUpdater.js:114`）→ 必须显式设 `false`，否则"永不自动重启"会被这个默认值打掉。
- `disableWebInstaller` 默认 `false`（`AppUpdater.js:147`），7.x 会翻成 `true`；我们发的是完整安装包，显式设 `true`，同时消掉它的告警。
- `app-update.yml` 由 `PublishManager` 在 `onAfterPack` 写出，Windows 侧只对 **nsis 目标**生效（`isSuitableWindowsTarget`：`nsis` 或 `nsis-*`，portable 不算），且**与 `--publish never` 无关**（源码注释：文件"should be generated regardless of publish state"）→ CI 现有的 `--publish never` 不妨碍产出包内 feed 配置与 `latest.yml`。

## 3. 未签名的信任链（如实写进 README）

| 层 | 有什么 | 没什么 |
|---|---|---|
| 传输 | https 到 github.com / objects.githubusercontent.com | 无证书钉扎 |
| 完整性 | `latest.yml` 的 sha512 逐文件校验 | 与旧版 `.sha256` 手动校验并存 |
| 来源真实性 | GitHub 账号与 Releases 页面 | **没有代码签名**：`app-update.yml` 里没有 `publisherName`，electron-updater 因此整段跳过 Authenticode 校验（见 §2.4） |

结论：自动安装的安全性等于「github.com 的 https 没被中间人换包」。镜像更新源（GenericProvider）在签名问题解决前不暴露，因为一旦 `latest.yml` 由第三方托管，这道链上只剩 sha512，而 sha512 与文件同源分发时不构成独立防线。

## 4. 数据流

```
托盘「检查更新」 ──> runUpdateCheck()（releases API，含镜像，行为不变）
                     └─ 三态照旧写进菜单那一行
updaterGate 允许时（capability==='nsis' && autoUpdate===true）
托盘多一行「下载并安装 v1.0.4」
  └─ 点击 → autoUpdater.checkForUpdates()（GitHub provider，读 latest.yml）
        → downloading(percent) ← download-progress，驱动 UpdateBanner
        → ready(version)
              └─ UpdateBanner / 托盘「安装并重启」→ 浮层确认面板（说明会退出重启、打断转写）
                    └─ 确认 → canInstall() → quitAndInstall({isSilent:true,isForceRunAfter:true})
                          └─ before-quit 走既有收尾（ASR / sidecar / companion / rag.dispose flush）
失败任一路径 → failed(reason) → 菜单与 banner 显示原因 + 保留既有「打开下载页面」回落，不留死路
```

`autoInstallOnAppQuit` 显式关闭（electron-updater 6.8.x 的字段名以安装后实际 API 为准；7.x 才改名 `autoInstallEvent`，落地前核对）。

## 5. 测试与验收

**单测（vitest，纯函数）**
- `detectCapability`：`packaged=false→dev`、win32+`PORTABLE_EXECUTABLE_FILE`→portable、win32 无→nsis、linux+`APPIMAGE`→appimage、linux 无→deb、darwin→unsupported。
- reducer 全路径：`checking→available→downloading→ready→installing`；`downloading→failed→（重试）available`；**`ready` 在无确认时不能进 `installing`**。
- `canInstall` / `updaterGate`：任何自动路径返回 false；`autoUpdate=false` 时功能整体不可用并给出 reason。
- `updaterFeedUrl`：非 https 一律拒绝。
- `buildTrayMenu`：状态驱动标签与条目出现/消失。
- `settings` 迁移与白名单：手改文件不能把 `autoUpdate` 变成非布尔。

**静态断言**（仿 `test/packagingFiles.spec.ts` 的做法）
- `electron-builder.yml` 里 nsis target 带 `publish`，且 `verifyUpdateCodeSignature: false` 有注释说明。
- `release.yml` 的 `tag_name`/`name` 存在、产物清单含 `latest.yml`。

**真机验收（不做完不算完成）**
本机装 v1.0.4，跑一遍：检查 → 下载（看进度）→ 确认 → 安装重启 → 版本号变、`%APPDATA%\MeetingAssistant` 的设置与会话完好（`deleteAppDataOnUninstall: false`）。这一步会在开发机上真的覆盖安装一次并触发 UAC。

**明确标注为"未验"**
portable / Linux / macOS 的自动安装（本版不做）；镜像更新源（接口与测试在，UI 未暴露）。

## 6. 范围外

- 不做后台预下载、不做灰度（`stagingPercentage` 能力留在 `latest.yml` 侧，不接）。
- 不改隐身逻辑（黑块问题待现场一手数据，见 `docs/user/RELEASE_NOTES_v1.0.4.md` 已知问题）。
- README.md 的成稿改动等 v1.0.4 全部开发完成后统一做（用户指示）；`README.pdf` 本次不重生成。

## 7. 实现期发现（这几条改变了做法，不是执行细节）

1. **`publish` 的位置**：按"target 级"写进 `win.target[n]` 被 electron-builder 26.15.3 的 schema 直接拒绝
   （`configuration.win.target.0 should be one of these: string`）。正确位置是 **`nsis:` 块**。由
   `test/updatePackaging.spec.ts` 钉住，并带一条内存变异用例，证明扫描器确实区分 nsis 与 portable。
2. **`app-update.yml` 只随 nsis 目标产出**：`dist:dir` 的 win-unpacked 里没有它，打包 smoke 因此报
   `ENOENT ... resources\app-update.yml`（`PublishManager.onAfterPack` 用 `isSuitableWindowsTarget` 把关）。
   含义：**feed 只能用 `npm run dist:win` 的产物验证**，smoke 里把 ENOENT 单独识别成"跑错了构建"。
3. **打包 smoke 抓到一条真 bug**：`ipcMain.handle` 把 `updater:get` / `updater:act` 注册了两遍。运行期表现是
   `Attempted to register a second handler for 'updater:get'` 变成一个无人处理的 rejection——不崩、不弹窗，
   那条 IPC 通道从此静默失效。单测看不见。修掉后新增 `test/ipcChannels.spec.ts` 扫 main.ts 的 handle
   注册名唯一性（含一条内存变异用例），把这类错误挡在 CI。
4. **状态机回退闪烁**：胶水层为把版本号带进 `ready`，在 `update-downloaded` 里重发了一次 `check-result`，
   把 `downloading` 打回 `available`（浮层会从"下载中"闪回下载按钮）。改成 `downloaded` 事件自带可选
   `version`，reducer 与 glue 各加一条测试钉住单向转移。
5. **端到端的"发现新版→下载→确认→覆盖安装"目前无法演练**：线上最新 release 比被测版本旧，普通路径永远
   回答"已是最新"，走不到 electron-updater。为此加了 `MC_UPDATER_CHECK=1` 钩子（与 `MC_PANES_SHOT` 同族，
   正因为它会主动联网所以只留 env 门，不进 UI）。`npm run smoke:updater` 用真实 nsis 构建跑到终态：

   ```
   [updater] MC_UPDATER_CHECK: asking the install manifest
   [updater] Checking for update
   [updater] Error: Cannot find latest.yml in the latest release artifacts
   (https://github.com/lakaka2970/MeetingAssistant-main/releases/download/untagged-80a09d0fbd742b197601/latest.yml): HttpError: 404
   ```

   这条 404 同时是两件事的证据：包内 feed 被真的读到了、GitHubProvider 确实在按
   `/releases/download/<tag>/latest.yml` 取清单——而 untagged 的 v1.0.3 提供不了这个路径。
   第一个能享受这条链路的版本是 v1.0.5 的用户（v1.0.4 自己装不上比自己新的版本）。
6. **`autoDownload` 默认是 `true`**（6.8.10 `AppUpdater.js`），不显式关掉的话"检查"就会开始下载 118 MiB。
   `autoInstallOnAppQuit` 默认 `true` 同理。两者都由 `test/updateInstallGlue.spec.ts` 用替身 updater 盯住。

## 8. 代码审查轮（独立 reviewer + 自查）改掉的

1. **`release.yml` 的注释写进了 `path: |` 块标量里** → 那两行 `#` 会变成**搜索模式**而不是注释。
   注释移到步骤上方；`test/updatePackaging.spec.ts` 改成扫描 upload-artifact 的 `path` 块本身
   （断言 `release/latest.yml` 在块内、块内无 `#` 行），并自带"扫描器能扫到东西"的对照。
2. **失败态是死路**：`failed` 且从未拿到版本号时，横幅唯一的按钮是"重试下载"，而 `download()` 必然再拒一次
   ——这正是本机 smoke 的真实状态。改成按状态选重试（有版本→下载，没版本→重新检查），并始终并排给出
   **打开下载页面** 回落（§4 要求的"不留死路"）。
3. **`download()` 绕过了状态机**：reducer 允许从任何带版本号的状态 `download-start`，包括 `upToDate`。
   新增纯函数 `canDownload(state, capability)`，reducer 只允许 `available` / `failed(有版本)`，
   IPC 与托盘两处调用点都过它。
4. **`installing` 绝对终态会把失败的手交接吞掉**：`BaseUpdater.install()` 在缓存安装包丢失时返回 `false`
   并派发 error（源码 `BaseUpdater.js:42-68`），横幅会永远停在"正在交给安装程序…"。现在
   `confirmInstall()` 检查返回值，且 `failed` 可以从 `installing` 出来（其余事件仍忽略）。
5. **关掉开关不等于取消下载**：`updaterView()` 在门禁关闭时把状态报成 `idle`，于是横幅消失而 118 MiB
   继续下载。改为下载中挂 `CancellationToken`，开关关掉即 `cancel()`，横幅也提供"取消下载"。
6. **重复点"检查更新"会毁掉已完成的下载**：`check-start` 无条件回到 `checking`。现在 `ready` 状态下
   忽略重新检查；只有查出**不同**版本才回到 `available`。
7. **IPC 来源收紧**：区域截图窗用的是完整主 preload，因此也拿得到 `updaterAct`。处理函数现在校验
   `_e.sender === win.webContents`，非主浮层的安装请求直接忽略并打日志。
8. **`update-not-available` 的 payload 是"远端最新"而不是本机版本**，`upToDate.version` 现在取
   `currentVersion`，避免给状态贴一个既没装也下不动的版本号。
9. 语言与卫生：主进程不再往用户可见的 reason 里塞中文散文（改发 `no-version` / `cancelled` /
   `handover-failed` 三个码，由 i18n 翻译）；删掉死函数 `withPercent`；`test/ipcChannels.spec.ts`
   的字面量通道拼写也扫；smoke 头部改成 `dist:win`（`dist:dir` 没有 `app-update.yml`）。

**两处经确认的、与本文档措辞不同的实现选择**（不是偏差，是审查后确认更优）：
- `autoUpdater.checkForUpdates()` 由"releases API 确认有新版本"触发（§4 原写"点击下载并安装之后"）。
  理由：托盘那一行的版本号必须来自真实清单，否则条目就是空的；代价是开了安装开关时每次检查多一个
  请求——已写进 设置提示 与 README。
- 不支持自动安装的机器上，那个开关**仍可勾选**，勾选后下方给出具体原因（原文写的是"灰掉的按钮"）。
  理由：开关是偏好，用户可能先记下、换到安装版再生效；灰按钮无法解释"为什么灰"。
