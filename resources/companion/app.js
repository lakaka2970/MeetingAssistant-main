/*
 * MeetingAssistant 手机显示端。
 *
 * 三条延迟纪律，全部来自实测：
 *  1. **流式阶段只追加纯文本**，收到 done 才做一次 Markdown + KaTeX 排版。
 *     每 80ms 重解析整段并重新排版，在手机上是明显掉帧，而文字必须立刻可见。
 *  2. **端到端延迟必须扣掉两机时钟差**。帧/消息里的时间戳是电脑时钟，直接拿
 *     本机 Date.now() 相减会把时钟偏差算成延迟（MyTool 实测曾虚报 906ms，
 *     真实开销约 71ms）。用 ping/pong 估偏差：RTT/2 为单程网络时延。
 *  3. **新内容一律 prepend**。手机浏览器在滚动位置不在底部时不会自动跟随，
 *     把「跟随滚动」的判定留给 isAtBottom，比维护一个滚动锚点可靠。
 */
'use strict';

const statusEl = document.getElementById('status');
const asrChip = document.getElementById('asrChip');
const lagChip = document.getElementById('lag');
const feed = document.getElementById('feed');
const empty = document.getElementById('empty');
const hero = document.getElementById('hero');
const heroKind = document.getElementById('heroKind');
const heroStage = document.getElementById('heroStage');
const heroOrigin = document.getElementById('heroOrigin');
const heroQ = document.getElementById('heroQ');
const heroBody = document.getElementById('heroBody');
const heroMeta = document.getElementById('heroMeta');

const MAX_FEED = 120;
const TOKEN_KEY = 'meetingassistant_token';

/* ---- 跟随视觉视口（双指缩放时重新排版，见 index.html 同名注释）---- */
function syncViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  if (!vv) {
    root.removeProperty('--vv-w'); root.removeProperty('--vv-h');
    root.removeProperty('--vv-x'); root.removeProperty('--vv-y');
    return;
  }
  root.setProperty('--vv-w', vv.width + 'px');
  root.setProperty('--vv-h', vv.height + 'px');
  root.setProperty('--vv-x', vv.offsetLeft + 'px');
  root.setProperty('--vv-y', vv.offsetTop + 'px');
}
let vvPending = false;
function scheduleViewportSync() {
  if (vvPending) return;
  vvPending = true;
  requestAnimationFrame(() => { vvPending = false; syncViewport(); });
}
syncViewport();
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', scheduleViewportSync);
  window.visualViewport.addEventListener('scroll', scheduleViewportSync);
}
window.addEventListener('resize', scheduleViewportSync);
window.addEventListener('orientationchange', scheduleViewportSync);

/* ---- 屏幕常亮 ----
 * Wake Lock 只在安全上下文存在：明文 http://192.168.x.x 下 navigator.wakeLock
 * 是 undefined 且**静默失效**。所以必须特性检测并给出替代做法，而不是让用户
 * 点了才发现没反应。另外它要求可信用户手势（不能自动申请），且切后台会被
 * 浏览器自动释放、回前台不会自动恢复——而「切出去看一眼再回来」恰是常规用法。 */
let wakeLock = null;
let wakeWanted = false;
const wakeBtn = document.getElementById('wakeBtn');
function wakeText(t, on) { wakeBtn.textContent = t; wakeBtn.classList.toggle('on', !!on); }
const WAKE_UNSUPPORTED = '本浏览器不支持常亮（需 HTTPS）：请到系统设置里延长息屏时间';
async function requestWakeLock() {
  if (!navigator.wakeLock) { wakeText(WAKE_UNSUPPORTED, false); return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeWanted = true;
    wakeText('已常亮', true);
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      if (wakeWanted) wakeText('常亮', false);
    });
  } catch (err) {
    wakeText(`常亮失败(${err.name})`, false);
  }
}
wakeBtn.addEventListener('click', () => {
  if (wakeLock) {
    wakeWanted = false;
    wakeLock.release().catch(() => {});
    wakeLock = null;
    wakeText('常亮', false);
  } else requestWakeLock();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && wakeWanted && !wakeLock) requestWakeLock();
});
if (!navigator.wakeLock) wakeText(WAKE_UNSUPPORTED, false);

