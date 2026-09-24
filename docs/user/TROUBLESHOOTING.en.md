# Troubleshooting

中文版：[TROUBLESHOOTING.zh-CN.md](TROUBLESHOOTING.zh-CN.md)

The same content is available offline inside the app: tray menu → "Help & guides", or Settings → "Help & guides".

---

## 1. Connection-test error codes

"Test connection" normalises the wildly different provider errors into the 14 codes below. The UI shows a plain sentence and one suggested action alongside each.

| Code | Meaning | What to do |
|---|---|---|
| `OK` | Connection successful | You are good to go |
| `INVALID_KEY` | The API key is invalid, deleted, or was pasted incompletely | Re-enter the key, or create a new one on the provider key page |
| `PERMISSION_DENIED` | This key cannot access the selected model or workspace | Check account permissions and workspace (Alibaba Cloud: service activated? real-name verified? main account default workspace?) |
| `INSUFFICIENT_BALANCE` | The account balance, free tier, or plan quota is exhausted | Top up in the provider console and retry; the key itself is still valid |
| `RATE_LIMITED` | Too many requests, or the current quota limit was reached | Wait a moment and retry |
| `MODEL_NOT_FOUND` | The selected model is unavailable or has been renamed | Check the model id, or switch back to a recommended preset |
| `REGION_MISMATCH` | The key, the region, and the service endpoint do not match | Switch to the region matching your account (Alibaba Cloud international ≠ mainland) |
| `NETWORK_UNREACHABLE` | Could not reach the provider | Check the network connection and retry |
| `DNS_ERROR` | DNS resolution failed | Check the DNS or proxy settings |
| `TLS_ERROR` | The secure connection failed | Check the system clock, certificates and proxy settings |
| `PROXY_ERROR` | The proxy connection failed | Check that the proxy address works (the vision proxy lives in Settings → Vision & Search) |
| `TIMEOUT` | The connection to the service timed out | Retry once, or switch to a more stable network |
| `PROVIDER_ERROR` | The provider is temporarily failing | Retry later |
| `UNKNOWN_ERROR` | Unknown error | Copy the diagnostics and report it |

Errors marked retryable are usually transient — clicking again a moment later often passes. Expanding "Show technical details" also reveals the error code, the provider's request id and the test time; those three are the most useful things to paste into an issue.

---

## 2. No sound / nothing appears in the transcript

In order:

1. **Is the other side actually making noise?** A meeting or video is playing, the volume is up, and you can hear it yourself.
2. **Is it the right playback device?** Windows captures system loopback audio — whatever comes out of your current default output device. If the meeting app sends audio somewhere else, there is nothing to capture.
3. **Is another app holding the device exclusively?** Some recorders, DAWs and exclusive-mode players do. Close them and press "▶ Start" again.
4. **Is the engine up?** Check the status bar. If it stays on "Loading model…", click the service chips to open the Service status panel and see which service never connected.
5. **Re-run the audio check:** Settings → "Run the setup wizard again", step 4, which has a live level meter.

macOS has no system loopback capture: install a virtual device such as BlackHole and select it under Settings → other-party audio input. See [docs/macos/SETUP.md](../macos/SETUP.md).

## 3. Transcription works, but there are no AI answers

- "AI answers are not configured yet" in the panes: no LLM key is stored. Transcription and answers are independent services; missing one never disables the other. Add the key in Settings, or re-run the setup wizard.
- Answers error out while transcription is fine: usually a provider-side problem (balance, rate limit, model id). Hit "Test connection" on the AI-answers key and look the code up in the table above.
- "Auto" never fires: it only triggers on question-like lines from the other party, and never on your own microphone. Use "⚡Ans" on a line to force an answer.

## 4. The local transcription engine will not start

This affects only the local sidecar ASR and local Whisper backends. **Cloud transcription is unaffected.**

