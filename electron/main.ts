/**
 * MeetingAssistant main process: overlay window, stealth, hotkeys,
 * settings, IPC hub, ASR worker host. PLAN.en.md §5.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'fs';
import { release } from 'os';
import { join, relative, sep } from 'path';
import {
  captureKindForPlatform,
  whisperExecutionProvidersForPlatform,
} from '../shared/platform';
import { AsrHost } from './asrHost';
import {
  LocalPythonProbe,
  buildDiagnosticsReport,
  recentDiagnosticErrors,
  recordDiagnosticError,
} from './diagnostics';
import { openExternalUrl } from './externalLinks';
import { FunasrSidecar, parseLocalWsPort, pythonCandidates, resolvePython } from './funasrSidecar';
import { resolveTestApiKey, runProviderTest, withoutCandidateKey } from './providerTest';
import { getResourceRoot } from './resourcePaths';
import { SettingsStore, plainCipher, type SecretCipher } from './settings';
import { SETUP_READY_MARKER, createSetupWindow } from './setupWindow';
import { AppTray, trayIconPath } from './tray';
import { isRendererCommand, type TrayCommand, type TrayMenuState } from '../shared/trayMenu';
import { KnowledgeStore } from './knowledge';
import { KnowledgeFileStore } from './knowledgeFiles';
import { SessionStore } from './sessions';
import { RagService } from './rag/service';
import { SkillsManager } from './skills/manager';
import { extractMemoFacts, formatFactsHint } from './consistency/facts';
import { NativeAudioCapture } from './audio/nativeCapture';
import { decideRoute, ocrDataUrl } from './vision/ocrPrefilter';
import type { RagHitView } from '../shared/protocol';
import { DOC_EXTENSIONS, LIBRARY_EXTENSIONS, extractDocText, isLibraryExtension } from './docparse';
import { basename } from 'path';
import { chatOnce, chatStream, type ChatResult } from './llm/adapter';
import {
  FailureBook,
  planBackends,
  resolveEndpointForPreset,
  streamWithFallback,
  type Endpoint,
} from './llm/router';
import { visionChat } from './llm/vision';
import {
  buildAnswerMessages,
  buildMemoUpdateMessages,
  buildOcrAnswerMessages,
  buildPrewarmMessages,
  buildStablePrefix,
  buildTranslateMessages,
  buildVisionMessages,
  clampMemo,
  classifyQuestion,
} from './llm/prompts';
import type { AppInfo, KnowledgeFilesState, KnowledgeImportResult, PublicSettings, UiLang } from '../shared/protocol';
import {
  IPC,
  type AsrEvent,
  type LlmAskPayload,
  type LlmEvent,
  type OnboardingCompletePayload,
  type OnboardingProgressPatch,
  type ProviderTestRequest,
  type ProviderTestResult,
  type SettingsPatch,
} from '../shared/protocol';
import { mainStrings } from './uiStrings';

const MODEL_ID = 'onnx-community/whisper-large-v3-turbo-ONNX';

/** tray 「检查更新」 (Phase 4). A real updater is Phase 5; until then the honest
 * answer is the releases page, opened through the same allowlist as every other
 * documentation link. */
const RELEASES_URL = 'https://github.com/lakaka2970/MeetingCopilot-main/releases/latest';

/** Region-selection overlay: shows the captured screen as an opaque bg (so a
 * content-protected window never renders black locally) and lets the user drag
 * a rectangle. Uses window.mc from the shared preload. */