/* ---- 令牌 ---- */
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function saveToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* 隐私模式 */ } }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = cls; }
function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- 时钟偏差与 ping ---- */
let clockOffset = null;   // 电脑时钟 - 本机时钟
let pingTimer = null;
function startPing(ws) {
  stopPing();
  const doPing = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); };
  doPing();
  pingTimer = setInterval(doPing, 3000);
}
function stopPing() { if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; } }
function handlePong(msg) {
  if (typeof msg.t !== 'number' || typeof msg.pc !== 'number') return;
  const rtt = Date.now() - msg.t;
  if (rtt < 0 || rtt > 60000) return;
  clockOffset = msg.pc - (msg.t + rtt / 2);
  lagChip.textContent = `线路 ${Math.round(rtt / 2)}ms`;
  lagChip.className = 'chip ' + (rtt / 2 < 120 ? 'ok' : 'warn');
}
/** 电脑时刻换成本机时刻；未校准时返回 null，UI 显示「校准中」而不是瞎报一个数 */
function pcToLocal(ts) { return clockOffset === null ? null : ts - clockOffset; }
function sincePc(ts) {
  const local = pcToLocal(ts);
  return local === null ? null : Math.max(0, Date.now() - local);
}
function fmtMs(ms) {
  if (ms === null || ms === undefined) return '校准中';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function clock(ts) {
  const local = ts === undefined ? Date.now() : pcToLocal(ts);
  if (local === null) return '';
  const d = new Date(local);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---- 过滤 ---- */
let filter = 'all';
const filterBtns = [...document.querySelectorAll('.filter button')];
filterBtns.forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.f;
  filterBtns.forEach((x) => x.classList.toggle('on', x === b));
  applyFilter();
}));
function applyFilter() {
  for (const el of feed.children) {
    if (!el.dataset.kind) continue;
    el.hidden = filter !== 'all' && el.dataset.kind !== filter;
  }
}
function isAtBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
}
function prepend(el) {
  const stick = isAtBottom();
  feed.prepend(el);
  if (!stick) el.dataset.pendingNew = '1';
  while (feed.children.length > MAX_FEED) feed.lastElementChild.remove();
  if (empty.parentNode && feed.children.length > 1) empty.remove();
  applyFilter();
}
feed.addEventListener('scroll', () => {
  if (isAtBottom()) {
    for (const el of feed.querySelectorAll('[data-pending-new]')) delete el.dataset.pendingNew;
  }
});

/* ---- 转写行 ---- */
const seenLines = new Set();
function addLine(msg) {
  if (seenLines.has(msg.id)) return;
  seenLines.add(msg.id);
  if (seenLines.size > 600) seenLines.delete(seenLines.values().next().value);
  const el = document.createElement('div');
  el.className = `line ${msg.speaker === 'me' ? 'me' : 'them'}`;
  el.dataset.kind = 'line';
  const lat = sincePc(msg.ts);
  el.innerHTML =
    `<span class="at">${escapeHtml(clock(msg.ts))}</span>` +
    `<span class="who">${msg.speaker === 'me' ? '我' : '对方'}</span>` +
    `<span class="tx"></span>` +
    (lat !== null && lat > 400 ? `<span class="who"> ${escapeHtml(fmtMs(lat))}</span>` : '');
  el.querySelector('.tx').textContent = msg.text;
  prepend(el);
  // 这句话说完了，直播泡里对应的内容就该消失
  if (liveBubble && liveBubble.dataset.speaker === String(msg.speaker)) removeLive();
}

