# 做题模式 · 算法题提示词契约、复核订正与代码块显示

日期：2026-10-11 · 分支：`feat/linux-support` · 状态：待实现

## 1. 背景

做题模式（内部代号 `exam`，管线 `screen → bank → answer`）在双屏场景下以手机为显示面
（`companion.enabled` 时电脑不弹窗，`shared/shotWeb.ts:42-46`）。做算法/编程题时暴露出三处结构性缺陷，
均已核对到具体代码：

1. **算法题没有输出契约。** `CODE_STYLE_RULES`（`electron/llm/examPrompts.ts:84-93`）只管"写得像人"，
   从未要求模型使用围栏代码块，也没有要求保持题目给定的函数签名。
2. **代码显示是坏的。** 桌面做题窗口的 `shared/markdownLite.ts:8-11` 明确不支持块级结构，模型给的
   ` ``` ` 会连围栏一起当纯文本显示，且 `.exam-a`（`src/exam/exam.css:158-166`）用 15px 比例字体，
   缩进与对齐直接塌掉。手机端 `markdown.js` 能出 `<pre><code>`，但 CSS 是
   `#heroBody pre{overflow:hidden}` + `#heroBody pre code{white-space:pre-wrap;overflow-wrap:anywhere;
   padding-left:1.1em;text-indent:-1.1em}`（`resources/companion/index.html:55-57`）：长行在 identifier
   中间被硬折断，首行有缩进时整块错位。全项目没有任何一处 `overflow-x`。
3. **没有作答后校验。** 现有的"防错答"全部发生在**查找阶段**（`decideBankAnswer`、`reanchorAnswer`、
   `mergeDuplicateEntries`、`AMBIGUOUS` 标记），答案一旦由模型生成，唯一的纠错手段是人工重问
   （`src/exam/ExamApp.tsx:361-376` + `examPrompts.ts:181-183` 的 `priorAnswer`）。

顺带记录两个会被本次改动一并消掉的既有 bug：

- 同一行内成对出现的 `$`（Shell 的 `echo $((a+b))`、jQuery）会被 `shared/mathSplit.ts:23` 的
  `MATH_RE` 行内分支当公式抓走。代码切段后不再进入 `splitMath`。
- `resources/companion/index.html:89` 定义了 `.ans .more` 样式但没有任何代码使用它。

## 2. 目标 / 非目标

**目标**

- 算法题答案带明确格式契约（围栏 + 语言标签 + 保持题目签名），显示端按 DeepSeek 网页端的代码块形态排版。
- 代码块：等宽、保留缩进、**默认横向滚动**、带**自动换行开关**（换行时用悬挂缩进）、复制、下载。
- 模型自查后订正：首答秒级给完，后台跑一轮挑错，结果以独立"复核卡"追加在原答案下方，原答案保留可对比。
- 用户可在手机与桌面窗口主动触发"再检查一遍"，可带一句错因，支持多轮。
- 把做题模式的控制并入手机控制区（与现有六项同一套逐项授权机制）。

**非目标**

- 不做本地执行/编译校验（模型生成的代码来自屏幕截图，执行它是 prompt-injection 到 RCE 的直路；
  且评测环境不可知）。这条留作将来单独设计。
- 不动题库直答路径、不动 `LexicalIndex` 检索阈值、不动面试侧的 byte-stable prefix。
- 不改多显示器截屏（`screen.getPrimaryDisplay()` 写死在 `electron/main.ts:2566` 与
  `electron/companion/bridge.ts:486`）——本次双屏语义是手机，不是第二台显示器。
- 不新增「自动复核」功能开关：复核只在编码题跑，代价有界。（手机控制区的逐项授权是权限，不是功能开关。）

## 3. 架构

```
热键截屏 → 转录 → 题库 → 作答(流式) → done ──→ [自动] 复核(流式) → checkDone
                                    ↑            第 2 轮起带用户错因
                        「再检查一遍」按钮 ────────┘
                                    ↑
                     手机 examCheck / 桌面 mcExam.check()
