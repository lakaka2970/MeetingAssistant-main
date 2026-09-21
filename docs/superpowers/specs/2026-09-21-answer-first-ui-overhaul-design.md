# 答案优先主视图 + 设置中心统一 — 设计 spec（子项目②）

日期：2026-09-21 ｜ 状态：待评审 ｜ 前置：子项目①（设置 Tab 化 + 思考强度）已完成并验证（typecheck / 709 测试 / 三端构建全绿）

## 目标与决策记录

主窗口从「双栏工具」重排为「提词器」：答案是第一视觉焦点，转录降级为可展开的窄导轨。
同期统一五个 overlay 面板的外壳与入口，并收敛标题栏的 14 个控件。

已确认的用户决策：

| 决策点 | 结论 |
|---|---|
| 主视角 | 提词器（答案优先），非记录（转录优先） |
| 提词主视图构成 | 问题一行 + 答案主体 |
| 转录降级形态 | 左缘窄导轨，点击展开为覆盖层完整转录 |
| 设置界面 | 知识库、服务状态并入设置中心 Tab；帮助/诊断/向导保留弹层但统一外壳 |
| 按钮 | 标题栏分组：核心操作 + 紧凑图标开关 + 「…」溢出菜单 |

## ① 主视图重排：提词卡 + 转录导轨

### 布局

`.panes`（双栏 + 拖分 + answerOnly）整体替换为 `.prompt-shell`：

```
┌─────────┬──────────────────────────────┐
│ 导轨     │ 会话工具栏（压缩一行）          │
│ ▍最新…  │ 问题条（对方最新一句，1行截断）  │
│ ▪ …    │ ┌────────────────────────┐   │
│ ▪ …    │ │ 预制答案（大字主体）        │   │
│ ▍partial│ │ AI 流式补充 / 🧠思考 / 来源 │   │
│ (点击展开)│ └────────────────────────┘   │
│         │ 旧 turn 摘要列表（点击换入提词位）│
│         │ 输入行 + ⚡答 + 📷 （常驻底部）   │
└─────────┴──────────────────────────────┘
```

### 组件与文件

- 新增 `src/components/prompt/TranscriptRail.tsx`：每句 = 说话人色块 + 截断摘要；实时 partial 钉底部；点击 → 覆盖层渲染现有 `TranscriptPanel`（选句⚡答、翻译、气泡、清除全部原样保留，组件不改逻辑）。
- 新增 `src/components/prompt/PromptFocus.tsx`：由 `AnswerSession` 演进（保留其 props 语义：sessions/turns/KB 槽/visionReady/answersReady/回调们），内部改为提词卡结构；`AnswerSession.tsx` 删除或改名，`App.tsx` 引用点随之更新。
- 新增纯函数 `src/components/prompt/focusTurn.ts`：`(turns, pinnedId) => { focus: AnswerTurn | null, follow: boolean }` — 默认跟随最新 done/streaming turn；用户点旧 turn 后钉住；新 turn 开始流式时回到跟随。先写测试再实现（TDD）。
- `App.tsx`：删 `paneSplit` / `answerOnly` / `startDividerDrag` 及 `commitLayout({paneSplit})` 调用；`shared/protocol.ts` 的 `paneSplit` 字段与 clamp 助手保留在存档结构中不再读取（避免迁移代码），仅删 UI 侧用法。

### 信息层级规则

- 预制答案（`turn.qa`）用独立 `.prompt-answer` 字号（约为当前回答字号 ×1.25，具体值在 `styles.css` 按 fontScale 三档微调）；AI 流式文本次之；`reasoning`、web 来源、QA 引用出处一律折叠。
- 问题条显示 `turn.label`；continuous/segment 时即对方原句，点击展开全文。
- 空态、错误态、禁用态（answersReady=false 的解释文案）沿用现有 i18n 键，迁移到提词卡内相应位置。

## ② 设置中心合并

