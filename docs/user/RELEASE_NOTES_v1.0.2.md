# MeetingAssistant v1.0.2

补丁版本 · A patch release about connecting at all

> ⚠️ 安装包**未做代码签名**，Windows 会弹安全提醒；请只从本项目的 Releases 页面下载。
> ⚠️ The installers are **not code-signed**, so Windows will warn you. Download only from this project's Releases page.

---

## 中文

### 下载哪个

| 文件 | 类型 | 适合 |
|---|---|---|
| `MeetingAssistant-1.0.2-win-x64.exe` | 安装版（NSIS，当前用户，无需管理员） | 常规使用。从 v1.0.1 / v1.0.0 直接覆盖安装即可，设置与会话数据不会被删除 |
| `MeetingAssistant-1.0.2-win-x64-portable.exe` | 免安装版 | 不想安装、临时使用。首次启动需解压，比安装版慢几秒 |

两者功能完全一致，共用 `%APPDATA%\MeetingAssistant\`。需要数据随身携带时，启动前设置 `MC_USERDATA` 指向自己的目录。
macOS 本次**仍然没有**安装包，可从源码运行，见 [INSTALL_MACOS.en.md](INSTALL_MACOS.en.md)。

### 校验下载（SHA256）

每个 `.exe` 旁边都有同名的 `.exe.sha256`，内容是 CI 构建时算出的哈希。下载后在 PowerShell 里执行：

```powershell
Get-FileHash .\MeetingAssistant-1.0.2-win-x64.exe -Algorithm SHA256
```

把输出与 `.sha256` 文件里的值比对，一致再运行。

### 这个版本只修一件事：换台机器就连不上、就转圈

v1.0.1 的功能没有变化。这一版处理的是"在我电脑上好好的，在别人机器上不行"——尤其是装了 **VMware Workstation / Hyper-V / WSL / 任意 VPN** 的机器。

**双屏（手机显示）的配对地址**

- 手机不再可能被指向一块**虚拟网卡**。此前判断只看 VMware 一类名字，Tailscale、ZeroTier、WireGuard、AnyConnect、Pulse、蓝牙网络共享这些隧道网卡会被当成真实网卡，而且常常排在 Wi-Fi 前面——于是电脑显示的地址看着完全正常，手机却永远连不上。
- 选地址的探测从"只问 8.8.8.8"改成**同时问 8.8.8.8 / 223.5.5.5 / 1.1.1.1**，任一有结果即可。公司网络封了 UDP 53、或连的是一个没有外网的 AP 时，以前会静默退化成"按网卡枚举顺序取第一个"，现在不会。
- 每次选定都会写一行日志：`[companion] pairing address: 10.206.243.63 (WLAN, probe)`。**括号里的网卡名和方式**是排查这类问题唯一的线索，出问题时先看这一行。

**手机连上之后不再中途重新弹警告**

- 证书此前必须覆盖本机**每一个**地址，所以开一台虚拟机（VMnet 出现）就会重签证书，所有已信任这台电脑的手机重新看到安全警告、需要重新信任一次。现在**只有真正给手机的那个地址变了**才重签。
- 重签时**复用已生成的私钥**，不再每次重新做一次 RSA 密钥生成（那一步在主线程上约 1 秒，会卡住转录与推流）。

**端口**

- 双屏监听端口此前把两种失败混成一句话："端口均被占用"。Windows 会把**整段端口保留给 Hyper-V / WSL**（`netsh interface ipv4 show excludedportrange protocol=tcp` 可以看到），落在保留段里时无论关多少程序都起不来。现在这两种情况分开说，前者直接告诉你去 设置 → 双屏 换端口。
- 本地语音识别引擎启动失败时同理：以前一律提示"检查 conda 环境"，其中一部分真实原因是端口不可用。现在会把 Python 最后一行输出带出来，端口问题就说是端口问题。

**发给云端的请求不再无限等待**

- Node 的 fetch **没有默认超时**。当 DNS 被虚拟网卡劫持、或默认路由指向一个已经停掉的 VMware NAT 时，请求既不失败也不返回，界面就一直转圈，要等操作系统自己放弃（约 21 秒）。现在远程服务商有 **15 秒首字节超时**——只等"响应开始"，一旦开始返回就不再掐，**长回答不会被截断**。
- 本机地址（`127.0.0.1` / `localhost` / `::1`，也就是 Ollama 与本地 ASR）**不受这个超时影响**：本地模型冷加载本来就要几十秒到几分钟，掐掉它比原来的挂起更糟。
- 「是否需要回答」的分类请求失败时，以前静默按"需要回答"处理且不留痕迹（表现是"这台电脑配错了但助手什么都答"）；现在会打一行 `[gate]` 日志，行为不变。

### 谁应该升级

- 手机上不了双屏、或者电脑显示的配对地址是 `192.168.x.1` / `100.x.x.x` / `172.x.x.1` 这类网段的人。
- 装了 VMware / Hyper-V / WSL / Tailscale / 公司 VPN 的机器。
- 遇到过"点提问之后一直转圈、什么也不报"的人。
- 只在本机跑 Ollama + 本地转写、也不用双屏的人：这一版对你没有可感知的变化，可以不升。

### 已知问题

- 与 v1.0.1 相同的那些（未签名 / 无自动更新 / 本地转写需自备 Python / macOS 无安装包 / 阿里云国际站与 MiMo 为 Beta / macOS 隐身尽力而为 / 手机显示用自签证书 / 读题依赖本地 OCR 或视觉模型），逐条说明见 [RELEASE_NOTES_v1.0.1.md](RELEASE_NOTES_v1.0.1.md)。
- **隧道网卡仍然按名字判断**。名字起得很随意的 VPN 适配器（比如用户自己改过名的）可能被当成真实网卡。核对方法就是上面那行 `[companion] pairing address` 日志。
- **本地 ASR 端口固定 10097**，本版没有改成自动换端口。若它正好落在系统保留段里，需要在 设置 → 语音识别 里自己填一个可用端口对应的地址。
- 若手机连不上而地址是对的，最常见的原因是 Windows 防火墙：本项目的 WLAN 若被识别为**公用网络**，入站连接会被拦。应用不会自动改防火墙规则（那需要管理员权限，也不该由程序代做），请自行在"Windows 安全中心 → 防火墙和网络保护"里允许本应用。

### 免责声明

本工具是个人技术实验与开源研究产物，不是商业产品；作者不通过它获取任何利益；转录与回答由 AI 生成、可能出错，任何使用后果由使用者本人承担。四点全文见 [README.md](../../README.md) 的「⚠️ 免责声明」与应用内「帮助与教程 → 13. 免责声明」。

---

## English

### Which file to download

| File | Kind | For |
|---|---|---|
| `MeetingAssistant-1.0.2-win-x64.exe` | Installer (NSIS, per-user, no admin) | Normal use. Install straight over v1.0.1 or v1.0.0; settings and session data are kept |
| `MeetingAssistant-1.0.2-win-x64-portable.exe` | Portable | No install, or running from a folder. First launch unpacks and takes a few seconds longer |

Both are feature-identical and share `%APPDATA%\MeetingAssistant\`. Set `MC_USERDATA` before launch to carry the data with you.
macOS still has **no** package in this release; run from source — see [INSTALL_MACOS.en.md](INSTALL_MACOS.en.md).

### Verify your download (SHA256)

Each `.exe` ships with a `.exe.sha256` produced by CI. In PowerShell:

```powershell
Get-FileHash .\MeetingAssistant-1.0.2-win-x64.exe -Algorithm SHA256
```

Compare the output with the `.sha256` file before running anything.

### This release fixes exactly one thing: working on someone else's machine

Nothing about v1.0.1's features changed. This release is about "it works on my machine, not on theirs" — specifically machines with **VMware Workstation / Hyper-V / WSL / any VPN** installed.

**The pairing address**

- A phone can no longer be pointed at a virtual adapter. The old check only recognised VMware-style names, so Tailscale, ZeroTier, WireGuard, AnyConnect, Pulse and Bluetooth PAN counted as real and often enumerated before the Wi-Fi card — the PC showed a perfectly plausible URL that no phone could reach.
- The route probe now asks **8.8.8.8, 223.5.5.5 and 1.1.1.1 in parallel** instead of only 8.8.8.8, so a network that blocks UDP 53 or has no upstream no longer silently degrades to "first adapter in the table".
- Every choice logs one line: `[companion] pairing address: 10.206.243.63 (WLAN, probe)`. The **adapter name and the reason in brackets** are the only clue for this class of problem.

**No more re-accepting the certificate mid-meeting**

- The certificate used to have to cover *every* address on the host, so starting a VM (which adds VMnet) re-issued it and every phone that had trusted this machine saw the security warning again. Re-issue now happens only when **the address the phone was given** actually changed.
- A re-issue **reuses the stored private key** instead of generating a fresh RSA pair, which cost about a second on the main thread and stalled transcription and streaming.

**Ports**

- The listener used to report two different failures with one sentence: "all ports occupied". Windows reserves whole port ranges for Hyper-V/WSL (`netsh interface ipv4 show excludedportrange protocol=tcp`), and inside one, closing apps changes nothing. The two cases now say which they are, and the reserved one points at the port setting.
- Same for the local ASR engine: it blamed the conda environment for every failure. It now carries the last line of Python's output, so a port problem is named as a port problem.

**Cloud requests no longer wait forever**

- Node's fetch has **no default timeout**. When DNS resolves through a virtual adapter or the default route points at a stopped VMware NAT, a request neither fails nor answers and the UI just spins until the OS gives up (~21 s). Remote providers now get a **15 s first-byte deadline** that is cleared the moment the response starts — **a long answer is never cut short**.
- Loopback base URLs (`127.0.0.1` / `localhost` / `::1`, i.e. Ollama and the local ASR sidecar) are **exempt**: a cold model load legitimately takes tens of seconds to minutes, and killing that would be worse than the hang this fixes.
- A failed "does this need an answer" classifier call used to fall back silently, which looked like "this machine is misconfigured but the assistant answers everything". Behaviour is unchanged; it now logs one `[gate]` line.

### Who should upgrade

- Anyone whose phone never connects, or whose PC shows a pairing address in `192.168.x.1` / `100.x.x.x` / `172.x.x.1`.
- Anyone on a machine with VMware / Hyper-V / WSL / Tailscale / a corporate VPN.
- Anyone who has seen "I pressed ask and it spins forever with no error".
- If you only use local Ollama plus local transcription and never use dual-screen: nothing here is noticeable for you.

### Known issues

- Everything inherited from v1.0.1 (unsigned / no auto-update / local transcription needs your own Python / no macOS package / Alibaba Cloud international and MiMo are Beta / stealth on macOS is best-effort / self-signed phone certificate / reading the screen needs local OCR or a vision model) is spelled out in [RELEASE_NOTES_v1.0.1.md](RELEASE_NOTES_v1.0.1.md).
- **Tunnel adapters are still detected by name.** A VPN adapter the user renamed may still be treated as real. The `[companion] pairing address` log line is how you check.
- **The local ASR port stays fixed at 10097** in this release; there is no automatic fallback. If it lands inside a reserved range, point Settings → Speech recognition at another port yourself.
- If the address is right and the phone still cannot connect, the usual cause is Windows Firewall: on a network profiled as **Public**, inbound connections are blocked. The app will not edit firewall rules for you (that needs administrator rights and is not a program's business) — allow it under Windows Security → Firewall & network protection.

### Disclaimer

This tool is a personal technical experiment and open-source research build, not a commercial product; its author takes no profit from it; transcripts and answers are AI-generated and can be wrong, so any consequence of using it is borne by the user. The four points in full: the "⚠️ Disclaimer" section of [README.md](../../README.md) and "Help & guides → 13. Disclaimer" in the app.