```

### 新增单元

| 文件 | 职责 | 接口 |
|---|---|---|
| `shared/codeFences.ts` | 纯函数，把答案切成散文/代码段，不生成任何 HTML | `splitCodeFences(text): AnswerSeg[]`，`AnswerSeg = {kind:'prose';text} \| {kind:'code';lang?;body}` |
| `shared/highlight.ts` | 纯函数，代码 → token 序列；**每个 token 文本单独转义后再交渲染方** | `tokenize(code, lang): Token[]`，`Token = {type:'kw'\|'str'\|'num'\|'cmt'\|'pre'\|'plain';text}` |
| `shared/answerCheck.ts` | 纯函数，解析复核输出骨架 | `parseCheckOutput(raw): {verdict:'ok'\|'fix'\|'unknown';note:string;revision:string}` |
| `src/components/CodeBlock.tsx` | React 代码块：横向滚动 / 换行开关 / 复制 / 下载 / 着色 | `CodeBlock({lang, code})` |

四个新单元都是无 DOM 的纯逻辑，与 `markdownLite`/`mathSplit`/`bankStore` 同一家族风格。

### 改动单元

`electron/llm/examPrompts.ts`（契约 + 复核提示）、`electron/main.ts`（复核阶段 + `lastExam` 槽位 + 两个新
control op）、`shared/protocol.ts`（事件与 grant）、`electron/companion/control.ts`、
`electron/companion/bridge.ts`（`publishExam` 新 phase）、`electron/examPreload.ts`、
`src/exam/ExamApp.tsx`、`src/exam/exam.css`、`src/components/MathText.tsx`、
`resources/companion/{markdown.js,app.js,index.html}`、`src/components/settings/GeneralTab.tsx`、`src/i18n.tsx`。

## 4. 协议变更

### 4.1 `ExamEvent`（`shared/protocol.ts:977-995`）新增四个 kind

```ts
| { requestId: string; kind: 'check';      turn: number; verdict: 'ok' | 'fix' | 'unknown'; note: string; ms: number }
| { requestId: string; kind: 'checkDelta'; turn: number; text: string }
| { requestId: string; kind: 'checkDone';  turn: number; text: string }
| { requestId: string; kind: 'subMode';    subMode: ExamSubMode }
```

- `turn` 是复核轮次：自动那轮 = 1，用户按按钮 = 2、3……
- **`ExamOrigin` 不加新值**（`protocol.ts:949`）。首答的来源标签不能被复核污染——`app.js:265-267`
  已经写明"绝不降级一个已建立的来源标签"。复核卡自己带徽章。
- `subMode` 事件用于第 4.3 节的真值收敛。
- 手机端对应新增 `phase`：`'check' | 'checkDelta' | 'checkDone'`（`bridge.ts:330` `publishExam`），
  老版手机页收到未知 phase 走 `default: break`（`app.js:668`），不会崩。

### 4.2 `ExamAskPayload` 与 preload

`ExamAskPayload`（`protocol.ts:951`）不加字段。复核走新通道：
`electron/examPreload.ts` 加 `check(turnHint?: string)` → 新 `IPC.examCheck`，主进程从 `lastExam` 取上下文，
不需要重新截屏。

### 4.3 子模式真值收敛（做手机控制项前必须先解决）

现状：`ExamAskPayload.subMode` 由渲染进程带上来（`protocol.ts:953`），而 `settings.data.exam.subMode`
（`protocol.ts:435`）只是窗口"记住上次留在哪一档"（`protocol.ts:1533`）。手机改了 settings，
开着的桌面窗口仍会按自己本地的旧状态发问——真值分叉。

要求：

1. 窗口每次切换子模式就写 settings（实现时核实 `setSubMode` 当前是切换即写还是关窗才写，
   见 `main.ts:2345-2424` 一带的 handler），并广播 `{kind:'subMode'}`；
2. `runExamAsk` 以 `settings.data.exam.subMode` 为准，覆盖 `payload.subMode`；
3. 窗口收到 `subMode` 事件时同步自己的 picker。

### 4.4 手机控制区新增两项

`ControlOp`（`electron/companion/control.ts:17`）从六项变八项：

```ts
| 'examSubMode'   // 段选，arg ∈ ExamSubMode，需要在 st 里回显
| 'examCheck'     // 按钮，arg 为可选错因文字（≤ ASK_MAX_CHARS = 500，control.ts:33）
```

`examShot`（手机让电脑读屏）本次**不做**：手机已有"拍照发题"通路，且它不属于"做题模式的控制"。
`CompanionControlItems`（`shared/protocol.ts:205-218`）与
`COMPANION_CONTROL_GRANTS`（`:221-228`）同步加两个键，默认 `true`。

**加一项要动的全部位置**（漏一处就编译失败或测试红）：

1. `shared/protocol.ts` `CompanionControlItems` + `COMPANION_CONTROL_GRANTS`
2. `electron/settings.ts:887-894` —— `getPublic()` 里逐项手写的枚举；**TypeScript 会强制补齐**，
   老 `settings.json` 缺键时按 `!== false` 语义默认开启
3. `electron/companion/control.ts` `ControlOp` + `CONTROL_OPS` + `acceptCommand` 的参数校验
4. `electron/main.ts:2227-2273` `runControl` 路由
5. `electron/companion/protocol.ts` `StateMessage` 加 `examSubMode`（`examCheck` 无状态，不需要回显）
6. `resources/companion/index.html` 段选行 + 按钮行；`app.js` 的 `ROWS`/`SEGS`（`:375-389`）与
   `sendCmd`（`:453-460`）
7. `src/components/settings/GeneralTab.tsx:319-366` 两个复选框 + `src/i18n.tsx` 中英文案
   （`:687` 与 `:1472` 两套字典都要）
8. `test/companionControl.spec.ts:20` 的 `OPS` 列表

## 5. 提示词契约

### 5.1 编码题输出契约（追加进 `systemFor('technical')`）

```
算法题输出格式（必须遵守，屏幕那侧按它排版）：
- 代码一律放进带语言标签的围栏块，标签只用 cpp / java / python / javascript / typescript / go；
  没有围栏的代码会被排版引擎当普通散文处理；