/* ---- 直播泡（partial）---- */
let liveBubble = null;
function showPartial(msg) {
  if (!msg.text) { removeLive(); return; }
  if (!liveBubble) {
    liveBubble = document.createElement('div');
    liveBubble.className = 'line them';
    liveBubble.dataset.kind = 'line';
    liveBubble.style.opacity = '.62';
    liveBubble.innerHTML = '<span class="who">听写中</span><span class="tx"></span>';
    prepend(liveBubble);
  }
  liveBubble.dataset.speaker = String(msg.speaker);
  liveBubble.classList.toggle('me', msg.speaker === 'me');
  liveBubble.classList.toggle('them', msg.speaker !== 'me');
  liveBubble.querySelector('.tx').textContent = msg.text;
}
function removeLive() {
  if (liveBubble && liveBubble.parentNode) liveBubble.remove();
  liveBubble = null;
}

/* ---- 答案卡 ----
 * 同一条问答在手机上走两步：流式期间住在 hero（大字、纯文本、最快可见），
 * 收到 done 后定版进 feed（Markdown + KaTeX），hero 让给下一条。 */
const STAGES = {
  reading: '读题中', searching: '查题库', thinking: '生成中',
  'searching-web': '联网检索', qa: '检索资料', answer: '生成中',
};
const ORIGINS = {
  bank: '题库命中', 'bank+model': '题库 + AI', model: 'AI',
  'model+web': 'AI + 联网', none: '未命中',
};
let current = null;

function newAnswer(id, kind) {
  if (current) archiveCurrent();
  current = {
    id, kind, text: '', state: 'streaming', startedAt: Date.now(),
    serverMs: 0, question: '', qa: '', origin: '', rendered: false,
  };
  hero.hidden = false;
  hero.classList.remove('collapsed');
  heroKind.textContent = kind === 'x' ? '做题答案' : '回答';
  heroStage.textContent = '';
  heroOrigin.textContent = '';
  heroQ.hidden = true;
  heroQ.textContent = '';
  heroMeta.hidden = true;
  heroBody.className = 'plain';
  heroBody.textContent = '';
  return current;
}
function touch(id, kind) {
  return (current && current.id === id) ? current : newAnswer(id, kind);
}
function setStage(id, kind, stage) {
  touch(id, kind);
  heroStage.textContent = STAGES[stage] ? `⋯ ${STAGES[stage]}` : '';
}
function appendDelta(id, kind, text) {
  const a = touch(id, kind);
  a.text += text;
  // 只写 textContent：流式期间绝不重新排版
  heroBody.textContent = a.text;
  heroBody.className = 'plain';
}
function finish(id, kind, text, origin, ms) {
  const a = touch(id, kind);
  if (text && !a.text) a.text = text;
  else if (text && text.length > a.text.length) a.text = text;
  // never downgrade a source already established from an earlier event: an
  // answer that said 「联网」 must not come back labelled as a plain model answer
  if (origin) a.origin = origin;
  a.serverMs = ms || 0;
  a.state = 'done';
  renderHero(a);
}
function renderHero(a) {
  heroBody.className = '';
  heroBody.innerHTML = answerHtml(a);
  typeset(heroBody);
  heroOrigin.textContent = ORIGINS[a.origin] || (a.origin ? a.origin : '');
  heroStage.textContent = a.state === 'error' ? '' : '';
  const wall = Date.now() - a.startedAt;
  heroMeta.hidden = false;
  heroMeta.textContent = a.state === 'error'
    ? '失败'
    : `本机 ${fmtMs(wall)}${a.serverMs ? ` · 电脑侧 ${fmtMs(a.serverMs)}` : ''}`;
}
function answerHtml(a) {
  let html = '';
  if (a.qa) html += `<div class="qa"><b>资料里的原话</b>${escapeHtml(a.qa)}</div>`;
  html += (typeof window.renderMarkdown === 'function')
    ? window.renderMarkdown(a.text)
    : `<p>${escapeHtml(a.text)}</p>`;
  if (a.state === 'error') html += `<p class="failed">⚠ ${escapeHtml(a.error || '失败')}</p>`;
  return html;
}
function typeset(el) {
  // KaTeX 的 /vendor/katex/* 是可选资源：拿不到就退回原始文本，
  // 绝不能因为排版失败让答案整块空白
  if (typeof window.renderMathInElement !== 'function') return;
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
        // 模型很爱写裸 $x$；只在看起来像公式时启用，避免把「价格 $5 和 $6」拆坏
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    });
  } catch { /* 保留原文 */ }
}
function archiveCurrent() {
  if (!current) return;
  const a = current;
  current = null;
  if (!a.text && !a.qa && !a.error) return;
  const el = document.createElement('div');
  el.className = 'ans';
  el.dataset.kind = 'ans';
  const tag = `${a.kind === 'x' ? '做题' : '回答'}${a.origin ? ` · ${ORIGINS[a.origin] || a.origin}` : ''}`;
  el.innerHTML =
    `<div class="tag"><span>${escapeHtml(tag)}</span>` +
    `<span>${escapeHtml(clock())}</span></div>` +
    (a.question ? `<div class="tag"><span>Q：${escapeHtml(a.question.slice(0, 120))}</span></div>` : '') +
    '<div class="body"></div><div class="meta"></div>';
  const body = el.querySelector('.body');
  body.innerHTML = answerHtml(a);
  typeset(body);
  const wall = Date.now() - a.startedAt;
  el.querySelector('.meta').textContent =
    `${fmtMs(wall)}${a.serverMs ? ` · 电脑侧 ${fmtMs(a.serverMs)}` : ''} · 点按展开`;
  el.addEventListener('click', () => el.classList.toggle('open'));
  prepend(el);
}
hero.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') return;
  hero.classList.toggle('collapsed');
});

