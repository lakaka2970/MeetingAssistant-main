import { useMemo, useState } from 'react';
import { codeFileExt } from '../../shared/codeFences';
import { tokenizeCode } from '../../shared/highlight';
import './codeblock.css';

/**
 * One fenced block from an exam answer, laid out like the DeepSeek web client's
 * code block: language tag top-left, actions top-right, no line numbers,
 * indentation untouched.
 *
 * Wide lines scroll sideways by default — the previous behaviour was a
 * word-break in the middle of an identifier. The 换行 toggle switches to soft
 * wrapping with a hanging indent, which is the option that has to win when the
 * window is 380px wide and the reader would rather see the whole line.
 */

const TOK_CLASS: Record<string, string> = {
  kw: 'tok-kw',
  str: 'tok-str',
  num: 'tok-num',
  cmt: 'tok-cmt',
  pre: 'tok-pre',
  plain: '',
};

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface CodeBlockLabels {
  wrap: string;
  copy: string;
  copied: string;
  download: string;
}

const ZH: CodeBlockLabels = { wrap: '换行', copy: '复制', copied: '已复制', download: '下载' };

export function CodeBlock({ lang, code, labels = ZH }: { lang?: string; code: string; labels?: CodeBlockLabels }) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const tokens = useMemo(() => tokenizeCode(code, lang), [code, lang]);

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={`code-block${wrap ? ' wrap' : ''}`} data-lang={lang ?? ''}>
      <div className="code-bar">
        <span className="code-lang">{lang || 'code'}</span>
        <button
          type="button"
          className="code-ctrl code-wrap"
          aria-pressed={wrap}
          onClick={() => setWrap((v) => !v)}
        >
          {labels.wrap}
        </button>
        <button type="button" className="code-ctrl code-copy" onClick={copy}>
          {copied ? labels.copied : labels.copy}
        </button>
        <button
          type="button"
          className="code-ctrl code-dl"
          onClick={() => downloadText(`answer.${codeFileExt(lang)}`, code)}
        >
          {labels.download}
        </button>
      </div>
      <pre className="code-pre">
        <code>
          {tokens.map((t, i) =>
            TOK_CLASS[t.kind] ? <span key={i} className={TOK_CLASS[t.kind]}>{t.text}</span> : <span key={i}>{t.text}</span>,
          )}
        </code>
      </pre>
    </div>
  );
}
