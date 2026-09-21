# 处理流程延迟优化（方案 B：窗口内并行 + 投机预取）— 设计 spec（子项目③）

日期：2026-09-21 ｜ 状态：待评审 ｜ 前置：子项目①②已完成并验证（typecheck / 717 测试 / 三端构建全绿）

## 目标与决策记录

压缩持续模式「对方说完 → 首个可见字符」的端到端延迟。现状串行链条：

```
VAD收尾+ASR推理 → [定死1100ms防抖] → [gate模型调用 ≤1200ms] → [await rag.retrieve]
→ [await webSearch（无命中时）] → LLM 首 token
```

其中防抖与门控完全串行、partial 流被丢弃、webSearch 阻塞首 token。目标链条：

```
VAD收尾+ASR推理 → [1100ms防抖窗口：门控判定 + 投机预检索 已并行完成] → LLM 首 token
                     （webSearch 若需要：并行，主回答结束后追加「联网补充」段）
```

已确认的用户决策：

| 决策点 | 结论 |
|---|---|
| 优化主轴 | 持续模式自动应答（链路最长、固定等待都在此处） |
| 防抖窗口 | 语义不动（1100ms 保留，等补句），窗口内做并行化与预取 |
| webSearch | 先答后补：不阻塞主回答，结果回来后模型生成补充段（3a） |
| 架构 | 方案 B：保留渲染进程状态所有权，不做主进程下沉（方案 A 被否） |

非目标：不改 1100ms / `GATE_TIMEOUT_MS=1200` 的取值；不动 ASR/VAD 与 speaker 过滤；不改预制答案（qa 直达）路径——它本就免网络。

## ① 门控并行化（渲染进程）

重写 `src/App.tsx` 的 continuous 效应（现 470–511 行）。segment 到达立即本地跑 `heuristic(lastSeg.text)`（`shared/questionGate.ts` 纯函数，两端同码，零 IPC）：

- **skip**（寒暄/碎片/“发我链接”类指令）→ 不起任何东西。现有 `isLikelyQuestion` 前置过滤被 `heuristic` 吸收（判定更全，含显式 answer 支与 action-request 支）。
- **answer**（问号结尾 / 明确「介绍一下、解释、写代码」）→ 只起 1100ms 防抖；到点直接 `askLlm('continuous')`，**不再发 `mc.gate`**（已知要答，模型往返纯属浪费）。
- **ambiguous** → 防抖与 `mc.gate` 同时发起。到点 gate 已回 → 按 verdict；未回 → 等它回再决定（最坏 `max(1100, gate)` ≈1200ms，对比现状最坏 2300ms）。gate 调用失败照旧回退为回答。

保持不变的语义：speaker==='me' 忽略、`answeredRef` 按 segment id 去重、补句产生新 segment 时重新走整套流程（旧计时器被 effect cleanup 取消）。`recent` 上下文仍取最近 6 条。

## ② 投机预检索（partial 提前查库）

ASR 说话过程中持续推 `partial` 事件（`electron/main.ts:255 publishAsr`），现状只给 UI 显示。新增：

1. **触发**：渲染进程在 `handleAsrEvent` 的 partial 分支（仅 continuous 开启且 `ev.speaker==='them'` 时）经新增 fire-and-forget IPC `llm:speculate` 把 partial 文本 + 当前 sessionId 报给主进程——只有渲染进程知道持续模式是否开着，主进程不知道，故必须由此侧发起（修订：原「不新增 IPC」不成立）。主进程用 ~300ms 微防抖调度 `rag.retrieve(partialText, sessionId)`，且仅当 `embedder.state==='ready'`——投机路径不拉起 worker、不触发下载（守住 `retrieve` 既有契约）。
2. **缓存**：新增 `electron/rag/speculative.ts`，纯结构 `SpeculativeCache`：`Map<text, {result, at}>`，TTL 15s，容量 8（写满逐出最旧）。TDD：命中 / 过期 / 逐出。
3. **复用**：`llmAsk` 路由在 `rag.retrieve(q, …)` 前先查缓存，**文本精确相等才复用**，否则实查。不做模糊前缀匹配——宁可漏优化，不给半句话的检索结果。
4. **开关与观测**：模块级常量 `SPECULATIVE_RETRIEVAL = true`（本步收益依赖「最终句恰等于某次 partial」的引擎行为，未经实测；命中率低时一行关掉，不影响其他三步）。每次命中/落空打 `[spec] hit/miss` 日志，供验收统计。

## ③ webSearch 先答后补（3a：模型生成补充段）