/* ---- 截图回执 ----
 * 刻意不渲染图片：分析文本才是要看的内容，图片是不可压缩的宽元素，会把
 * 缩放重排的布局搞乱（MyTool 同款结论）。信息一行足够：尺寸、体积、传输延迟。 */
function handleFrame(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 24) return;
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1)) !== 'MC') return;
  const ts = Number(dv.getBigUint64(8));
  const w = dv.getUint32BE(16);
  const h = dv.getUint32BE(20);
  const lat = sincePc(ts);
  const el = document.createElement('div');
  el.className = 'ans';
  el.dataset.kind = 'ans';
  el.innerHTML = `<div class="tag"><span>截图</span><span>${w}×${h}</span>` +
    `<span>${(buf.byteLength / 1024).toFixed(0)}KB</span>` +
    `<span>${lat === null ? '校准中' : `送达 ${fmtMs(lat)}`}</span></div>`;
  prepend(el);
}

/* ---- ⑦ 远程控制 ----
 * 三条纪律，都是这个面板的全部难点：
 *  1. **颜色只由 st 决定**。`ack` 只代表命令已入队，点下去不等于生效——所以按下
 *     后是 --warn 描边的「待确认」，1.5s 内 st 里出现目标值才算生效，否则标未确认。
 *     转录失败（Windows 网页通道需要真实点击、原生产物缺失）就表现为一直接不到 st。
 *  2. caps.control 为假整块不渲染；逐项授权关掉的控件从布局里摘掉，不是置灰。
 *  3. 提问和历史复用既有渲染：回答走 `a` 流（同一个 request id、同一套 hero/feed
 *     焦点规则），历史点某条交给 hero。不新增第三种呈现路径。 */