- 一个功能只放一个块，不要"边讲边写"把同一段实现拆成几块；
- 保留题目给定的函数签名、类名、参数名与返回类型，要能直接粘进作答框运行；
- 块内不写行号，不用 `...` 省略已给定的模板代码；
- 块外只允许两行：开头一句思路，结尾一行复杂度（时间/空间）；
- 取模常量、大数组上限这类预处理写在函数外，与实现放进同一个块。
```

`CODE_STYLE_RULES` 现有七条一字不改，契约追加在其后；`open`/`aptitude`/`personality` 三档不变。

### 5.2 复核提示（新 `buildExamCheckMessages`）

```
你是挑错的，不是重做的。只判断下面这份现场手写答案能不能通过这道题。
第一行只写 VERDICT: OK 或 VERDICT: FIX
第二行（仅 FIX）：一句话错因，指名到具体一行或具体条件
第三段（仅 FIX）：以【修订】开头，按同样的写法要求给出改完的完整答案
判据按顺序：
① 是否真解了题意，含 n=0/n=1、空输入、下标越界、取模与溢出；
② 能否编译：函数签名、返回类型、括号分号、缩进、缺的头文件与 import；
③ 声称的时间/空间复杂度与实现是否一致；
④ 是否擅自改了题目给定的签名或参数名；
⑤ 是否引入题目环境里不可能有的第三方库。
没有问题就只输出 VERDICT: OK，不要复述答案、不要补充说明、
不要把能跑的代码改写成「更好的写法」。
```

最后一句是防回归的关键：复核最常见的失败模式是把正确的解改写成"更漂亮但错"的解。

user turn 依次拼：`【题目】`（截 `MAX_SCREEN_TEXT_CHARS`）、`【我的答案】`（截 6000）、
可选 `【用户指出的问题】`、可选 `【此前几轮复核的结论】`（多轮时带上，避免重复报同一个错）。
走 `chatStream`，`temperature: 0.2`，复用首答的 `LlmConfig`（做题路径本来就绕过 router，
`main.ts:2092-2098`）。

### 5.3 转录提示补强

`buildTranscribeMessages`（`examPrompts.ts:35-63`）现在只说"有输入框/代码框时把已填写内容也转出来"。
补一条：**代码框内容按原始缩进逐行转录，题目给定的函数签名与模板代码一行都不要省**。
读题阶段丢掉的缩进和签名，后面任何环节都补不回来。

## 6. 复核阶段

**触发条件**（全部满足才跑）：

- `subMode === 'technical'` 或 `classifyQuestion(question) === 'coding'`（复用
  `shared/textHeuristics.ts:54-64`，不新造分类器）；
- 答案不是题库直答（`main.ts:2076` 那个提前 `return` 的分支**绝不复核**——原题答案已经是确定的，
  再让模型挑错只会把确定性换成不确定性）；
- 首答文本非空。

**实现**：`runExamAsk` 发完 `done` 后调 `checkExamAnswer({requestId, question, subMode, answer, hint?, turn})`，
流 `check` / `checkDelta` / `checkDone`。新增主进程槽位
`lastExam: {requestId, question, subMode, answer, at} | undefined`（当前主进程**没有**这个状态，已 grep 确认），
`examCheck` op 与 `mcExam.check()` 都读它。耗时记进 `ms.check`。

**竞态**：`IPC.examCancel`（`main.ts:2193-2198`）现有的 `AbortController` 必须同时中止复核轮；
新 ask 一到 `lastExam.requestId` 就变，两个渲染面都要按 `requestId` 丢弃迟到的 `check*` 事件
（`touch(id)` 已是同一语义）。

**多轮**：手动按钮每按一次 `turn + 1`，新复核卡替换旧卡并显示轮次；`parseCheckOutput` 的 `note`
累积成 `【此前几轮复核的结论】` 回灌。

## 7. 代码显示层

### 7.1 `splitCodeFences`

- 开栏 `^\s{0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9+#._-]*)$`；闭栏须同种字符且不短于开栏长度。
- **未闭合就一路吃到文末**——流式输出与被截断的复核都不会漏出反引号。
- 围栏内容剥掉首尾空行（模型很爱在 ` ```cpp ` 后空一行）。
- 不生成 HTML；散文段原样交给现有管线。

### 7.2 `CodeBlock` 结构（对齐 DeepSeek 网页端）

```
<div class="code-block" data-lang="cpp">
  <div class="code-bar"><span class="code-lang">cpp</span>
    <button class="code-ctrl code-wrap" aria-pressed="false">换行</button>
    <button class="code-ctrl code-copy">复制</button>
    <button class="code-ctrl code-dl">下载</button></div>
  <pre class="code-pre"><code>…token spans…</code></pre></div>
```

- 默认 `white-space:pre; overflow-x:auto` → 长行横向滚动，不拆 identifier。
- 「换行」切到 `white-space:pre-wrap; overflow-wrap:break-word`（**不是 `anywhere`**，只在真放不下时断），
  且续行悬挂缩进对齐到首行内容起点。
- 字体令牌 `--mono`：`ui-monospace, Menlo, Consolas, "Cascadia Mono", "Noto Sans Mono CJK SC", monospace`
  ——带 CJK 等宽是因为中文注释现在会让对齐错位。
- `font-size:0.92em`、`line-height:1.6`、`tab-size:4`、块内大内边距、无重边框。
- 复制：`navigator.clipboard.writeText`，成功态 1.2s（沿用 `ExamApp.tsx:225-231` 的写法）。
- 下载：`Blob` + `URL.createObjectURL`，文件名扩展名由 `lang` 映射，映射不到退回 `code.txt`。零 IPC。
- 着色：`shared/highlight.ts` 自写分词器，覆盖 cpp/c/java/python/javascript/typescript/go 的关键字、
  字符串、数字、注释、预处理。未知 `lang` 只出字符串/数字/注释三类通用 token，不猜关键字。
  配色自己写约 20 行 token 色（`kw/str/num/cmt/pre`），**不引第三方 hljs 主题**——
  DeepSeek 的浅色配色在 `#161a22` / `#080808` 深色底上不可读。

### 7.3 桌面侧接线

`MathText.tsx` 组合顺序改为：`splitCodeFences` → 散文段走现有 `splitMath` + `markdownLite` + KaTeX，
代码段走 `CodeBlock`。没有围栏的存量答案输出**逐字节不变**。
`src/exam/exam.css` 新增 `.code-*` 规则；`.exam-a` 的 `white-space:pre-wrap` 保留给散文段
（`.exam-a` 已有 `user-select:text`，`:164`，代码可选中复制）。

### 7.4 手机侧接线

- `markdown.js`：围栏输出加 `data-lang`、语言标签与三个按钮；**先整体转义的安全模型一字不动**。
- `index.html`：`#heroBody pre{overflow:hidden}`（`:55`）→ `overflow-x:auto`；
  `:56-57` 那条 `pre code` 规则整条删掉（`text-indent:-1.1em` 正是首行缩进错位的来源）；
  新增 `.code-block.wrap pre{white-space:pre-wrap}`；`#heroBody{overflow-wrap:anywhere}`（`:47`）留给正文段落。
- 历史卡 `.ans .body{max-height:6.2rem;overflow:hidden}`（`:84-85`）保留折叠省地方，
  但含代码块时用已有而无人使用的 `.ans .more`（`:89`）显示「含代码，点按展开」。
- `app.js`：hero 与卡片的 click 折叠目前只放过 `A`（`:331`、`:335`）→ 同时放过 `.code-ctrl`，
  否则点「换行」会把整块答案折叠。按钮用**容器级事件委托**一个 listener 统管。
- 流式期间维持现状（`appendDelta` 只写 `textContent`，`:254-260` 刻意不重排版），`done` 才渲染
  markdown——代价是流式时反引号可见。

## 8. 错误处理与降级

| 情况 | 行为 |
|---|---|
| 复核无 Key / HTTP 错 / 首字超时 / 被取消 | 发 `check{verdict:'unknown', note:'复核未完成：<原因>'}`，卡片显示原因并保留重试按钮。**绝不静默**——静默会被读成"复核过、没问题" |
| 模型不守骨架（无 `VERDICT:` 行） | `unknown`，原文截断作为 note，不猜 verdict |
| 判 `FIX` 但 `【修订】` 后为空 | `unknown`，只留错因 |
| `lastExam` 为空（还没做过题）就按 `examCheck` | 主进程回 `note` 事件「先做一道题再复核」，不报错 |
| 手机 `examSubMode` 值不在四个枚举内 | `acceptCommand` 判 `{ok:false}`，与现有段选一致 |
| 老 `settings.json` 缺新 grant 键 | `settings.ts:887-894` 枚举默认 true |
| 老版手机页收到 `check*` phase | `default: break` 忽略 |
| `lang` 未知 / 映射不到扩展名 | 只出通用 token / 文件名退回 `code.txt` |
| 代码块内含 HTML 标签 | 分词器逐 token 转义后才包 span，`<script>` 只会变成可见文字 |

## 9. 测试与验收

**单元**

- `test/codeFences.spec.ts` — 多块 / 未闭合 / `~~~` / 代码体内含反引号与 `$` / 首尾空行剥离 /
  无围栏时输出与今天逐字节一致
- `test/highlight.spec.ts` — 六语言关键字、字符串内含引号、注释内含 `*`、CRLF、未知 lang；
  **断言喂 `<script>alert(1)</script>` 后输出里没有未转义标签**
- `test/answerCheck.spec.ts` — `OK` / `FIX` / 无骨架 / 修订为空 → verdict 映射
- `test/markdownLite.spec.ts` 一行不改仍要过（存量显示不变的回归护栏）
- `test/companionControl.spec.ts` — OPS 八项、`unknown_op` 仍拒、逐项关闭返回 `item_disabled`、
  `CMD_LIMIT = 5/s` 覆盖新 op
- `test/settings.spec.ts` — 老配置加载后新 grant 为 true；`examSubMode` 写入后 `getPublic` 回显
- `test/llm.spec.ts:266-420` 的 byte-stable prefix 契约不得被破坏

**真机验收**（companion 是局域网网页，可直接用 browser-use 打开 `http://<本机>:18765`）：
喂一条含 120 列 C++ 长行的做题答案，量三种状态的实际像素——默认横向滚动、切到换行后的悬挂缩进、
点「换行」按钮时 hero 不折叠。截图前确认窗口落在用户桌面上而不是被编辑器挡住。

**延迟**：沿用 `docs/dev/OPTIMIZATION_PLAN.zh-CN.md` §5 的本地 mock provider 自测法，加一条记录——
首答耗时不因复核轮回归，复核轮耗时单独记。

## 10. 落地切片

1. `shared/codeFences.ts` + `CodeBlock` + `MathText` 接线 + `exam.css`（纯显示，先让桌面侧能看到代码块）
2. 手机侧 `markdown.js` / `index.html` CSS / `app.js` 事件委托与折叠豁免
3. `shared/highlight.ts` 着色
4. `examPrompts.ts` 编码契约 + 转录补强
5. `shared/answerCheck.ts` + `buildExamCheckMessages` + `runExamAsk` 复核阶段 + `lastExam`
6. `protocol.ts` 四个新事件 + `bridge.ts` 新 phase + 两个渲染面的复核卡
7. 子模式真值收敛（4.3）
8. `examSubMode` / `examCheck` 两个 control op 全链路（含设置页与中英文案）
9. 真机验收 + 延迟记录 + 文档（`docs/user/QUICK_START.zh-CN.md` 双屏一节补复核与代码显示）

## 11. 已否决的方案

- **复核复用 re-ask 通道**（把复核伪装成一次带 `priorAnswer` 的重问）：改动最小，但修订版会**替换**原答案
  （`ExamApp` 只有一个 `answer` 状态），丢掉对比能力，且 origin 与耗时统计会和真实重问混在一起。
- **单次调用内自检**（答案末尾带 `【自查】` 段）：零额外延迟，但同一个模型在同一轮里很少能抓出自己的
  逻辑错，正是这套管线最怕的"自信地答错"。
- **用 highlight.js**：着色质量高、不用自己维护，但要往手机静态页里塞第三方代码、体积要实测、
  且它自己生成 HTML 需再审计转义行为。自写 ~120 行分词器与仓库现有"先转义再生成标记"的风格一致，
  且可单测。
- **本地执行代码做校验**：见 §2 非目标。
- **教 `markdownLite` 认围栏**：改动文件少一个，但交互按钮要从 HTML 字符串里长出来，
  行内 `` ` `` 正则会与围栏抢字符，测试更难写。