`electron/main.ts` llmAsk 路由（现 2190 行附近）中，「RAG 无命中且开了 webSearch」的分支不再 `await`：

1. webSearch 以未等待的 Promise 发起；主回答立即用现有上下文（可能含 ragContext/factsHint，此分支下通常为空）开流。
2. webSearch 回来后：
   - 发既有 `kind:'web'`（sources）事件；
   - **排队等主流式 `done`**（补充绝不与主回答交错），然后起第二次**非流式**小调用 `chatOnce`（maxTokens 400）：prompt = 原问题 + 刚生成的主回答全文 + `formatWebLines(hits)`，指令「基于搜索结果补充上面回答遗漏的关键点，不复述已有内容，无可补充时输出哨兵」（新增纯函数 `shared/webSupplement.ts` 的 `supplementMessages()`，TDD）。
   - 该流的输出**一次性整块**经**新事件 `kind:'web-sup'`** 发出（非逐字流式——正因如此，模型回答「无补充」哨兵 `NO_SUPPLEMENT` 才能在发出前被过滤、永不闪现）；无论追加/静默/失败/取消，最后都发 `kind:'web-done'` 收尾（渲染端清「检索中」提示）。
3. 渲染端：`AnswerTurn` 新增 `webSup?: string`、`webPending?: boolean`（主回答结束但补充未回时置位，UI 显示「联网检索中…」小字）。补充段渲染在「🌐 联网补充」标题下（`.turn-web-sup`，i18n 中英双份）。`web-sup` 增量到达时即使 turn.status 已 `done` 也直接拼接，不改回 streaming——主回答的 stop/copy 语义不被补充流搅乱。
4. 边界：主回答被取消或出错 → 丢弃 web 结果，不起补充流；补充流自身失败 → 静默（主回答已完整，来源链接仍显示）；翻译/视觉/做题模式不走此路径；free-ask 走同一路由，同样可补。

## ④ 端到端计时

- **渲染进程**：continuous 发起 turn 时记下关联 segment 的 `endTs`；该 requestId 首个 delta 到达时计算「语音结束→首字符」，与现有 ASR e2e 一起进 HUD（新增一行首字 p50/p95）。
- **主进程**：llmAsk 内计时 `retrieveMs`（已有 r.ms）、`webMs`（已有 w.ms）、`ttftMs`（chatStream 发起到首个 onDelta）。`done` 事件的 usage 旁新增可选 `timings: Record<string, number>`，console 一行汇总 + HUD 展示，验收时前后对比有数据。

## 接口与文件汇总

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | continuous 效应重写（①）；`webPending/webSup` 事件处理 + 首字计时（③④） |
| `electron/main.ts` | `llm:speculate` 投机接收端（②）；web 路由改先答后补 + 补充流（③）；分段计时（④） |
| `electron/rag/speculative.ts` | 新增 `SpeculativeCache` |
| `electron/preload.ts` | 新增 `mc.speculate()`（fire-and-forget） |
| `shared/webSupplement.ts` | 新增 `supplementMessages()` 纯函数 |
| `shared/protocol.ts` | `LlmEvent` 加 `web-pending` / `web-sup` / `web-done`；`done` 加 `timings?`；`StoredTurn` 加 `webSup?`；IPC 加 `llmSpeculate` |
| `src/components/prompt/PromptFocus.tsx` + `src/i18n.tsx` + `src/styles.css` | 联网补充段渲染与文案 |
| `test/speculative.spec.ts`、`test/webSupplement.spec.ts` | 新增（TDD 先行） |

## 测试与验收

- 单测：`SpeculativeCache`（命中/过期/逐出）、`supplementMessages`（消息结构）先 RED 后 GREEN；`heuristic` 三支沿用现有 `test/questionGate.spec.ts`；全量 717+ 测试与三端构建保持绿。
- 门控并行属渲染进程编排逻辑，不为其引入 React 测试框架，靠 ④ 的计时在实机验收：连续模式实测「语音结束→首字符」p50 前后对比（目标：固定段等待从最坏 ≈2.3s 降到 ≤1.1s + 检索毫秒级）。
- `[spec] hit/miss` 日志统计投机命中率，低则关正常量。

## 实施顺序（每步独立验证、独立回退）

① 门控并行 → ④ 计时（先有尺子）→ ② 投机预检索 → ③ web 先答后补（接口最大，最后做）。

## 错误处理汇总

- 投机检索异常 → 捕获并忽略，llmAsk 走实查；
- webSearch 失败/无结果 → 行为与现状一致（无 web 事件、无补充段）；
- 补充流失败 → 静默；
- gate IPC 失败 → 回退为回答（现状保持）。