const ctlBox = document.getElementById('ctl');
const ctlBody = document.getElementById('ctlBody');
const ctlToggle = document.getElementById('ctlToggle');
const ctlNote = document.getElementById('ctlNote');
const chipCap = document.getElementById('chipCap');
const chipCont = document.getElementById('chipCont');
const chipStyle = document.getElementById('chipStyle');
const chipSession = document.getElementById('chipSession');
const ROWS = {
  capture: document.getElementById('rowCapture'),
  continuous: document.getElementById('rowContinuous'),
  richness: document.getElementById('rowRichness'),
  expertise: document.getElementById('rowExpertise'),
  history: document.getElementById('rowHistory'),
};
const PAIRS = {
  capture: [document.getElementById('capOn'), document.getElementById('capOff')],
  continuous: [document.getElementById('contOn'), document.getElementById('contOff')],
};
const SEGS = {
  richness: [...document.querySelectorAll('#rowRichness .seg button')],
  expertise: [...document.querySelectorAll('#rowExpertise .seg button')],
};
const askRow = document.getElementById('askRow');
const askInput = document.getElementById('askInput');
const histBox = document.getElementById('hist');
const histList = document.getElementById('histList');
const histCount = document.getElementById('histCount');
/** 与桌面 answerStyle.labels 同词，避免同一档位在两端叫两个名字 */
const STEP_LABEL = {
  concise: '精简', standard: '标准', detailed: '详尽',
  casual: '口语', professional: '职场', technical: '技术',
};
const REFUSAL = {
  control_disabled: '电脑已关闭远程控制',
  item_disabled: '电脑未授权这一项',
  unknown_op: '该操作不支持',
  bad_arg: '参数无效',
  rate_limited: '操作太快，请稍候',
  not_wired: '电脑端未启用',
};

let caps = null;
let st = null;
/** op -> { id, arg, el, timer }：只有这四个 op 有 st 可等 */
const pending = new Map();
let noteTimer = null;
let histTimer = null;
let cmdSeq = 0;

function ctlGranted(op) {
  return !!(caps && caps.control && caps.controlItems && caps.controlItems[op] !== false);
}

function ctlState(op) {
  if (!st) return undefined;
  if (op === 'capture') return st.capturing;
  if (op === 'continuous') return st.continuous;
  return st[op];
}

function ctlEl(op, arg) {
  if (PAIRS[op]) return arg ? PAIRS[op][0] : PAIRS[op][1];
  return (SEGS[op] || []).find((b) => b.dataset.v === arg) || null;
}

function dropPending(op) {
  const p = pending.get(op);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(op);
}

function dropAllPending() {
  for (const op of [...pending.keys()]) dropPending(op);
  paintCtl();
}

function note(text) {
  if (noteTimer !== null) { clearTimeout(noteTimer); noteTimer = null; }
  ctlNote.hidden = !text;
  if (!text) return;
  ctlNote.textContent = text;
  noteTimer = setTimeout(() => { ctlNote.hidden = true; noteTimer = null; }, 3000);
}

function sendCmd(op, arg) {
  if (!ctlGranted(op) || !sock || sock.readyState !== WebSocket.OPEN) return;
  const id = `p${++cmdSeq}`;
  sock.send(JSON.stringify({ type: 'cmd', id, op, ...(arg === undefined ? {} : { arg }) }));
  if (!PAIRS[op] && !SEGS[op]) return;   // ask / history：没有 st 可等，不进待确认态
  dropPending(op);
  pending.set(op, { id, arg, el: ctlEl(op, arg), timer: setTimeout(() => unconfirm(op), 1500) });
  paintCtl();
}

/** st 在 1.5s 内没等到目标值：如实标出来，并把手势还给用户 */
function unconfirm(op) {
  const p = pending.get(op);
  if (!p) return;
  pending.delete(op);
  const el = p.el;
  if (!el) return;
  paintCtl();   // 先重绘（它会重写 className），再补这一笔未确认
  el.classList.add('unconf');
  setTimeout(() => el.classList.remove('unconf'), 1400);
}

/** 目标值出现在 st 里才算生效（R9：确认只发生在手机上） */
function settlePending() {
  for (const [op, p] of [...pending]) {
    if (ctlState(op) === p.arg) dropPending(op);
  }
}

