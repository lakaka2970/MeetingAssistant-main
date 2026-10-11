/*
 * 极简 markdown 渲染器（从 MyTool 的 markdown.js 移植）。
 *
 * 安全模型：**先整体转义，再识别 markdown 语法**。
 * 因为转义在所有语法处理之前完成，模型输出里的任何 HTML 标签都只会
 * 作为普通文字显示——从根上不存在可注入的路径。这不是「渲染完再消毒」，
 * 而是没有可注入的东西。本机的回答内容经局域网进手机浏览器，这条不能省。
 * 代码块路径同样建立在这条前提上：codeBlockHtml 拿到的是**整体转义之后**
 * 的行（见 renderMarkdown 里 escapeHtml(text).split('\n')），拼进块内不会产生
 * 可注入标签；语言标签与扩展名也各自过 escapeHtml。改动时勿先把转义下移。
 *
 * 覆盖：标题、粗体、斜体、行内代码、围栏代码块、有序/无序列表、
 *       引用、链接、分隔线、段落。
 * 数学公式交给 KaTeX 的 auto-render，它在文本节点上工作且默认跳过
 * code/pre，因此与本渲染器互不干扰。
 */
'use strict';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/* 行内代码的占位符定界符：私用区字符 U+E000，正文里不会出现。写成转义形式
   保持纯 ASCII，免得控制字符让 git 把文件判成二进制。 */
const CODE_MARK = '\uE000';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** 仅允许 http/https 链接；其余（javascript:、data：等）降级为纯文本。 */
function safeHref(url) {
  const trimmed = String(url).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** 行内元素。入参必须是**已转义**的文本。 */
function renderInline(escaped) {
  // 行内代码必须「先抽出、后还原」：若先把 `...` 变成 <code>，后续粗体/斜体
  // 规则会伸进已生成的标签里改写内容（`a**b**` 会产出错配嵌套）。
  const codes = [];
  const masked = escaped.replace(/`([^`]+)`/g, (whole, body) => {
    codes.push(body);
    return CODE_MARK + (codes.length - 1) + CODE_MARK;
  });
  const rendered = masked
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
      const href = safeHref(url.replace(/&amp;/g, '&'));
      return href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : whole;
    });
  const restore = new RegExp(CODE_MARK + '(\\d+)' + CODE_MARK, 'g');
  return rendered.replace(restore, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/* 围栏规则与桌面 shared/codeFences.ts 一致：行首至多 3 个空格、``` 或 ~~~ 三枚
   以上、可选语言名；闭栏必须同种字符、不短于开栏、且不带语言尾巴。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]*)[ \t]*$/;

const CODE_EXT = { cpp: 'cpp', c: 'c', java: 'java', python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', go: 'go', rust: 'rs' };

/** 语言标签 + 三个按钮；按钮不带 data 内容，代码文本从 <code> 里读，省一份转义 */
function codeBlockHtml(lang, bodyLines) {
  const code = trimBlankEdges(bodyLines);
  const ext = CODE_EXT[(lang || '').toLowerCase()] || 'txt';
  return (
    `<div class="code-block" data-lang="${escapeHtml(lang || '')}" data-ext="${ext}">` +
    '<div class="code-bar">' +
    `<span class="code-lang">${escapeHtml(lang || 'code')}</span>` +
    '<button type="button" class="code-ctrl code-wrap" aria-pressed="false">换行</button>' +
    '<button type="button" class="code-ctrl code-copy">复制</button>' +
    '<button type="button" class="code-ctrl code-dl">下载</button>' +
    '</div>' +
    `<pre class="code-pre"><code>${code.split('\n').map((l) => `<span class="code-line">${l}</span>`).join('')}</code></pre></div>`
  );
}

function trimBlankEdges(lines) {
  let from = 0;
  let to = lines.length;
  while (from < to && !lines[from].trim()) from++;
  while (to > from && !lines[to - 1].trim()) to--;
  return lines.slice(from, to).join('\n');
}

function renderMarkdown(source) {
  if (source === null || source === undefined) return '';
  const text = String(source).replace(/\r\n?/g, '\n');

  // 第一步：整体转义。此后所有处理都在「不会产生标签的文本」上进行。
  const lines = escapeHtml(text).split('\n');
  const out = [];
  let listType = null;
  let inCode = false;
  let codeBuffer = [];
  let codeMarker = '';
  let codeLang = '';

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  const openList = (type) => {
    if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type; }
  };

  for (const line of lines) {
    if (inCode) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === codeMarker[0] && close[1].length >= codeMarker.length && close[2] === '') {
        out.push(codeBlockHtml(codeLang, codeBuffer));
        codeBuffer = [];
        inCode = false;
      } else {
        codeBuffer.push(line);
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      closeList();
      inCode = true;
      codeMarker = open[1];
      codeLang = open[2] ? open[2].toLowerCase() : '';
      codeBuffer = [];
      continue;
    }

    if (!line.trim()) { closeList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      closeList();
      out.push('<hr>');
      continue;
    }
    const quote = line.match(/^&gt;\s?(.*)$/);   // '>' 已被转义成 &gt;
    if (quote) {
      closeList();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) { openList('ul'); out.push(`<li>${renderInline(bullet[1])}</li>`); continue; }
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) { openList('ol'); out.push(`<li>${renderInline(numbered[1])}</li>`); continue; }

    closeList();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  if (inCode) out.push(codeBlockHtml(codeLang, codeBuffer));   // 未闭合的围栏一直吃到输入结尾
  closeList();
  return out.join('\n');
}

if (typeof window !== 'undefined') window.renderMarkdown = renderMarkdown;
