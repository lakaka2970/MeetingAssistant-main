import type { UiLang } from '../shared/protocol';
import type { TrayMenuLabels } from '../shared/trayMenu';

/**
 * Main-process user-facing strings (dialogs, overlay tip, high-visibility
 * errors). The renderer chrome has its own dictionary in src/i18n.tsx; deep
 * engine diagnostics stay untranslated on purpose.
 */
const zh = {
  regionTip: '拖动框选要识别的区域 · Esc 取消',
  kbImportTitle: '导入个人知识库（md/txt/docx/pdf/pptx，单文件）',
  kbImportFilesTitle: '导入知识文档（md/txt/docx/pdf/pptx，可多选）',
  kbImportDirTitle: '导入文件夹（递归读取其中的文档）',
  kbBindTitle: '选择已分块的知识库文件夹（含 991_index.jsonl）',
  docFilter: '文档',
  pickResumeTitle: '导入我的简历（md/txt/docx/pdf/pptx）',
  pickJdTitle: '导入岗位JD（md/txt/docx/pdf/pptx）',
  examBindTitle: '选择题库目录（题目卷/答案卷成对的 PDF、md、json、csv）',
  noApiKey: '未设置 API Key，请在设置里填入后重试',
  noApiKeyShort: '未设置 API Key',
  personaNoMaterial: '还没有可分析的简历或岗位JD：先在提词卡导入资料，或直接在设置里手写一份人设',
  personaDraftEmpty: '模型没有返回可用内容，请稍后重试或直接手写一份人设',
  noVision: '未配置视觉模型：请在设置里填 Vision Base URL / 模型 / Key（如 MiMo / Gemini）',
  sidecarFail: (msg: string) => `本地 ASR 引擎启动失败：${msg}`,
  /** wraps the ASR worker's own (English, log-friendly) engine diagnostics */
  asrEngineFail: (msg: string) => `语音识别引擎异常：${msg}`,
  setupQuitTitle: '尚未完成配置',
  setupQuitMessage: '配置尚未完成，确定退出吗？可稍后从设置中重新打开向导。',
  setupQuitConfirm: '退出',
  setupQuitCancel: '继续配置',
  tray: {
    brand: 'MeetingAssistant',
    showWindow: '显示窗口',
    hideWindow: '隐藏窗口',
    startCapture: '开始转写',
    stopCapture: '停止转写',
    newSession: '新建会话',
    settings: '设置',
    serviceStatus: '服务状态',
    help: '帮助与教程',
    checkUpdates: '检查更新',
    quit: '退出',
    capturing: '转写中',
  } satisfies TrayMenuLabels,
  trayNoticeTitle: 'MeetingAssistant 仍在运行',
  trayNoticeBody: '窗口已隐藏，可从系统托盘图标重新打开；托盘菜单里也能直接退出。',
  hotkeyFailTitle: '部分热键注册失败',
  hotkeyFailBody: (keys: string) =>
    `以下热键被其他程序占用或格式无效，已停用：${keys}。可在 设置→通用 中修改。`,
  // 截屏问答管线里 renderer 原样展示的三条引导语
  shotNoQuestionWhole: '整屏里没有找到题目，请用框选（Ctrl+Alt+S）圈出题干后重试',
  shotNoQuestionRegion: '截屏里没有识别出题面，请框选题目区域后重试',
  shotAmbiguous: (frag: string) =>
    `屏幕上还有另一道题像是候选：${frag}。我按上面这道作答，答错了请重新框选那一道。`,
  shotWebMiss:
    '题库和本地知识素材里都没有这道题，联网检索也未启用（设置 → 联网搜索），以下答案来自模型自身知识。',
  shotCaptureEmpty: '整屏抓取为空：桌面可能已锁定，或远程会话已断开',
  noModelAny:
    '无法读屏：还没有任何模型服务可用。请先在设置（或首次向导）里配好文本大模型的 Base URL 与 API Key。',
  noModelVision: (base: string) =>
    `无法读屏：文本服务商 ${base} 没有可用的视觉模型。请在 设置 → 视觉模型 里填一个支持图片的模型（DeepSeek 可选 deepseek-flash），或装本地 OCR：npm i tesseract.js 后开启「截图 OCR 前置」。也可以直接把题干粘贴到输入框作答。`,
};