function paintCtl() {
  const open = !!(caps && caps.control);
  ctlBox.hidden = !open;
  if (!open) return;
  for (const op of Object.keys(ROWS)) ROWS[op].hidden = !ctlGranted(op);
  askRow.hidden = !ctlGranted('ask');
  // 断线之后上一次的状态不可信：chip 回落到无状态文案，而不是留着红色骗人
  if (!st) { resetCtl(); return; }

  chipCap.textContent = st.capturing ? '● 转录' : '○ 转录';
  chipCap.className = 'chip' + (st.capturing ? ' live' : '');
  chipCont.textContent = st.continuous ? '⚡ 连续' : '连续 关';
  chipCont.className = 'chip' + (st.continuous ? ' on' : '');
  chipStyle.textContent = `${STEP_LABEL[st.richness] || st.richness} · ${STEP_LABEL[st.expertise] || st.expertise}`;
  chipSession.hidden = !st.session;
  if (st.session) chipSession.textContent = `${st.session.name} · ${st.session.answers} 答`;

  for (const op of Object.keys(PAIRS)) {
    const on = !!ctlState(op);
    // 颜色只表示「正在跑」：转录红 = .btn-live，连续绿 = .btn-on。关掉时那一项
    // 只是当前状态，用中性描边标出来——绿色的「关」按钮是骗人的。
    const runCls = op === 'capture' ? ' live' : ' on';
    PAIRS[op].forEach((b, i) => {
      const cur = (i === 0) === on;
      b.className = 'tg' + (cur ? (on ? runCls : ' cur') : '') + pendCls(op, b);
    });
  }
  for (const op of Object.keys(SEGS)) {
    SEGS[op].forEach((b) => {
      b.className = b.dataset.v === st[op] ? 'on' + pendCls(op, b) : pendCls(op, b);
    });
  }
}

/** 没有 st（尚未连上/刚断开）时的中性外观：谁都没在跑，什么都别亮 */
function resetCtl() {
  chipCap.textContent = '转录';
  chipCap.className = 'chip';
  chipCont.textContent = '连续';
  chipCont.className = 'chip';
  chipStyle.textContent = '—';
  chipSession.hidden = true;
  for (const op of Object.keys(PAIRS)) PAIRS[op].forEach((b) => { b.className = 'tg'; });
  for (const op of Object.keys(SEGS)) SEGS[op].forEach((b) => { b.className = ''; });
}

function pendCls(op, el) {
  const p = pending.get(op);
  return p && p.el === el ? ' pend' : '';
}

function renderHist(msg) {
  clearTimeout(histTimer);
  histCount.textContent = msg.truncated
    ? `显示 ${msg.items.length} / 共 ${msg.total} 条（已裁剪）`
    : `本次会话 ${msg.total} 条`;
  histList.textContent = '';
  for (const it of msg.items) {
    const el = document.createElement('div');
    el.className = 'hitem';
    el.innerHTML = `<div class="q">${escapeHtml(it.label || '（无标题）')}</div>` +
      `<div class="a${it.error ? ' err' : ''}">${escapeHtml(it.error || it.text || '（空）')}</div>`;
    el.addEventListener('click', () => showHistoryItem(it));
    histList.appendChild(el);
  }
  histBox.hidden = false;
}

/** 点某条历史 = 把它当成一次已完成的回答交给 hero，不另开一条渲染路径 */
function showHistoryItem(it) {
  const a = newAnswer(it.id, it.kind === 'x' ? 'x' : 'a');
  a.text = it.text || '';
  a.question = it.label || '';
  if (it.error) { a.state = 'error'; a.error = it.error; } else a.state = 'done';
  renderHero(a);
  if (a.question) { heroQ.hidden = false; heroQ.textContent = `Q：${a.question.slice(0, 300)}`; }
  // 历史条目没有时间戳（桌面 StoredTurn 也没有），所以这里只报出处
  heroMeta.textContent = it.qaRef ? `历史回答 · 资料：${it.qaRef}` : '历史回答';
}

function controlReply(msg) {
  if (!msg.id) return;
  for (const [op, p] of [...pending]) {
    if (p.id !== msg.id) continue;
    pending.delete(op);
    clearTimeout(p.timer);
    paintCtl();
  }
  note(REFUSAL[msg.reason] || `电脑拒绝：${msg.reason}`);
}