- The installer ships neither Python nor model weights. Local backends need an environment you provide — see [docs/windows/SETUP.md](../windows/SETUP.md).
- The first run downloads the model from ModelScope / HuggingFace (~880 MB for paraformer, ~1.7 GB for Nano, ~1.7 GB for MOSS). The UI stays on "loading" for the whole download; a run that is not ready after 15 minutes times out.
- Common messages:
  - `no usable Python found (tried …)`: none of the candidate interpreters ran. Create a `.venv` or set `MC_FUNASR_PYTHON` to the full path of one.
  - `the local ASR engine exited (code …); check the conda env "funasr"`: Python started but the script died, usually incomplete dependencies.
  - `sidecar script not found: …`: the sidecar script is missing from the install directory; reinstall.
- To keep working right now: Settings → ASR backend → "Cloud streaming", and add an Alibaba Cloud key.

## 5. Windows says "Windows protected your PC"

- The installers are **not code-signed** (functionality is unaffected), and SmartScreen shows that warning for every unsigned app.
- After confirming the file came from the [official Releases page](https://github.com/lakaka2970/MeetingAssistant-main/releases/latest), click "More info" → "Run anyway".
- Better: verify the SHA256. Every `.exe` ships with a matching `.exe.sha256` containing the hash CI computed. Run `Get-FileHash .\MeetingAssistant-<version>-win-x64.exe -Algorithm SHA256` in PowerShell and compare.
- Code signing is planned for a later release. Until then, download only from the official release page.

## 6. The window disappeared

The main window deliberately stays out of the taskbar, so after hiding it there are two ways back:

- press the show/hide hotkey (`Control+B` by default);
- click the MeetingAssistant icon in the system tray, or pick "Show window" from its menu.

If another app already owns that hotkey, registration fails and the app shows a tray notification naming the keys that could not be registered — the tray is the fallback for exactly that case. You can also pick a different combination in Settings.

## 7. A saved API key stopped working

- If you ever saw the "This system cannot use secure credential storage" warning, keys on this machine could only be obfuscated. Fix the credential service and save the key again.
- After switching Windows accounts, reinstalling the OS, or copying the config from another machine, DPAPI ciphertext cannot be decrypted any more — re-enter the keys.

## 8. What stealth mode does and does not do

- Windows: the window is excluded from supported capture paths (screen recording, meeting sharing, screenshots).
- macOS: recent ScreenCaptureKit clients may still capture it. Best-effort, not a guarantee.
- The region-screenshot selection overlay is content-protected too, so it never shows up in a recording.

---

## 9. The phone cannot reach the PC (dual-screen / phone display)

Work through this in order:

1. **Firewall**: the first time Windows starts listening it shows a prompt — you must click **Allow** and tick **Private networks**. If you cancelled, the phone can never connect while the PC looks perfectly healthy. Re-enable listening from Settings → General → Phone display (or the title-bar **Dual-screen**) or allow the app in Windows Defender Firewall.
2. **Same subnet**: phone and PC must be on the same Wi-Fi; turn off the phone's mobile-data fallback or the request may not take the LAN route.
3. **Is anything listening**: if the connect window says "not listening", the reason appears next to it. When port 18765 is taken the app automatically moves to the next free port, and the connect window always shows the real one; you can also pick a different port under Settings → General → Phone display.
4. **Tell the cert errors apart**: `ERR_CERT_AUTHORITY_INVALID` → tap "Advanced → Continue". `ERR_CERT_INVALID` is a hard block with no bypass — press **"Switch to HTTP"** in the connect window (the phone then cannot keep the screen awake).
5. **http auto-upgraded**: if the address is `http://` but the phone still reports `ERR_PROTOCOL_ERROR`, the browser upgraded it to https — type the full `http://` prefix or disable "always use secure connections" in the browser.
6. **Pairing code**: the 6-digit code is shown **only on the PC**, never on the phone. After tapping "Request pairing" on the phone, read the code from the connect window. If a code expires, request a new one.

## 10. A phone control does not take effect (dual-screen remote control)

1. **No control bar on the phone**: the master switch **Settings → General → Phone display → Allow remote control** is off, or that item's individual grant is (a revoked item is *removed* from the phone page, not greyed out). The phone reads its permissions **when it connects**, so after changing them on the PC, reopen the phone page once. The reverse needs no reconnect: turn a grant off and the control stays on the phone, but tapping it gets an explicit refusal ("this item is not authorised on the PC").
2. **A tap ends up marked 未确认 (not confirmed)**: the PC did not report the new value back within 1.5 s.
   - **Transcript · Start**: the browser capture path on Windows needs a *real* tap on the page before it may record audio, and without local native capture there is no other path. To start the transcript reliably, press **▶ Start** on the PC.
   - **Continuous answering**: this switch lives in the main window. *Hiding* the window is fine — dual-screen works that way — so a persistent 未确认 means the window is shutting down or has not finished loading; reopen the phone page.
   - **Typing a question**: the phone sends text only and the answer arrives on the same stream the desktop uses. With no current session, or no AI configured, no answer appears out of thin air (the desktop would fail the same way).
   - **Answer history**: if the panel stays on "PC did not answer", there is no session data to send back; press **Reload**.
3. **"Too many taps, wait a moment"**: each connection is limited to 5 commands per second; pause and tap again.
4. **Nothing pops up on the PC**: by design. Remote control deliberately does not interrupt the screen you are sharing, so confirmation lives only on the phone — read the colour of the control you just tapped.

## 11. Answer style, prompts and knowledge import

1. **The model stopped showing its reasoning / answers got shorter**: as of v1.0.1 **thinking effort defaults to off**, and an upgraded machine loads its old settings as off too. That is intentional — hidden reasoning is paid for in first-token latency and tokens. To bring it back: Settings → Model → **Thinking effort** → low / medium / high (the control only appears for models that expose a thinking mode); **Follow default** sends no thinking parameter at all.
2. **Answers feel too long or too written-down**: change length and register in the title-bar **🎚 Answer style** — the next answer uses it. The default pair is standard + work, i.e. the length the previous version produced; if it feels short, that is the rung, not a lost setting.
3. **An enabled persona seems to do nothing**: a persona only rides the prompt when it is **selected** in 🎚. And "Draft from resume/JD" merely fills the editor — until you press Save the library has no such persona. A persona changes tone, stance and verbosity; it never invents experience your resume does not contain.
4. **You edited a prompt layer and want it back**: Settings → General → Advanced → **Advanced prompt editor**, where each layer has its own *restore default*. **An empty box means "use the built-in wording"** — the grey text in it *is* that wording. Check the **assembled preview** underneath afterwards; that is literally the prefix being sent.
5. **Import says "skipped · no extractable text (scanned/image-only)"**: that PDF has no text layer, and this release ships **no OCR**, so nothing can be indexed. Re-export it as a text PDF (or convert to `.docx`) and import again.
6. **Importing again reports every file as "unchanged"**: that is the skip logic working — mtime and size first, then a content hash, so an unchanged file is neither parsed nor re-embedded. To force a rebuild, change the file or delete that entry and re-import.
7. **`.doc / .ppt` reports "unsupported format"**: legacy 97-2003 OLE binaries have no reliable pure-JS parser; save them as `.docx` / `.pptx` first.
8. **The ⚡Ans button is gone**: the transcript became **chat bubbles**, so ⧉ / translate / ⚡Ans appear when you **hover** (or Tab to) a line. **Clicking a bubble no longer expands it** — the full-transcript panel is behind **⤢** in the rail header, and the old answers collapsed into one "Answer history · N" row that expands with ▸.

## Still stuck

1. Settings → General → "Diagnostics" (also in the title-bar `⋯` menu) → "Copy diagnostics". The report is built locally and copied to the clipboard only (nothing is written to disk); it contains **no API keys, resume/JD text or transcripts**, so it is safe to paste into a public issue.
2. Open an issue at [GitHub Issues](https://github.com/lakaka2970/MeetingAssistant-main/issues) with the report and: what you did, what you expected, what happened instead.
3. If a provider is involved, include the error code and request id from "Test connection".