const regionOverlayHtml = (tip: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none}
#img{position:fixed;inset:0;width:100vw;height:100vh;object-fit:fill}
#dim{position:fixed;inset:0;background:rgba(0,0,0,0.35)}
#sel{position:fixed;display:none;border:2px solid #2a6df4;box-shadow:0 0 0 9999px rgba(0,0,0,0.35)}
#tip{position:fixed;top:14px;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,0.65);padding:6px 14px;border-radius:8px;font:13px 'Microsoft YaHei',sans-serif;z-index:9}
</style></head><body>
<img id="img"/><div id="dim"></div><div id="sel"></div>
<div id="tip">${tip}</div>
<script>
(async()=>{try{const u=await window.mc.regionImage();if(u){document.getElementById('img').src=u;}}catch(e){}})();
let sx,sy,drag=false;const sel=document.getElementById('sel'),dim=document.getElementById('dim');
function rect(e){return{x:Math.min(sx,e.clientX),y:Math.min(sy,e.clientY),width:Math.abs(e.clientX-sx),height:Math.abs(e.clientY-sy)};}
function upd(e){const r=rect(e);sel.style.left=r.x+'px';sel.style.top=r.y+'px';sel.style.width=r.width+'px';sel.style.height=r.height+'px';}
addEventListener('mousedown',e=>{drag=true;sx=e.clientX;sy=e.clientY;dim.style.display='none';sel.style.display='block';upd(e);});
addEventListener('mousemove',e=>{if(drag)upd(e);});
addEventListener('mouseup',e=>{if(!drag)return;drag=false;const r=rect(e);if(r.width>4&&r.height>4)window.mc.regionRect(r);else window.mc.regionCancel();});
addEventListener('keydown',e=>{if(e.key==='Escape')window.mc.regionCancel();});
</script></body></html>`;

app.setName('MeetingAssistant');

// E2E/demo hook: run against an isolated profile — must precede the
// single-instance lock so a test instance never collides with a real one
if (process.env.MC_USERDATA) app.setPath('userData', process.env.MC_USERDATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  let win: BrowserWindow | null = null;
  /** first-run wizard window; mutually exclusive with `win` until completion */
  let setupWin: BrowserWindow | null = null;
  /** the wizard was reopened from a running main window (设置 → 重新运行配置
   * 向导 / the upgrade notice). Re-run mode never quits the app. */
  let setupRerun = false;
  let settings: SettingsStore;
  let knowledge: KnowledgeStore;
  let knowledgeFiles: KnowledgeFileStore;
  let sessionStore: SessionStore;
  let rag: RagService;
  let skills: SkillsManager;
  let osLang: UiLang = 'zh';
  /** set by before-quit so window handlers stop prompting mid-shutdown */
  let quitting = false;
  /** an ASR-affecting settings patch arrived while the wizard owned the flow */
  let pendingAsrRestart = false;
  /** renderer capture lifecycle; the tray menu and the diagnostics report read it */
  let capturing = false;
  const asr = new AsrHost();
  const sidecar = new FunasrSidecar();
  const tray = new AppTray();
  /** upgrade P1.5: optional napi-rs loopback — absent artifact = graceful
   * fallback to the renderer Web Audio path (settings.audio.captureBackend) */
  const nativeAudio = new NativeAudioCapture({
    resourceRoot: getResourceRoot(),
    onPcm: (pcm, captureTs) => {
      // copy: the worker owns this Buffer's lifecycle; sendPcm expects an
      // offset-free ArrayBuffer (1600 f32 samples = 6.4 KB — negligible)
      asr.sendPcm(pcm.slice().buffer as ArrayBuffer, captureTs, 'them');
    },
    onError: (message) => {
      console.warn('[native-audio]', message);
      win?.webContents.send(IPC.nativeCaptureError, message);
    },
  });

  /** main-process strings in the current UI language */
  const T = () => mainStrings(settings.data.ui.lang, osLang);

  /** getPublic() + real knowledge char count (KB lives outside settings.json) */
  function publicSettings(): PublicSettings {
    const pub = settings.getPublic();
    pub.knowledge = { chars: knowledge.chars };
    return pub;
  }

  function buildAsrOptions() {
    const a = settings.data.asr;
    const backend = a.backend ?? 'local';
    // each backend has its own config slot so switching never clobbers the others
    let cloud: { baseUrl: string; model: string; apiKey: string } | undefined;
    if (backend === 'local-realtime') {
      // fixed localhost sidecar (auto-spawned); only the model is a choice
      cloud = {
        baseUrl: 'ws://127.0.0.1:10097',
        model: a.localRealtime?.model ?? 'fun-asr-nano',
        apiKey: '',
      };
    } else if (backend === 'cloud-realtime') {
      const rtKey = settings.getRealtimeAsrApiKey() ?? '';
      if (a.realtime?.baseUrl && a.realtime?.model && rtKey) {
        cloud = { baseUrl: a.realtime.baseUrl, model: a.realtime.model, apiKey: rtKey };
      }
    } else if (a.cloud?.baseUrl && a.cloud?.model && settings.getCloudAsrApiKey()) {
      cloud = { baseUrl: a.cloud.baseUrl, model: a.cloud.model, apiKey: settings.getCloudAsrApiKey()! };
    }
    return {
      // the worker treats both realtime flavors identically (same WS engine)
      backend: (backend === 'local-realtime' ? 'cloud-realtime' : backend) as
        | 'local'
        | 'cloud'
        | 'cloud-realtime',
      modelsDir: a.modelsDir ?? join(app.getPath('userData'), 'models'),
      modelId: MODEL_ID,
      ep: whisperExecutionProvidersForPlatform(process.platform),
      language: a.language,
      cloud,
      // upgrade P1: English fast lane (moonshine-tiny) + strategy mode
      strategy:
        backend === 'local' && a.moonshineEnabled
          ? {
              mode: a.strategy ?? 'balanced',
              moonshine: true,
              remoteHost: settings.data.rag?.remoteHost ?? 'https://hf-mirror.com',
            }
          : undefined,
    };
  }

  /** start the ASR worker; a local ws:// realtime backend auto-spawns the
   * python sidecar first (selecting the preset is all the user does) */
  async function startAsr(): Promise<void> {
    const opts = buildAsrOptions();
    const port = opts.backend === 'cloud-realtime' ? parseLocalWsPort(opts.cloud?.baseUrl) : null;
    if (port) {
      try {
        // NOT app.getAppPath(): packaged that resolves inside app.asar, which
        // python cannot read and the OS cannot use as a spawn cwd
        await sidecar.ensureRunning(port, getResourceRoot(), opts.cloud?.model);
        console.log(`[sidecar] local ASR ready on :${port}`);
      } catch (e) {
        const message = T().sidecarFail((e as Error).message);
        console.error(`[sidecar] ${message}`);
        recordDiagnosticError('sidecar', (e as Error).message);
        win?.webContents.send(IPC.asrEvent, { kind: 'error', message, fatal: true });
        return;
      }
    } else {
      await sidecar.stop(); // switched away from local — reclaim its RAM/VRAM
    }
    asr.start(opts);
  }

  const safeCipher: SecretCipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    secure: true,
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };

  function cipher(): SecretCipher {
    if (safeCipher.available()) return safeCipher;
    console.warn('[security] OS secret storage unavailable; API keys will only be obfuscated');
    return plainCipher;
  }

  // ---- window visibility + system tray ----------------------------------
  // Quit/hide matrix (Phase 4):
  //   hide  (hotkey / 「—」 / tray toggle) -> window stays alive, app keeps
  //         running, tray is the way back; NEVER quits.
  //   quit  (titlebar ✕ / tray 退出 / OS shutdown) -> app.quit() -> before-quit
  //         reaps the ASR utilityProcess, the python sidecar and the tray.
  //   first-run wizard closed without completing -> app.quit() (Phase 2), since
  //         nothing is configured and no main window exists yet.
  //   re-run wizard closed -> main window keeps running; window-all-closed does
  //         not fire because the overlay is still open (possibly hidden).

  function showWindow(): void {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function toggleWindow(): void {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else showWindow();
  }

  function trayState(): TrayMenuState {
    return { windowVisible: !!win?.isVisible(), capturing };
  }

  /** rebuild the tray menu — call after anything the menu shows has changed */
  function refreshTray(): void {
    tray.refresh();
  }

  /**
   * Effective content protection. The 隐身 toggle is the user's preference;
   * while a meeting is being captured the window is ADDITIONALLY forced
   * content-protected so it can never leak into a shared screen (auto-hide).
   * setContentProtection(true) → WDA_EXCLUDEFROMCAPTURE (Windows) /
   * NSWindowSharingNone (macOS): the window stays interactive locally but is
   * invisible to screen capture. Restored to the preference on capture stop.
   */
  function applyStealth(): void {
    if (!win) return;
    win.setContentProtection(settings.data.ui.stealth || capturing);
  }

  function handleTrayCommand(command: TrayCommand): void {
    if (command === 'quit') {
      app.quit();
      return;
    }
    if (command === 'toggle-window') {
      toggleWindow();
      return;
    }
    if (command === 'check-updates') {
      void openExternalUrl(RELEASES_URL);
      return;
    }
    if (isRendererCommand(command)) {
      // capture, sessions and the panels live in the renderer; a hidden window
      // would swallow the result, so make it visible first
      showWindow();
      win?.webContents.send(IPC.trayCommand, { command });
    }
  }

  function ensureTray(): void {
    if (tray.exists) return;
    tray.create({
      iconPath: trayIconPath(getResourceRoot()),
      labels: () => T().tray,
      state: trayState,
      onCommand: handleTrayCommand,
      onClick: toggleWindow,
      onDoubleClick: showWindow,
    });
  }

  /** one-shot balloon the first time the window disappears (spec §A) */
  function noticeWindowHidden(): void {
    if (!tray.exists || settings.data.ui.trayNoticeShown) return;
    settings.applyPatch({ ui: { trayNoticeShown: true } });
    const t = T();
    tray.notifyHidden(t.trayNoticeTitle, t.trayNoticeBody);
    console.log('[tray] hide notice shown once');
  }

  /**
   * 开机自动启动. Deliberately inert in development: `setLoginItemSettings`
   * would register the electron.exe dev launcher (and on Linux Electron does
   * not implement it at all), so the stored intent is kept and applied by the
   * installed build instead.
   */
  function applyAutoLaunch(enabled: boolean): void {
    if (process.platform === 'linux') return;
    if (!app.isPackaged) {
      console.log(`[autolaunch] ${enabled ? 'on' : 'off'} stored; not applied in a dev build`);
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (e) {
      console.warn('[autolaunch] could not be applied:', (e as Error).message);
    }
  }

  /** the OS is the source of truth; reconcile it with the stored intent once */
  function syncAutoLaunch(): void {
    if (process.platform === 'linux' || !app.isPackaged) return;
    const wanted = !!settings.data.ui.autoLaunch;
    try {
      if (app.getLoginItemSettings().openAtLogin !== wanted) applyAutoLaunch(wanted);
    } catch (e) {
      console.warn('[autolaunch] could not be read:', (e as Error).message);
    }
  }

  function registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const toggle = settings.data.ui.hotkeyToggle;
    const shot = settings.data.ui.hotkeyShot;
    try {
      if (toggle) {
        const ok = globalShortcut.register(toggle, () => toggleWindow());
        if (!ok) console.warn(`[main] hotkey ${toggle} registration failed (in use?)`);
      }
      if (shot) {
        const ok = globalShortcut.register(shot, () => win?.webContents.send(IPC.shotHotkey));
        if (!ok) console.warn(`[main] shot hotkey ${shot} registration failed (in use?)`);
      }
    } catch (e) {
      console.warn('[main] hotkey register error:', (e as Error).message);
    }
  }

  function createWindow(): void {
    win = new BrowserWindow({
      width: 940,
      height: 560,
      minWidth: 640,
      minHeight: 380,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    applyStealth();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.webContents.on('did-finish-load', () => {
      // replay cached ASR state for late-attaching renderer
      if (asr.lastReady) win?.webContents.send(IPC.asrEvent, asr.lastReady);
      if (asr.lastStatus) win?.webContents.send(IPC.asrEvent, asr.lastStatus);
      if (process.env.MC_AUTOSTART === '1') {
        // executeJavaScript(code, true) supplies the user gesture that
        // getDisplayMedia needs — used by the E2E smoke test.
        void win?.webContents.executeJavaScript(
          'window.__mcAutoStart && window.__mcAutoStart()',
          true,
        );
      }
      // E2E: exercise the FULL renderer->IPC->main->LLM->stream->renderer path.
      if (process.env.MC_E2E_LLM) {
        const q = process.env.MC_E2E_LLM;
        const js = `(async()=>{const d=[];const done=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{if(e.kind==='delta')d.push(e.text);else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});window.mc.llmAsk({requestId:'e2e-llm',mode:'free',freeQuestion:${JSON.stringify(q)},recentTranscript:[]});return await done;})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-llm]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-llm] threw', (e as Error).message));
      }
      // Visual QA of the main window (same spirit as MC_SETUP_SHOT for the
      // wizard): open the settings panel, let it paint, capture a PNG.
      if (process.env.MC_MAIN_SHOT) {
        const dir = process.env.MC_MAIN_SHOT;
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const shoot = async (name: string): Promise<void> => {
          const image = await win?.webContents.capturePage();
          if (!image) return;
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.png`);
          writeFileSync(file, image.toPNG());
          console.log(`[main] screenshot ${file}`);
        };
        void (async () => {
          try {
            await win?.webContents.executeJavaScript(
              'window.__mcOpenSettings && window.__mcOpenSettings()',
              true,
            );
            await wait(1200);
            await shoot('main-settings-common');
            // expand 高级 and scroll to it, so the collapsed half is reviewable too
            await win?.webContents.executeJavaScript(
              `(()=>{const p=document.querySelector('.settings');if(!p)return 0;p.querySelectorAll('details').forEach(d=>d.open=true);p.scrollTop=p.scrollHeight;return p.scrollHeight;})()`,
            );
            await wait(600);
            await shoot('main-settings-advanced');
          } catch (e) {
            console.warn('[main] screenshot failed:', (e as Error).message);
          }
        })();
      }
      if (process.env.MC_E2E_SHOT) {
        const q = process.env.MC_E2E_SHOT;
        const js = `(async()=>{const d=[];const done=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{if(e.kind==='delta')d.push(e.text);else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});window.mc.shotAsk({requestId:'e2e-shot',question:${JSON.stringify(q)}});return await done;})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-shot]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-shot] threw', (e as Error).message));
      }
    });

    // the tray menu shows 显示/隐藏窗口, so it has to follow the real state —
    // whichever of the four hide paths was used (hotkey, 「—」, tray, IPC)
    // "where did my window go" is THE support question for a frameless,
    // taskbar-less, content-protected overlay, so both transitions are logged
    win.on('show', () => {
      console.log('[window] shown');
      refreshTray();
    });
    win.on('hide', () => {
      console.log('[window] hidden');
      refreshTray();
      noticeWindowHidden();
    });

    win.on('closed', () => {
      win = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    // the tray belongs to the running app, not to the first-run wizard: an
    // unconfigured machine that closes the wizard must still quit (Phase 2)
    ensureTray();
  }

  /** normal boot: warm the ASR worker, bind hotkeys, show the overlay */
  function startMainApp(): void {
    void startAsr();
    registerHotkeys();
    syncAutoLaunch();
    // warm the embedding model at launch when documents are imported, so the
    // first question recalls them without a cold-start model download
    if (knowledgeFiles.list().length > 0) void rag.ensureReady();
    createWindow();
  }

  /**
   * First-run gate. While the wizard is up there is no ASR worker, no python
   * sidecar, no cloud connection and no LLM prewarm — an unconfigured machine
   * must not spawn anything.
   */
  function openSetupWindow(rerun = false): void {
    if (setupWin) {
      if (setupWin.isMinimized()) setupWin.restore();
      setupWin.show();
      setupWin.focus();
      return;
    }
    setupRerun = rerun;
    const w = createSetupWindow();
    setupWin = w;

    // E2E: drive the wizard->main-app handover without a human click
    if (process.env.MC_E2E_ONBOARDING_COMPLETE === '1') {
      w.webContents.on('did-finish-load', () => {
        void w.webContents.executeJavaScript('window.mcSetup.completeOnboarding({})', true);
      });
    }

    w.on('close', (e) => {
      // completion closes this window programmatically, an OS shutdown /
      // app.quit() must never be blocked by a modal, and a re-run just puts
      // the user back into a working app — no prompt in any of those cases
      if (quitting || setupRerun || settings.data.onboarding.completed) return;
      const t = T();
      const choice = dialog.showMessageBoxSync(w, {
        type: 'warning',
        title: t.setupQuitTitle,
        message: t.setupQuitTitle,
        detail: t.setupQuitMessage,
        buttons: [t.setupQuitConfirm, t.setupQuitCancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice !== 0) e.preventDefault();
    });

    w.on('closed', () => {
      const wasRerun = setupRerun;
      setupWin = null;
      setupRerun = false;
      if (wasRerun) {
        // keys saved before the user backed out still have to reach the engine
        if (pendingAsrRestart) {
          pendingAsrRestart = false;
          void asr.stop().then(() => startAsr());
        }
        win?.focus();
        return;
      }
      // first-run launch closed without finishing => nothing is configured and
      // there is no other window; Phase 4 adds a tray
      if (!settings.data.onboarding.completed) app.quit();
    });
  }

  app.whenReady().then(() => {
    // users who never chose a UI language get their OS language (zh → zh, else en)
    osLang = app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
    settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), cipher(), osLang);
    knowledge = new KnowledgeStore(join(app.getPath('userData'), 'knowledge.md'));
    knowledgeFiles = new KnowledgeFileStore(join(app.getPath('userData'), 'knowledge-files.json'));
    sessionStore = new SessionStore(join(app.getPath('userData'), 'sessions.json'));
    // upgrade P0: L1/L2/L3 knowledge stack — fully lazy (no worker, no disk
    // IO) until the first ingest/search; capture start warms it in background
    rag = new RagService({
      userDataDir: app.getPath('userData'),
      modelsDir: settings.data.asr.modelsDir ?? join(app.getPath('userData'), 'models'),
      getSettings: () => ({
        enabled: settings.data.rag?.enabled !== false,
        model: settings.data.rag?.model ?? 'bge-m3',
        topK: settings.data.rag?.topK ?? 3,
        minScore: settings.data.rag?.minScore ?? 0.2,
        remoteHost: settings.data.rag?.remoteHost ?? 'https://hf-mirror.com',
      }),
      onStatusChange: () => win?.webContents.send(IPC.ragStatusPush, rag.status()),
    });
    // upgrade P3: skills — builtin (resources/skills) + user (userData/skills);
    // the resources root trick mirrors tray icons (repo root in dev)
    skills = new SkillsManager();
    skills.loadFromDirs([
      join(getResourceRoot(), 'resources', 'skills'),
      join(app.getPath('userData'), 'skills'),
    ]);

    // Electron's `audio: loopback` display-media source is Windows-only.
    // macOS/Linux use a selectable ordinary input in the renderer instead.
    if (captureKindForPlatform(process.platform) === 'loopback') {
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
          .catch((e) => {
            console.error('[main] display media handler failed:', e);
            callback({});
          });
      });
    }

    // ---- IPC ----
    ipcMain.on(IPC.capturePcm, (_e, buf: ArrayBuffer, captureTs: number, channel: 'them' | 'me') => {
      asr.sendPcm(buf, captureTs, channel === 'me' ? 'me' : 'them');
    });

    // ---- P1-6: DeepSeek prefix-cache prewarm + keep-warm while capturing ----
    // One max_tokens=1 request with the byte-identical stable prefix builds the
    // provider-side KV cache, so the first real answer prefills at 0.1x price
    // and lower latency. Re-ping when the cache would go cold (same pattern as
    // the ASR 45s keep-warm). Real answer requests refresh the cache themselves.
    const PREWARM_IDLE_MS = 4 * 60_000;
    let lastPrefix: string | null = null;
    let lastPrefixActivity = 0; // last time the answer prefix hit the provider
    let keepWarmTimer: NodeJS.Timeout | null = null;

    /** same material fallback as llmAsk — prewarm MUST match real requests
     * byte-for-byte, personal notes included (upgrade P0) */
    function stablePrefixFor(resume?: string, jd?: string): string {
      const hasMaterial = !!(resume || jd);
      const effResume = resume || (hasMaterial ? '' : knowledge.text);
      return buildStablePrefix(effResume, jd ?? '', settings.data.llm.answerLang, rag.notes.text);
    }

    async function doPrewarm(prefix: string, reason: string): Promise<void> {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey || settings.data.llm.answerWithVision) return; // vision path ≠ DeepSeek
      lastPrefix = prefix;
      lastPrefixActivity = Date.now();
      try {
        const r = await chatOnce(
          { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
          buildPrewarmMessages(prefix),
          { maxTokens: 1 },
        );
        console.log(
          `[prewarm] ${reason}: cache_hit=${r.usage?.prompt_cache_hit_tokens ?? '?'} cache_miss=${r.usage?.prompt_cache_miss_tokens ?? '?'} prompt=${r.usage?.prompt_tokens ?? '?'}`,
        );
      } catch (e) {
        console.warn('[prewarm] failed:', (e as Error).message);
      }
    }

    ipcMain.on(
      IPC.llmPrewarm,
      (_e, payload: { resume?: string; jd?: string; immediate?: boolean } = {}) => {
        const prefix = stablePrefixFor(payload.resume, payload.jd);
        const dirty = prefix !== lastPrefix;
        const cold = Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS;
        if (!dirty && !cold) return;
        if (payload.immediate || capturing) {
          void doPrewarm(prefix, dirty ? 'dirty' : 'refresh');
        } else {
          lastPrefix = null; // mark stale; the next ▶ prewarm sees dirty and reheats
        }
      },
    );

    // last-known capture lifecycle, for the diagnostics report only
    let lastCaptureStartedAt: string | undefined;
    let lastCaptureStoppedAt: string | undefined;

  ipcMain.on(IPC.captureStarted, () => {
    console.log('[main] capture started');
    lastCaptureStartedAt = new Date().toISOString();
    capturing = true;
    applyStealth(); // auto-hide: force content protection while a meeting runs
    refreshTray(); // 开始转写 -> 停止转写
    // upgrade P0: warm the RAG stack in the background (model load/download)
    // so the first retrieval does not pay the cold-start cost mid-meeting
    void rag.ensureReady();
      if (!keepWarmTimer) {
        keepWarmTimer = setInterval(() => {
          if (!capturing || !lastPrefix) return;
          if (Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS) {
            void doPrewarm(lastPrefix, 'keep-warm');
          }
        }, 60_000);
      }
    });
    ipcMain.on(IPC.captureStopped, () => {
      console.log('[main] capture stopped');
      lastCaptureStoppedAt = new Date().toISOString();
      capturing = false;
      applyStealth(); // restore the manual stealth preference
      refreshTray();
      if (keepWarmTimer) {
        clearInterval(keepWarmTimer);
        keepWarmTimer = null;
      }
      asr.flush();
    });
    ipcMain.handle(IPC.settingsGet, () => publicSettings());
    // pull-based replay: renderer asks after subscribing, so instant-ready
    // cloud engines can't race the subscription (stuck "模型加载中" bug)
    ipcMain.handle(IPC.asrReplay, () => ({ ready: asr.lastReady, status: asr.lastStatus }));
    ipcMain.handle(IPC.settingsSet, (_e, patch: SettingsPatch) => {
      settings.applyPatch(patch);
      if (patch.ui?.hotkeyToggle !== undefined || patch.ui?.hotkeyShot !== undefined) {
        registerHotkeys();
      }
      if (patch.ui?.stealth !== undefined) {
        applyStealth();
      }
      // the tray menu is a snapshot: rebuild it in the newly chosen language
      if (patch.ui?.lang !== undefined) refreshTray();
      if (patch.ui?.autoLaunch !== undefined) applyAutoLaunch(patch.ui.autoLaunch);
      // backend/cloud change => rebuild the ASR worker with the new engine.
      // language alone can hot-update without a restart.
      if (
        patch.asr &&
        (patch.asr.backend !== undefined ||
          patch.asr.cloud !== undefined ||
          patch.asr.realtime !== undefined ||
          patch.asr.localRealtime !== undefined)
      ) {
        // While the wizard is up the engine must NOT be rebuilt per key save:
        // on a first run nothing is configured yet (a restart would spawn the
        // local python sidecar the user never agreed to), and in a re-run it
        // would bounce the live engine once per card. The wizard writes its
        // plan as one final patch; the restart happens exactly once after it.
        if (setupWin || !settings.data.onboarding.completed) pendingAsrRestart = true;
        else void asr.stop().then(() => startAsr());
      } else if (patch.asr?.language) {
        asr.setLanguage(patch.asr.language);
      }
      return publicSettings();
    });
    // ---- first-run wizard state (settings v2) ----
    let wizardReadyLogged = false;
    ipcMain.handle(IPC.onboardingGet, (e) => {
      // one-shot boot marker: the wizard's own renderer reached main, which
      // proves setup.html loaded, its module graph ran and the setup preload
      // bridge is live. tools/packaged-smoke.mjs asserts it.
      if (!wizardReadyLogged && setupWin && e.sender === setupWin.webContents) {
        wizardReadyLogged = true;
        console.log(SETUP_READY_MARKER);
      }
      return settings.getOnboarding();
    });
    ipcMain.handle(IPC.onboardingSaveProgress, (_e, patch: OnboardingProgressPatch = {}) =>
      settings.saveOnboardingProgress(patch ?? {}),
    );
    ipcMain.handle(IPC.onboardingComplete, (_e, payload: OnboardingCompletePayload = {}) => {
      const state = settings.completeOnboarding(payload ?? {});
      // create the main window BEFORE closing the wizard: closing the last
      // window first would fire window-all-closed and quit the app mid-handover
      if (!win) {
        // startMainApp() already builds the engine from the finished settings
        startMainApp();
      } else if (pendingAsrRestart) {
        // re-run: the main window kept running, so apply the deferred rebuild
        void asr.stop().then(() => startAsr());
      }
      pendingAsrRestart = false;
      setupWin?.close();
      return state;
    });
    // main window -> "重新运行配置向导" / the upgrade notice
    ipcMain.handle(IPC.onboardingRerun, () => {
      openSetupWindow(true);
      return true;
    });

    // ---- app shell services (wizard + main window) ----
    // The renderer never navigates: window.open is denied and will-navigate is
    // prevented, so documentation links come back here to be validated.
    ipcMain.handle(IPC.externalOpen, (_e, url: unknown) => openExternalUrl(url));
    // read on an explicit paste-button click only — never polled
    ipcMain.handle(IPC.clipboardReadText, () => clipboard.readText());
    ipcMain.handle(
      IPC.appGetInfo,
      (): AppInfo => ({
        version: app.getVersion(),
        platform: process.platform,
        packaged: app.isPackaged,
      }),
    );

    // ---- provider connection tests (Phase 3) ----
    // Runs ONLY on an explicit user action from the wizard or Settings. The
    // candidate key lives in a local const for the duration of one call: it is
    // never persisted here, never logged, and never travels back to the
    // renderer inside the result.
    ipcMain.handle(
      IPC.providerTest,
      async (_e, incoming: ProviderTestRequest): Promise<ProviderTestResult> => {
        const req = incoming ?? ({} as ProviderTestRequest);
        const apiKey = resolveTestApiKey(req, (slot) => settings.getApiKeyForSlot(slot));
        // the plaintext candidate stops here: everything downstream sees a
        // request without it, and the key only as a separate argument
        const request = withoutCandidateKey(req);
        const result = await runProviderTest(
          { ...request, language: request.language ?? settings.data.asr.language },
          apiKey,
        );
        // one dedicated write; applyPatch() would restart the ASR engine
        if (request.slot) {
          settings.recordVerification(request.slot, {
            lastTestAt: new Date().toISOString(),
            lastTestOk: result.ok,
            lastTestCode: result.code,
            latencyMs: result.latencyMs,
          });
        }
        if (!result.ok) {
          recordDiagnosticError(
            `provider-test/${request.capability}`,
            `${result.code} (${request.providerId} ${request.model})`,
          );
        }
        console.log(
          `[provider-test] ${request.capability} ${request.providerId} -> ${result.code} (${result.latencyMs ?? '?'}ms)`,
        );
        return result;
      },
    );

    // ---- local diagnostics (Phase 3) ----
    // Purely local: built on request, returned to the renderer for the user to
    // copy. Nothing is uploaded, nothing is written to disk, and the builder
    // never receives a key, a transcript or any knowledge-base text.
    const pythonProbe = new LocalPythonProbe(() =>
      resolvePython(pythonCandidates(getResourceRoot())),
    );

    ipcMain.handle(IPC.diagnosticsGet, (): string => {
      pythonProbe.start(); // background; 'unknown' until it settles
      const ready = asr.lastReady?.kind === 'ready' ? asr.lastReady : null;
      const status = asr.lastStatus?.kind === 'status' ? asr.lastStatus : null;
      return buildDiagnosticsReport({
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        uiLang: osLang,
        settings: settings.data,
        weakCrypto: settings.getPublic().weakCrypto,
        knowledgeChars: knowledge.chars,
        capture: {
          active: capturing,
          lastStartedAt: lastCaptureStartedAt,
          lastStoppedAt: lastCaptureStoppedAt,
        },
        asr: {
          ready: !!ready,
          ep: ready?.ep,
          gpuSuspect: ready?.gpuSuspect,
          state: status?.state,
        },
        localPython: pythonProbe.status,
        errors: recentDiagnosticErrors(),
        generatedAt: new Date(),
      });
    });

    ipcMain.handle(IPC.logsOpenFolder, async (): Promise<boolean> => {
      // userData holds settings.json, sessions.json and knowledge.md -- the
      // exact folder a user needs when asked to check or wipe their data
      const err = await shell.openPath(app.getPath('userData'));
      if (err) console.warn('[diagnostics] could not open the data folder:', err);
      return err === '';
    });

    ipcMain.handle(IPC.knowledgeImport, async () => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportTitle,
        filters: [{ name: 'Markdown/Text', extensions: ['md', 'markdown', 'txt'] }],
        properties: ['openFile'],
      });
      if (!r.canceled && r.filePaths[0]) {
        try {
          knowledge.setFromText(readFileSync(r.filePaths[0], 'utf8'));
          // upgrade P0: the global KB also becomes L3 vector memory
          const res = await rag.ingest({
            text: knowledge.text,
            source: 'knowledge',
            ref: basename(r.filePaths[0]),
            replace: true,
          });
          if (res) console.log(`[rag] knowledge ingest: ${res.added}/${res.total} chunks`);
        } catch (e) {
          console.error('[knowledge] import failed:', (e as Error).message);
        }
      }
      return { chars: knowledge.chars };
    });
    ipcMain.handle(IPC.knowledgeClear, () => {
      knowledge.clear();
      const dropped = rag.clearSource('knowledge');
      if (dropped) console.log(`[rag] knowledge clear: dropped ${dropped} chunks`);
      return { chars: knowledge.chars };
    });

    // ---- document library (multi-file knowledge base) ----
    // Import many files / a whole directory into the L3 semantic-recall index
    // (source 'doc', one ref per file) so answers recall them by relevance
    // instead of stuffing everything into the always-in-context prompt.

    /** recursive walk; skips hidden entries and unsupported extensions */
    function walkLibraryDir(dir: string, out: string[], depth = 0): void {
      if (depth > 12) return; // guard against pathological nesting / symlink loops
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        console.warn(`[knowledge-files] cannot read ${dir}:`, (e as Error).message);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) walkLibraryDir(full, out, depth + 1);
        else if (ent.isFile() && isLibraryExtension(ent.name)) out.push(full);
      }
    }

    /** unique RAG ref for one file; re-importing the same path keeps its ref */
    function libraryRefFor(filePath: string, root?: string): string {
      const existing = knowledgeFiles.list().find((f) => f.path === filePath);
      if (existing) return existing.ref;
      const base = root
        ? relative(root, filePath).split(sep).join('/')
        : basename(filePath);
      if (!knowledgeFiles.hasRef(base)) return base;
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      let n = 2;
      while (knowledgeFiles.hasRef(`${stem} (${n})${ext}`)) n++;
      return `${stem} (${n})${ext}`;
    }

    async function ingestLibraryFiles(files: string[], root?: string): Promise<KnowledgeImportResult> {
      const out: KnowledgeImportResult = { imported: 0, skipped: 0, failed: 0, chars: 0, chunks: 0 };
      for (const filePath of files) {
        try {
          const text = await extractDocText(filePath);
          if (!text.trim()) {
            out.skipped++; // scanned/image-only PDF or empty file
            continue;
          }
          const ref = libraryRefFor(filePath, root);
          const res = await rag.ingest({ text, source: 'doc', ref, replace: true });
          out.imported++;
          out.chars += text.length;
          out.chunks += res?.added ?? 0;
          knowledgeFiles.upsert({
            ref,
            name: basename(filePath),
            path: filePath,
            chars: text.length,
            addedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.warn(`[knowledge-files] import failed ${filePath}:`, (e as Error).message);
          out.failed++;
        }
      }
      console.log(
        `[knowledge-files] import: ${out.imported} imported, ${out.skipped} skipped, ${out.failed} failed, ${out.chunks} chunks`,
      );
      return out;
    }

    ipcMain.handle(IPC.knowledgeImportFiles, async (): Promise<KnowledgeImportResult> => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportFilesTitle,
        filters: [{ name: T().docFilter, extensions: [...LIBRARY_EXTENSIONS] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || !r.filePaths.length) {
        return { imported: 0, skipped: 0, failed: 0, chars: 0, chunks: 0 };
      }
      return ingestLibraryFiles(r.filePaths);
    });

    ipcMain.handle(IPC.knowledgeImportDir, async (): Promise<KnowledgeImportResult> => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportDirTitle,
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) {
        return { imported: 0, skipped: 0, failed: 0, chars: 0, chunks: 0 };
      }
      const files: string[] = [];
      walkLibraryDir(r.filePaths[0], files);
      if (!files.length) {
        return { imported: 0, skipped: 0, failed: 0, chars: 0, chunks: 0 };
      }
      return ingestLibraryFiles(files, r.filePaths[0]);
    });

    ipcMain.handle(IPC.knowledgeFilesList, (): KnowledgeFilesState => knowledgeFiles.state());

    ipcMain.handle(IPC.knowledgeRemoveFile, (_e, ref: string): KnowledgeFilesState => {
      knowledgeFiles.remove(ref);
      const dropped = rag.removeDocument(ref);
      if (dropped) console.log(`[knowledge-files] removed "${ref}": dropped ${dropped} chunks`);
      return knowledgeFiles.state();
    });

    ipcMain.handle(IPC.knowledgeFilesClear, (): KnowledgeFilesState => {
      knowledgeFiles.clear();
      const dropped = rag.clearSource('doc');
      if (dropped) console.log(`[knowledge-files] cleared library: dropped ${dropped} chunks`);
      return knowledgeFiles.state();
    });
    ipcMain.handle(IPC.knowledgePick, async (_e, slot: 'resume' | 'jd' = 'resume', sessionId?: string) => {
      const r = await dialog.showOpenDialog({
        title: slot === 'jd' ? T().pickJdTitle : T().pickResumeTitle,
        filters: [{ name: T().docFilter, extensions: [...DOC_EXTENSIONS] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      try {
        // deterministic parse (mammoth / pdf-parse) — no LLM in the loop;
        // '' for scanned PDFs, the renderer warns the user
        const text = await extractDocText(r.filePaths[0]);
        // upgrade P0: session material also lands in the vector index
        void rag.ingestSessionMaterial(slot, sessionId, basename(r.filePaths[0]), text);
        return { name: basename(r.filePaths[0]), text, chars: text.length };
      } catch (e) {
        console.error('[knowledge] pick failed:', (e as Error).message);
        return null;
      }
    });
    ipcMain.handle(IPC.sessionsLoad, () => sessionStore.load());
    ipcMain.on(IPC.sessionsSave, (_e, data) => sessionStore.save(data));

    // ---- upgrade P0: RAG knowledge layers + L2 notes IPC ----
    ipcMain.handle(IPC.ragStatus, () => rag.status());
    ipcMain.handle(IPC.ragSearch, async (_e, p: { query: string; sessionId?: string }) => {
      const r = await rag.searchForUi(String(p?.query ?? ''), p?.sessionId);
      return { hits: r.hits, ms: r.ms };
    });
    ipcMain.handle(IPC.ragReindex, async (_e, p: { model?: string } = {}) => {
      if (p?.model) settings.applyPatch({ rag: { model: p.model } });
      const r = await rag.reindex();
      console.log(`[rag] reindex finished: ${r.records} records, failed=${r.failed}`);
      return rag.status();
    });
    ipcMain.handle(IPC.notesGet, () => ({
      text: rag.notes.text,
      chars: rag.notes.chars,
      maxChars: 8000,
    }));
    ipcMain.handle(IPC.notesSet, (_e, p: { text: string }) => {
      const res = rag.notes.setNotes(String(p?.text ?? ''));
      // notes ride the stable prefix → prewarm the new prefix promptly
      if (res.ok) lastPrefix = null;
      return res;
    });
    ipcMain.handle(IPC.skillsList, () =>
      skills.list().map((s) => ({ name: s.name, trigger: s.trigger, description: s.description })),
    );

    // ---- upgrade P1.5: optional native loopback capture ----
    ipcMain.on(IPC.nativeCaptureStart, (_e, deviceId?: string) => {
      if (process.platform !== 'win32') {
        win?.webContents.send(IPC.nativeCaptureError, 'native loopback is Windows-only');
        return;
      }
      nativeAudio
        .start('loopback', deviceId)
        .then(() => console.log('[native-audio] loopback capture started'))
        .catch((e: Error) => {
          console.warn('[native-audio] start failed:', e.message);
          win?.webContents.send(IPC.nativeCaptureError, e.message);
        });
    });
    ipcMain.on(IPC.nativeCaptureStop, () => {
      nativeAudio.stop();
    });

    // ---- region screenshot: capture full screen, let the user drag a region
    // on a STEALTH overlay that shows the capture as its (opaque) background —
    // avoids the transparent-window black-screen bug and is excluded from
    // recording via content protection. Returns the cropped image dataURL. ----
    let regionResolve: ((r: { x: number; y: number; width: number; height: number } | null) => void) | null = null;
    let pendingRegionImage: string | null = null;
    let regionWin: BrowserWindow | null = null;

    ipcMain.handle(IPC.regionImage, () => pendingRegionImage);
    ipcMain.on(IPC.regionRect, (_e, r) => {
      const f = regionResolve;
      regionResolve = null;
      regionWin?.close();
      f?.(r);
    });
    ipcMain.on(IPC.regionCancel, () => {
      const f = regionResolve;
      regionResolve = null;
      regionWin?.close();
      f?.(null);
    });

    ipcMain.handle(IPC.regionPick, async () => {
      const disp = screen.getPrimaryDisplay();
      const sf = disp.scaleFactor;
      const w = Math.round(disp.size.width * sf);
      const h = Math.round(disp.size.height * sf);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      const src = sources.find((s) => s.display_id === String(disp.id)) ?? sources[0];
      if (!src) return null;
      const full = src.thumbnail;
      pendingRegionImage = full.toDataURL();

      const rect = await new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
        regionResolve = resolve;
        const b = disp.bounds;
        const ov = new BrowserWindow({
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          frame: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          hasShadow: false,
          resizable: false,
          movable: false,
          fullscreenable: false,
          enableLargerThanScreen: true,
          webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true },
        });
        regionWin = ov;
        ov.setContentProtection(true); // selection overlay invisible to recording
        ov.setAlwaysOnTop(true, 'screen-saver');
        ov.on('closed', () => {
          if (regionResolve) {
            const f = regionResolve;
            regionResolve = null;
            f(null);
          }
          regionWin = null;
        });
        void ov.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(regionOverlayHtml(T().regionTip)));
      });

      const img = pendingRegionImage;
      pendingRegionImage = null;
      if (!rect || rect.width < 4 || rect.height < 4 || !img) return null;
      try {
        const cropped = full.crop({
          x: Math.round(rect.x * sf),
          y: Math.round(rect.y * sf),
          width: Math.round(rect.width * sf),
          height: Math.round(rect.height * sf),
        });
        return cropped.toDataURL();
      } catch (e) {
        console.error('[region] crop failed:', (e as Error).message);
        return null;
      }
    });
    ipcMain.handle(IPC.stealthSet, (_e, on: boolean) => {
      settings.applyPatch({ ui: { stealth: on } });
      applyStealth();
      return on;
    });
    ipcMain.on(IPC.winHide, () => win?.hide());
    ipcMain.on(IPC.appQuit, () => app.quit());

    // ---- LLM (R4): streaming answers; key stays in the main process ----
    // upgrade P1: per-kind routing + failover; the book remembers providers
    // that just failed so the next request reorders them to the back.
    const llmControllers = new Map<string, AbortController>();
    const llmFailures = new FailureBook();

    const resolvePrimaryEndpoint = (): Endpoint => ({
      baseUrl: settings.data.llm.baseUrl,
      model: settings.data.llm.model,
      apiKey: settings.getLlmApiKey() ?? '',
      label: 'primary',
    });

    ipcMain.on(IPC.llmAsk, async (_e, payload: LlmAskPayload) => {
      const sendEv = (ev: LlmEvent) => win?.webContents.send(IPC.llmEvent, ev);
      const primary = resolvePrimaryEndpoint();
      // keyless primary is only valid for providers that need no key (Ollama)
      if (!primary.apiKey && settings.data.llm.providerId !== 'ollama') {
        sendEv({ requestId: payload.requestId, kind: 'error', message: T().noApiKey });
        return;
      }
      const ac = new AbortController();
      llmControllers.set(payload.requestId, ac);
      const isTranslate = payload.mode === 'translate';
      // session dual-slot material first; the global default KB only fills in
      // when the session has nothing (translate stays a clean pass-through)
      const hasMaterial = !!(payload.resume || payload.jd || payload.background);

      // "answer with multimodal": route through the vision provider (proxy-aware,
      // non-streaming). Otherwise stream from the text LLM (direct, fastest).
      const useVision =
        settings.data.llm.answerWithVision &&
        payload.mode !== 'translate' &&
        !!settings.data.vision.baseUrl &&
        !!settings.data.vision.model &&
        !!settings.getVisionApiKey();

      // upgrade P0: L3 semantic recall — segment/continuous only, served ONLY
      // by an already-ready worker (never blocks a question on a download)
      let ragContext: string[] | undefined;
      let factsHint: string | undefined;
      if (!isTranslate && !useVision && payload.mode !== 'free') {
        const q = payload.question || payload.recentTranscript.at(-1) || '';
        const r = await rag.retrieve(q, payload.sessionId);
        if (r.hits.length) {
          ragContext = r.hits.map(
            (h: RagHitView) => `[${h.source}${h.ref ? '|' + h.ref : ''}] ${h.text}`,
          );
        }
        // upgrade P3: recalled claimed facts keep long sessions self-consistent
        if (r.facts.length) factsHint = formatFactsHint(r.facts.map((f) => f.text));
        if (ragContext || factsHint) console.log(`[rag] ${r.hits.length} hits, ${r.facts.length} facts in ${r.ms}ms`);
      }
      // upgrade P3: /trigger skills steer free-ask behaviour
      let skillInstruction: string | undefined;
      let freeQuestion = payload.freeQuestion;
      if (payload.mode === 'free' && freeQuestion) {
        const skill = skills.match(freeQuestion);
        if (skill) {
          skillInstruction = skill.instruction;
          freeQuestion = skills.stripTrigger(freeQuestion, skill) ?? '';
          console.log(`[skills] matched ${skill.trigger} (${skill.name})`);
        }
      }

      const messages = buildAnswerMessages({
        mode: payload.mode,
        question: payload.question,
        freeQuestion,
        recentTranscript: payload.recentTranscript,
        answerLang: payload.answerLang ?? settings.data.llm.answerLang,
        history: payload.history,
        resume: isTranslate ? undefined : payload.resume,
        jd: isTranslate ? undefined : payload.jd,
        memo: isTranslate ? undefined : payload.memo,
        notes: isTranslate ? undefined : rag.notes.text,
        ragContext: isTranslate ? undefined : ragContext,
        consistencyHint: isTranslate ? undefined : factsHint,
        skillInstruction,
        background: isTranslate ? undefined : payload.background || (hasMaterial ? undefined : knowledge.text),
      });

      const primaryCtx = {
        endpoint: primary,
        providerId: settings.data.llm.providerId,
      };
      const resolve = (presetId: string) =>
        resolveEndpointForPreset(presetId, {
          primary: primaryCtx,
          routeKeys: settings.getRouteKeys(),
        });
      const kind = classifyQuestion(payload.question || payload.recentTranscript.at(-1) || '');
      const plan = llmFailures.reorder(
        planBackends({ mode: payload.mode, kind, routing: settings.data.llm.routing, primary: primaryCtx, resolve }),
      );

      // a real answer request refreshes the provider-side prefix cache itself —
      // but only when the primary endpoint is the one actually serving, since
      // the cache is per provider/model pair
      if (!isTranslate && !useVision && payload.mode !== 'free' && plan[0] === primary) {
        lastPrefix = stablePrefixFor(payload.resume || payload.background, payload.jd);
        lastPrefixActivity = Date.now();
      }

      const work: Promise<{
        text: string;
        usage?: ChatResult['usage'];
        endpoint?: Endpoint;
      }> = useVision
        ? visionChat(
            {
              baseUrl: settings.data.vision.baseUrl!,
              model: settings.data.vision.model!,
              apiKey: settings.getVisionApiKey()!,
              proxyUrl: settings.data.vision.proxyUrl,
            },
            messages,
            ac.signal,
          ).then((text) => {
            sendEv({ requestId: payload.requestId, kind: 'delta', text });
            return { text };
          })
        : streamWithFallback({
            endpoints: plan,
            messages,
            onDelta: (text) => sendEv({ requestId: payload.requestId, kind: 'delta', text }),
            signal: ac.signal,
            // a black-holed routed endpoint must not hang a live answer; only
            // the primary alone is trusted to take as long as it needs
            firstTokenTimeoutMs: plan.length > 1 ? 8000 : 0,
            onAttemptError: (ep, err, hadDelta) => {
              console.warn(
                `[llm] endpoint failed (${ep.label}, deltas=${hadDelta}): ${err.message}`,
              );
              llmFailures.markFailure(ep);
              if (!hadDelta && plan.length > 1) {
                const next = plan[plan.indexOf(ep) + 1];
                if (next) console.log(`[llm] falling back to ${next.label}`);
              }
            },
          });

      work
        .then((r) => {
          if (r.endpoint) llmFailures.markSuccess(r.endpoint);
          const u = r.usage;
          if (u) {
            // prewarm acceptance signal: after a warm, hit ≈ prefix length
            console.log(
              `[llm] done mode=${payload.mode} cache_hit=${u.prompt_cache_hit_tokens ?? '?'} cache_miss=${u.prompt_cache_miss_tokens ?? '?'}`,
            );
          }
          sendEv({
            requestId: payload.requestId,
            kind: 'done',
            text: r.text,
            usage: u
              ? {
                  promptTokens: u.prompt_tokens,
                  completionTokens: u.completion_tokens,
                  promptCacheHit: u.prompt_cache_hit_tokens,
                  promptCacheMiss: u.prompt_cache_miss_tokens,
                }
              : undefined,
          });
        })
        .catch((e: Error) => {
          if (ac.signal.aborted) return; // user cancelled — not an error
          console.error('[llm] request failed:', e.message);
          sendEv({ requestId: payload.requestId, kind: 'error', message: e.message });
        })
        .finally(() => llmControllers.delete(payload.requestId));
    });
    ipcMain.on(IPC.llmCancel, (_e, requestId: string) => {
      llmControllers.get(requestId)?.abort();
      llmControllers.delete(requestId);
    });

    // P1-5: fold a finished Q&A into the rolling interview memo. Async and
    // off the critical answer path — renderer serializes calls per session.
    ipcMain.handle(
      IPC.memoUpdate,
      async (
        _e,
        p: { memo: string; question: string; answer: string; sessionId?: string },
      ): Promise<string> => {
        const apiKey = settings.getLlmApiKey();
        if (!apiKey) return '';
        try {
          const r = await chatOnce(
            { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
            buildMemoUpdateMessages(p.memo ?? '', p.question ?? '', p.answer ?? ''),
            { maxTokens: 700, temperature: 0.2 },
          );
          const memo = clampMemo(r.text);
          // upgrade P3: refresh this session's claimed-fact vectors (off-path)
          if (p.sessionId && memo) {
            void rag
              .ingestFacts(p.sessionId, extractMemoFacts(memo))
              .then((res) => res && console.log(`[rag] facts ingest: ${res.added}/${res.total}`));
          }
          return memo;
        } catch (e) {
          console.warn('[memo] update failed:', (e as Error).message);
          return '';
        }
      },
    );

    // Cheap one-shot translation to Chinese (inline transcript 对照; off-session,
    // no history pollution). Uses the fast text model (deepseek-chat).
    ipcMain.handle(IPC.translateText, async (_e, text: string) => {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey) throw new Error(T().noApiKeyShort);
      const r = await chatStream(
        { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
        buildTranslateMessages(text),
        { onDelta: () => {} },
      );
      return r.text;
    });

    // ---- R5: screenshot -> vision model. Our own window is excluded from
    // the capture automatically (content protection). ----
    ipcMain.on(
      IPC.shotAsk,
      (_e, payload: { requestId: string; question: string; background?: string; imageDataUrl?: string }) => {
      const sendEv = (ev: LlmEvent) => win?.webContents.send(IPC.llmEvent, ev);
      const vision = settings.data.vision;
      const apiKey = settings.getVisionApiKey();
      if (!vision.baseUrl || !vision.model || !apiKey) {
        sendEv({
          requestId: payload.requestId,
          kind: 'error',
          message: T().noVision,
        });
        return;
      }
      const ac = new AbortController();
      llmControllers.set(payload.requestId, ac);
      // region mode provides a pre-cropped image; else capture the full screen
      const imgP = payload.imageDataUrl
        ? Promise.resolve(payload.imageDataUrl)
        : desktopCapturer
            .getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } })
            .then((sources) => sources[0].thumbnail.toDataURL());
      imgP
        .then(async (dataUrl) => {
          // upgrade P2: OCR prefilter — text-rich REGION shots skip the vision
          // model entirely (fast text LLM, streamable). Optional + best-effort.
          const textKey = settings.getLlmApiKey();
          if (payload.imageDataUrl && settings.data.vision.ocrPrefilter && textKey) {
            const ocr = await ocrDataUrl(payload.imageDataUrl);
            if (ocr.ok && decideRoute(ocr.text) === 'text') {
              console.log(`[ocr] text-rich region (${ocr.text.length} chars in ${ocr.ms}ms) → text LLM`);
              const r = await chatStream(
                { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey: textKey },
                buildOcrAnswerMessages(ocr.text, payload.question, payload.background || knowledge.text),
                { onDelta: (text) => sendEv({ requestId: payload.requestId, kind: 'delta', text }) },
                ac.signal,
              );
              return r.text;
            }
          }
          return visionChat(
            { baseUrl: vision.baseUrl!, model: vision.model!, apiKey, proxyUrl: vision.proxyUrl },
            buildVisionMessages(payload.question, dataUrl, payload.background || knowledge.text),
            ac.signal,
          );
        })
        .then((text) => {
          sendEv({ requestId: payload.requestId, kind: 'delta', text });
          sendEv({ requestId: payload.requestId, kind: 'done', text });
        })
        .catch((e: Error) => {
          if (ac.signal.aborted) return;
          console.error('[vision] request failed:', e.message);
          sendEv({ requestId: payload.requestId, kind: 'error', message: e.message });
        })
        .finally(() => llmControllers.delete(payload.requestId));
    });

    // ---- ASR: warm the worker at launch (PLAN §6.3) ----
    asr.onEvent((ev: AsrEvent) => {
      if (ev.kind === 'segment') {
        const e2e = ev.timings.inferEndTs - ev.timings.speechEndTs;
        console.log(`[asr] #${ev.id} (${ev.lang ?? '?'}, ${ev.audioMs}ms audio, e2e ${e2e}ms) ${ev.text}`);
      } else if (ev.kind === 'ready') {
        console.log(`[asr] ready ep=${ev.ep} load=${ev.loadMs}ms warm=${ev.warmMs}ms gpuSuspect=${ev.gpuSuspect}`);
        if (process.env.MC_E2E_QUIT_ON_ASR_READY === '1') {
          setTimeout(() => app.quit(), 250);
        }
      } else if (ev.kind === 'error') {
        console.error(`[asr] error (fatal=${ev.fatal}): ${ev.message}`);
        // only fatal events belong in the support report — a transient
        // per-segment failure would flood the 50-entry buffer
        if (ev.fatal) recordDiagnosticError('asr', ev.message);
        if (ev.fatal) {
          // engine diagnostics are deliberately English (they end up in logs
          // and in the diagnostics report); the sentence AROUND them is the
          // part the user reads, so it gets localized here
          win?.webContents.send(IPC.asrEvent, { ...ev, message: T().asrEngineFail(ev.message) });
          return;
        }
      } else if (ev.kind === 'status') {
        console.log(`[asr] status=${ev.state} queued=${ev.queuedSegments}`);
      }
      win?.webContents.send(IPC.asrEvent, ev);
    });

    // First run (or MC_FORCE_ONBOARDING=1 for testing): the wizard owns the
    // whole startup — no overlay window, no ASR worker, no sidecar spawn.
    if (process.env.MC_FORCE_ONBOARDING === '1' || !settings.data.onboarding.completed) {
      openSetupWindow();
    } else {
      startMainApp();
    }
  });

  app.on('second-instance', () => {
    const target = setupWin ?? win;
    if (target?.isMinimized()) target.restore();
    target?.show();
    target?.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    tray.destroy();
    void asr.stop();
    void sidecar.stop();
    nativeAudio.stop();
    void rag?.dispose(); // flush the pending index write, stop the embed worker
  });

  /**
   * Still a quit, tray or not: hiding the overlay does NOT close it, so this
   * only fires on a real teardown (app.quit() destroying the windows, or the
   * first-run wizard being closed before completion). A "close to tray" app
   * would return here instead — MeetingAssistant deliberately has no window
   * close button that leaves the app running headless without a window.
   */
  app.on('window-all-closed', () => {
    app.quit();
  });
}