ctlToggle.addEventListener('click', () => {
  ctlBody.hidden = !ctlBody.hidden;
  ctlToggle.textContent = ctlBody.hidden ? '控制 ▾' : '控制 ▴';
});
for (const op of Object.keys(PAIRS)) {
  PAIRS[op].forEach((b, i) => b.addEventListener('click', () => sendCmd(op, i === 0)));
}
for (const op of Object.keys(SEGS)) {
  SEGS[op].forEach((b) => b.addEventListener('click', () => sendCmd(op, b.dataset.v)));
}
document.getElementById('histBtn').addEventListener('click', openHist);
document.getElementById('histReload').addEventListener('click', openHist);
/** 点名的快照走可靠通道，但还是给个下文：没有 hx 到达就明说，而不是挂着「载入中」 */
function openHist() {
  histBox.hidden = false;
  histList.textContent = '';
  histCount.textContent = '载入中…';
  sendCmd('history');
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    if (histCount.textContent === '载入中…') histCount.textContent = '电脑未响应，点「重新载入」';
  }, 2500);
}
function sendAsk() {
  const text = askInput.value.trim();
  if (!text) return;
  sendCmd('ask', text.slice(0, 500));
  askInput.value = '';
  askInput.blur();
}
document.getElementById('askSend').addEventListener('click', sendAsk);
askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAsk(); });

/* ---- 消息分发 ---- */
let analysisEnabled = true;
function handle(msg) {
  switch (msg.type) {
    case 'pong': handlePong(msg); break;
    case 'hello_ok':
      analysisEnabled = msg.caps ? msg.caps.transcript !== false : true;
      caps = msg.caps || null;
      dropAllPending();
      paintCtl();
      break;
    // ⑦ 远程控制：st 是唯一的真相来源，hx 是手机点名的快照
    case 'st': st = msg; settlePending(); paintCtl(); break;
    case 'hx': renderHist(msg); break;
    case 'ack': break;   // 只代表已入队，生效看 st
    case 'error': controlReply(msg); break;
    case 'asr':
      asrChip.textContent = `转写 ${msg.state === 'listening' ? '监听中'
        : msg.state === 'transcribing' ? '识别中' : msg.state === 'speech' ? '说话中'
        : msg.state === 'ready' ? '就绪' : msg.state === 'stopped' ? '已停止' : msg.state}`;
      asrChip.className = 'chip ' + (String(msg.state).startsWith('error') ? 'bad' : '');
      if (msg.state === 'stopped') removeLive();
      break;
    case 'partial': showPartial(msg); break;
    case 'line': addLine(msg); break;

    // 面试答案
    case 'a':
      if (msg.phase === 'qa') { const a = touch(msg.id, 'a'); a.qa = msg.answer; renderHero(a); }
      else if (msg.phase === 'web') {
        const a = touch(msg.id, 'a');
        a.origin = 'model+web';
        if (msg.sources && msg.sources.length) {
          a.text += `\n\n参考：${msg.sources.map((s) => `[${s.title || s.url}](${s.url})`).join(' · ')}`;
          renderHero(a);
        }
      } else if (msg.phase === 'delta') appendDelta(msg.id, 'a', msg.text);
      // '' = keep whatever the qa/web events already established for this answer
      else if (msg.phase === 'done') finish(msg.id, 'a', msg.text, '', msg.ms);
      else if (msg.phase === 'error') { const a = touch(msg.id, 'a'); a.state = 'error'; a.error = msg.message; renderHero(a); }
      break;

    // 做题答案
    case 'x':
      if (msg.phase === 'stage') setStage(msg.id, 'x', msg.stage);
      else if (msg.phase === 'question') { const a = touch(msg.id, 'x'); a.question = msg.text; heroQ.hidden = false; heroQ.textContent = `Q：${msg.text.slice(0, 300)}`; }
      else if (msg.phase === 'bank') {
        const a = touch(msg.id, 'x');
        a.origin = 'bank';
        a.text = (msg.letter ? `${msg.letter}　` : '') + msg.answer;
        renderHero(a);
        if (a.question) { heroQ.hidden = false; heroQ.textContent = `Q：${a.question.slice(0, 300)}`; }
      } else if (msg.phase === 'note') { const a = touch(msg.id, 'x'); a.text += (a.text ? '\n\n' : '') + msg.text; renderHero(a); }
      else if (msg.phase === 'delta') appendDelta(msg.id, 'x', msg.text);
      else if (msg.phase === 'done') {
        const a = touch(msg.id, 'x');
        if (a.origin !== 'bank') a.origin = msg.origin;
        finish(msg.id, 'x', msg.text, a.origin, msg.ms);
        if (a.question) { heroQ.hidden = false; heroQ.textContent = `Q：${a.question.slice(0, 300)}`; }
      } else if (msg.phase === 'error') { const a = touch(msg.id, 'x'); a.state = 'error'; a.error = msg.message; renderHero(a); }
      break;

    default: break;   // 未知类型忽略，便于协议演进
  }
}