- `SettingsPanel` Tab 集合扩为 7：**模型 / 路由 / 语音 / 视觉与搜索 / 知识库 / 服务状态 / 通用**（`SettingsTab` 联合类型加 `'knowledge' | 'health'`）。
- `KnowledgePanel` 内容拆外壳后成 `settings/KnowledgeTab.tsx`；`ServiceHealthPanel` 成 `settings/HealthTab.tsx`。两者原有 props（sessionId、onOpenSettings、onOpenDiagnostics、onSettingsRefreshed）经 `useSettingsDraft`/容器透传。
- 入口改跳 Tab：状态栏健康 chips → `openPanel('settings','health')`；标题栏 📚 → `openPanel('settings','knowledge')`。`ServiceHealthPanel` 里的「打开设置/诊断」按钮改为切 Tab / 开诊断弹层。
- 新增 `src/components/OverlayShell.tsx`：标题 + ✕ + 滚动体；设置中心、帮助、诊断、知识库不再有各自的 overlay 骨架（后两者保留内容组件）。
- `App.tsx` 的 `showSettings/showHealth/showDiagnostics/showHelp/showKnowledge` 五个布尔合并为 `openPanel: null | { view: 'settings'; tab: SettingsTab } | { view: 'help' } | { view: 'diagnostics' }` 形态的单一状态，天然互斥（重跑向导本就直调 `window.mc.rerunOnboarding()`，不占视图）；`window.__mcOpenSettings/__mcOpenHelp/__mcOpenKnowledge` 三个钩子重映射。
- 诊断、帮助、重跑向导不做 Tab 合并（浏览型内容），入口收进「通用」Tab 与标题栏溢出菜单。

## ③ 标题栏按钮优化

新增 `src/components/TitleBar.tsx`（从 `App.tsx` 抽出），分组：

1. **核心（左）**：品牌名 ｜ ⬤ 开始/停止采集（主按钮，样式不变）｜ 单屏/双屏段控件（含在线手机计数）。
2. **高频图标开关（右组 A，24px 方形，激活=`btn-on` 描边）**：⚡持续答题、👁视觉答题/纯文本、中⇄EN 回答语言、🎙麦克风、🕶隐身。tooltip 沿用现有 `t.titlebar.*` 键。
3. **工具图标（右组 B）**：📚（跳设置中心知识库 Tab）、⚙、`…`。
4. **「…」溢出菜单**：HUD 开关、做题模式窗口、诊断信息、帮助、重跑向导。纯 React state + 绝对定位弹层，点击外部关闭；不引第三方菜单库。
5. **窗口控件**：— 、✕ 原位保留。
6. 麦克风设备两个下拉仅在对应采集激活时内联显示（现状逻辑不变）。

视觉基线：图标按钮统一 `.btn-icon`；所有文字型开关按钮（开始/停止、单双屏除外）不再占用横向空间。

## 实施顺序

按风险从小到大，每步 `npm run verify`（typecheck + vitest + build）全绿后再进入下一步：

1. **③ 标题栏**（独立组件抽取 + CSS，回归面最小）
2. **② 设置中心**（合并面板 + OverlayShell + openPanel 状态；UI 状态收敛）
3. **① 主视图**（最大改动：focusTurn 纯函数 TDD → PromptFocus → TranscriptRail → 删双栏）

每步完成后给出人工验收清单（本环境无法驱动 Electron 窗口，不声称已实机验证）。

## 错误处理与兼容

- 提词卡对 `turns` 为空、全部 error、仅 translate/vision turn 三种情况都有兜底显示（沿用现有空态文案）。
- 旧 `settings.json` 的 `ui.paneSplit` 字段保留不动（不读即兼容），不做迁移代码。
- companion（手机窗）、exam、setup 独立窗口不在本子项目范围。

## 测试

- 新增 `test/focusTurn.spec.ts`（先 RED 后实现）：跟随最新 / 钉住旧 turn / 新流式到达时解除钉住 / 空列表。
- `openPanel` 联合状态为纯 UI state，以现有 typecheck + 手工清单覆盖。
- 回归：`npm run verify` 全绿；i18n zh/en 键完整性由 `Dict = typeof zh` 的 typecheck 保证。

## 明确不做（YAGNI）

- 不加全屏「提词模式」第二布局；不做主题重绘（视觉质感是候选子项目④）；不动处理流程延迟（子项目③）；不引组件库。