type MainDict = typeof zh;

const en: MainDict = {
  regionTip: 'Drag to select a region · Esc to cancel',
  kbImportTitle: 'Import personal knowledge base (md/txt/docx/pdf/pptx, single file)',
  kbImportFilesTitle: 'Import knowledge documents (md/txt/docx/pdf/pptx, multi-select)',
  kbImportDirTitle: 'Import a folder (recursively reads its documents)',
  kbBindTitle: 'Select a pre-chunked knowledge base folder (containing 991_index.jsonl)',
  docFilter: 'Documents',
  pickResumeTitle: 'Import my resume (md/txt/docx/pdf/pptx)',
  pickJdTitle: 'Import the job description (md/txt/docx/pdf/pptx)',
  examBindTitle: 'Choose the question-bank folder (paired question/answer PDFs, md, json, csv)',
  noApiKey: 'API Key not set — add one in Settings and retry',
  noApiKeyShort: 'API Key not set',
  personaNoMaterial:
    'Nothing to analyse yet: import a resume or job description in the prompt card, or write the persona by hand in Settings',
  personaDraftEmpty: 'The model returned nothing usable — retry later, or write the persona by hand',
  noVision: 'Vision model not configured: set the Vision Base URL / model / key in Settings (e.g. MiMo / Gemini)',
  sidecarFail: (msg: string) => `Local ASR engine failed to start: ${msg}`,
  asrEngineFail: (msg: string) => `Speech recognition engine error: ${msg}`,
  setupQuitTitle: 'Setup is not finished',
  setupQuitMessage:
    'Setup is not finished. Quit anyway? You can reopen the wizard later from Settings.',
  setupQuitConfirm: 'Quit',
  setupQuitCancel: 'Keep setting up',
  tray: {
    brand: 'MeetingAssistant',
    showWindow: 'Show window',
    hideWindow: 'Hide window',
    startCapture: 'Start transcription',
    stopCapture: 'Stop transcription',
    newSession: 'New session',
    settings: 'Settings',
    serviceStatus: 'Service status',
    help: 'Help & guides',
    checkUpdates: 'Check for updates',
    quit: 'Quit',
    capturing: 'transcribing',
  },
  trayNoticeTitle: 'MeetingAssistant is still running',
  trayNoticeBody:
    'The window is hidden — reopen it from the tray icon. The tray menu also has Quit.',
  hotkeyFailTitle: 'Some hotkeys failed to register',
  hotkeyFailBody: (keys: string) =>
    `These hotkeys are already in use or invalid and were disabled: ${keys}. Change them in Settings → General.`,
  shotNoQuestionWhole:
    'No question found on the full screen — press the hotkey again and drag a box around it (Ctrl+Alt+S).',
  shotNoQuestionRegion:
    'No question was recognised in the capture — drag a box around the question and retry.',
  shotAmbiguous: (frag: string) =>
    `Another region looks like a candidate: ${frag}. I answered the one above; if that was wrong, re-capture around the right question.`,
  shotWebMiss:
    'Neither the question bank nor the local knowledge base matched, and web search is off (Settings → Web search). This answer comes from the model alone.',
  shotCaptureEmpty:
    'Full-screen capture came back empty — the desktop may be locked or the remote session disconnected.',
  noModelAny:
    'Cannot read the screen: no model service is configured yet. Set the text model Base URL and API Key in Settings (or the first-run wizard).',
  noModelVision: (base: string) =>
    `Cannot read the screen: the text provider ${base} has no usable vision model. Add an image-capable model under Settings → Vision (for DeepSeek: deepseek-flash), or install local OCR (npm i tesseract.js) and enable the screenshot OCR prefilter. You can also paste the question text directly.`,
};

const dicts: Record<UiLang, MainDict> = { zh, en };

export function mainStrings(lang: UiLang | undefined, fallback: UiLang): MainDict {
  return dicts[lang ?? fallback];
}