/* ---- 连接 / 配对 ---- */
const pairBox = document.getElementById('pair');
const pairCode = document.getElementById('pairCode');
const pairError = document.getElementById('pairError');
function showPairUI(text) {
  pairBox.hidden = false;
  pairError.hidden = !text;
  if (text) pairError.textContent = text;
  pairCode.value = '';
  pairCode.focus();
}
function submitCode() {
  const code = pairCode.value.trim();
  if (!/^\d{6}$/.test(code)) { pairError.textContent = '请输入 6 位数字配对码'; pairError.hidden = false; return; }
  if (!sock || sock.readyState !== WebSocket.OPEN) { pairError.textContent = '连接已断开，点「重新获取配对码」'; pairError.hidden = false; return; }
  sock.send(JSON.stringify({ type: 'pair_confirm', code }));
}
document.getElementById('pairSubmit').addEventListener('click', submitCode);
pairCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); });
document.getElementById('pairAgain').addEventListener('click', () => {
  if (sock && sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify({ type: 'pair_request', device: navigator.userAgent.includes('iPhone') || navigator.userAgent.includes('Android') ? '手机' : '浏览器' }));
    showPairUI('');
    setStatus('等待配对码', 'warn');
  }
});

let sock = null;
let gen = 0;
let pairMode = !getToken();
let reauth = false;

function control(msg) {
  switch (msg.type) {
    case 'hello_ok':
      pairMode = false;
      pairBox.hidden = true;
      setStatus('已连接', 'ok');
      handle(msg);
      break;
    case 'pair_request_ok': setStatus('等待配对码', 'warn'); showPairUI(''); break;
    case 'pair_ok':
      saveToken(msg.token);
      pairMode = false;
      pairBox.hidden = true;
      reauth = true;
      sock.close(1000);
      break;
    case 'pair_fail': setStatus('等待配对码', 'warn'); showPairUI('配对失败：配对码错误或已过期'); break;
    default: handle(msg);
  }
}

function connect() {
  gen += 1;
  const myGen = gen;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  sock = ws;
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    if (myGen !== gen) return;
    startPing(ws);
    if (pairMode) {
      ws.send(JSON.stringify({ type: 'pair_request', device: '手机' }));
      setStatus('等待配对码', 'warn');
      showPairUI('');
    } else {
      ws.send(JSON.stringify({ type: 'hello', token: getToken() }));
      setStatus('认证中', 'warn');
    }
  };
  ws.onclose = (ev) => {
    if (myGen !== gen) return;
    stopPing();
    sock = null;
    removeLive();
    // ⑦ 断开后桌面上什么都可能已经变了：状态清空，面板回到中性外观
    st = null;
    dropAllPending();
    if (ev.code === 4001) {
      clearToken();
      pairMode = true;
      setStatus('未连接，等待配对', 'bad');
      setTimeout(connect, 400);
    } else if (reauth) {
      reauth = false;
      setStatus('认证中', 'warn');
      connect();
    } else {
      // 把关闭码显示出来：排查断连时手机屏幕上这串数字就是最直接的证据
      setStatus(`已断开(${ev.code})，重连中`, 'bad');
      setTimeout(connect, 1500);
    }
  };
  ws.onmessage = (ev) => {
    if (myGen !== gen) return;
    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      control(msg);
    } else {
      handleFrame(ev.data);
    }
  };
}
connect();
