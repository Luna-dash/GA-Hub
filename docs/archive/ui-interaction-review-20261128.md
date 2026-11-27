# GA-Hub 系统性 UI 交互 Review 与修复报告（2026-11-28）

> **审查基线**：`602fd7b`（`ui(quota): soften account quota progress bar tone and track styling`）  
> **最终交付 HEAD**：`2c4905b`（`main` 分支）  
> **审查范围**：`webui/src/` 全部前端交互面、组件原语、表单校验、浮层栈、导航守卫、键盘无障碍与 `dark-forest` 主题一致性  
> **提交规模**：32 个独立 UI 审查/修复提交 + 1 个外部协作者并行提交（`f76870e`），共 33 个提交；`git diff --shortstat 602fd7b..2c4905b` 计 **116 files changed, +9624 / -1790**

---

## 1. 审查总览与工作方法

### 1.1 工作方法与推进流程

本次系统性 UI 交互 Review 面向生产体验优化，按五个核心交互主题依次推进，每个主题严格执行四步闭环：

1. **需求差与真问题调查（Explorer）**：先盘点目标主题下的真实用户痛点、跨页面分歧与半成品交互，明确现有原语和缺失契约，避免「为了改而改」。
2. **统一方案与原子提交（Worker）**：在确定统一架构原语（如 `ga-actions.css` / `<Button>`、`overlayStack` + `useOverlayRegistration` + `useDirtyClose`、`extractErrorMessage` + `ToastHost` + `QueryLoadState`、`AntiModelSelector` + `.ga-input*` / `.ga-select*`、`navigationGuardStore` + `tabListA11y` + `useImeCompositionGuard`）后，按问题边界拆分为可独立 `git revert` 的提交直接落地。
3. **三方并行验证门禁（Reviewer + Adversarial Challenger + Forensic Auditor）**：每个主题完成后均由独立代码评审（逐项核对需求差与交互一致性）、对抗测试员（编写临时隔离 Vitest JSDOM 压力探针复现竞态/焦点/边界漏洞）与取证审计员（核对提交完整度、测试增删真实性与零作弊/零回归）联合把关；M1–M5 全部在首轮对抗中暴露出真实边界缺陷并经第二轮修复重验后通过。
4. **全量验证与文档归档**：在 `HEAD` (`2c4905b`) 上实跑 `tsc -b --noEmit`、`vitest`、`api:check`、`test_repo_hygiene.py`、全量 `pytest` 及 TypeScript AST `<button type=` 扫描，并输出本报告供次日人工视觉抽检与收尾决策。

### 1.2 五大 UI 交互主题总览

| 序号 | 主题名称 | 核心痛点摘要 | 统一方案 / 关键原语 | 独立提交数 | 门禁结果 |
|---|---|---|---|---|---|
| **Theme 1** | 按钮的风格设计与交互功能 | 35 处缺 `type="button"`、`:focus-visible` 圆角变形、5 套方言 CSS、异步双击竞态、`AntiAccountUsageButton` 伪禁用态 | 补全 `ga-actions.css` 三档尺寸与语义变体、引入 `<Button>` 原语、同步 `useRef` 锁、`CloseIconButton` 收口 | 7（另含协作提交 `f76870e`） | **PASS**（Iter 2） |
| **Theme 2** | 弹窗、抽屉、浮层堆叠与破坏性操作确认体系 | 8+ 未入栈 `role="dialog"` 导致 `Esc` 穿透、`Z_LAYERS` 层级倒置、11 个编辑弹窗静默丢草稿、4 处不可逆高危操作零确认 | 重排 `Z_LAYERS`、扩展 `overlayStack`（`trapFocus` + 跨层 Tab 捕获）、`useOverlayRegistration`、`useDirtyClose`、`dialog.confirm` 边界统一 | 5 | **PASS**（Iter 2） |
| **Theme 3** | 反馈、错误路由、加载与空状态体系 | `HttpError` 原生 JSON 泄漏、`.catch(() => {})` 静默吞错、`LiveChat` `pushSystem` 污染气泡、错误与空状态同时渲染、`ToastHost` 无悬停暂停 | `utils/errors.ts`（`extractErrorMessage`）、`ToastHost`/`toastStore` 去重与暂停、`QueryLoadState` 模式化、统一页面反馈路由 | 6 | **PASS**（Iter 2） |
| **Theme 4** | 表单、输入、选择器、校验与搜索筛选体系 | `AntiModelSelector` 仅支持 `Esc`、`dialog.alert` 阻塞校验、`ThemeTasks` 静默禁用保存、`MyKey` 数值回弹、`StorageSettingsPanel` 逐键 `PATCH` + 失效 `bg-surface` | `AntiModelSelector` 全键盘与 `Tab` 页脚接力、`.ga-select*` / `.ga-input*` / `.ga-field-error`、行内 `role="alert"` 校验、`StorageSettingsPanel` 草稿提交、搜索清空/重置 | 6 | **PASS**（Iter 2） |
| **Theme 5** | 导航标签、跨引擎输入流、键盘无障碍与暗色主题一致性 | `<BrowserRouter>` 下侧栏/`Ctrl+K` 丢未保存草稿、`Settings`/`AntiChat` 丢 URL 子状态、3 组 `tablist` 缺方向键、`Conductor`/`GoalHive` 缺 80ms IME 与回底按钮、`SessionRail` 仅双击改名、`FileCitation` 无菜单键盘化、`dark-forest` 硬编码亮色 hex | `navigationGuardStore` + `GuardedLink`、`?tab=`/`?session=` 持久化、`ErrorBoundary` 原地重试、`tabListA11y`、`useImeCompositionGuard`、`SessionRail` `F2`/按钮改名、`FileCitation` ARIA 菜单、`dark-forest` Token 补齐 | 8 | **PASS**（Iter 2） |

### 1.3 基线与最终全量验证对比

| 检查项 | 审查前基线（`602fd7b`） | 最终交付（`2c4905b`） | 变化说明 |
|---|---|---|---|
| `npm --prefix webui run lint` | Exit `0` | Exit `0` | 零 TypeScript 编译错误 |
| `npm --prefix webui test -- --run` | `131` files / `1237` tests | `144` files / `1341` tests | **+13 测试文件 / +104 测试用例**，全绿通过 |
| `npm --prefix webui run api:check` | Exit `0`（113 / 206） | Exit `0`（113 / 206） | 前后端 OpenAPI 契约 100% 对齐 |
| `webui/src/**/*.tsx` `<button` 缺 `type=` AST 审计 | `35` 处真实缺失（36 正则含 1 注释）/ 370 | **`0` 处缺失** / `377`（88 文件） | 100% 生产 `<button>` 显式声明 `type=` |
| `python -m pytest tests/test_repo_hygiene.py -q` | Exit `0`（3 passed） | Exit `0`（3 passed） | 仓库根目录白名单与卫生规范全绿 |
| `python -m pytest tests -q` | `1 failed, 1492 passed, 84 skipped` | 默认深路径：`2 failed, 1491 passed, 84 skipped`；短 `--basetemp` 与单项重跑均为 `1 passed` | 详见第 4 节（均为既有环境路径长度/时序问题，本轮零 Python 改动） |

---

## 2. 分主题深度审查、统一方案与修复明细（Themes 1–5）

---

### 2.1 Theme 1：按钮的风格设计与交互功能

#### 2.1.1 真实需求差与核心痛点

基线调查（Survey 1）统计 `webui/src/` 非测试 TSX 文件共 **370 个 `<button>`**（实际有效 JSX 元素 361–370 个，含 1 处注释匹配）：

1. **语义与表单安全缺口**：35 个真实 `<button>` 省略 `type="button"`（包含 `ThemeTaskSettings` 弹窗页脚的「取消」「保存」以及 `MyKey`、`Conductor`、`TokenStats` 等卡片与表单内按钮），HTML 默认将其视为 `type="submit"`，在表单演化时存在误触提交风险。
2. **键盘焦点与可达性缺陷**：
   - `webui/src/styles/index.css` 基础层 `:where(...:focus-visible)` 硬编码 `border-radius: 6px;`，导致 `rounded-full` 圆形/胶囊按钮在键盘聚焦时轮廓瞬间畸变为方形。
   - `model-select.css`（`.model-select-trigger:focus { outline: none; }`）与 `AntiModelSelector.tsx` 直接抑制焦点轮廓而未提供 `focus-visible:ring-*`，`.ga-btn-icon-badge` / `.ga-btn-chip` 也缺失焦点环。
   - `AntiChat.tsx` 授权回收 `X` 按钮仅包裹 `<X size={10} />` 且无内边距，点击热区仅 10×10px，极易误触。
3. **按钮方言割裂与类冲突**：
   - `ga-actions.css` 仅有 `34px`（`ga-btn`）与 `26px`（`ga-btn-sm`）两档，缺乏紧凑 `xs`（`24px`）与 `danger-outline` / `icon-danger` / `link-muted` 变体，迫使各页面复制 `compactBtn`（`AntiAgyProfiles`、`AntiOrchestratorModal`）、内联覆写尺寸（`WorkerDossier`、`Conversations`、`ThemeTasks`），或继续维护 5 套页面私有 CSS（`mykey.css`、`token-stats.css`、`conductor.css`、`messageDialog.css`、`AntiDaemonControl` 长串 Tailwind）。
   - `ThemeTasks.tsx` 将 `ga-btn-sm` 与 `ga-solid-primary` 混用于同一按钮，导致背景/禁用态覆盖冲突；`mykey.css` 的 `.mykey-card__action--success` 使用了蓝色 `--c-status-info-rgb` 而非成功绿。
   - `disabled` 态规范不统一：部分 `.ga-btn-*` 仅使用 `opacity-35..50` 且缺失 `disabled:active:scale-100`，禁用按钮按下仍出现缩放动画。
4. **异步双击竞态与误导性样式**：
   - `Autonomous.tsx` (`ScheduleCard`)、`Tasks.tsx` (`TaskCard` 仅状态锁)、`MyKey.tsx` (`remove` / `handleOpenFile` / `runTest` / `SessionDialog.save` / `toggleAutoSync`)、`FontAppearancePanel.tsx`（4 个异步操作）缺少同步 `useRef` 锁或加载文案，在慢网络下同一事件 tick 连击会发出重复请求或重复弹错；`FontAppearancePanel` 「启用」「移除」禁用时不显示 `启用中…`/`移除中…`。
   - `AntiAccountUsageButton.tsx` 在后台未运行时为触发按钮加上 `cursor-default opacity-65`，使仍可点击打开配额弹窗的按钮外观呈现「不可点击的禁用态」。
5. **弹窗关闭按钮与顶栏高度参差**：7+ 处关闭按钮未复用 `CloseIconButton`，`AntiChat` 顶栏控制区混合 `35px`/`32px`/`28px` 三种高度；`AntiAgyProfiles` 等级图标与 `SessionRail`/`CollapseToLatestButton` 悬浮把手硬编码浅色 hex，在 `dark-forest` 下对比度不足。

#### 2.1.2 交互逻辑、代码组织与统一解决方案

1. **完善 `ga-actions.css` 语义词表并引入 `<Button>` 原语（`e4502e9`）**：
   - 确立三档标准高度：`md`（`h-[34px] px-3 rounded-lg text-sm`）、`sm`（`.ga-btn-sm*` `h-7 px-2.5 rounded-md text-xs`）、`xs`（`.ga-btn-xs*` `h-6 px-2 rounded-md text-[11px]`）。
   - 补齐危险态与图标/链接变体：`.ga-btn-sm-solid-danger`、`.ga-btn-xs-solid-danger`、`.ga-btn-danger-outline`、`.ga-btn-xs-danger`、`.ga-btn-icon-danger`、`.ga-btn-link-muted`。
   - 全量 `.ga-btn*` / `.ga-solid-*` / `.ga-segmented-btn` / `.ga-btn-group-item*` 统一加入 `disabled:active:scale-100 disabled:cursor-not-allowed` 与 `--c-disabled-*` 对比度 token。
   - 新增 `webui/src/components/Button.tsx`（默认 `type="button"`，支持 `variant` / `size` / `loading` / `loadingText` / `aria-busy` / `ref` 转发）。
2. **全局焦点环与显式 `type=` 治理（`502d31b`）**：
   - 为全部 35 个缺失 `type=` 的 `<button>` 补齐显式 `type="button"`；移除 `index.css` 全局 `:focus-visible` 的 `border-radius: 6px;`；为 `model-select.css`、`AntiModelSelector`、`.ga-btn-icon-badge`、`.ga-btn-chip` 补齐 `focus-visible:ring-2`。
3. **方言收敛与异步防重（`a911669`, `3b8ac2a`, `2be82aa`, `1447241`, `ef274c1`）**：
   - 清理 `mykey.css`、`token-stats.css`、`.conductor-action-btn`、`AntiOrchestratorModal`、`WorkerDossier`、`Conversations`、`Tasks`、`LiveChatComposer`、`AntiDaemonControl`、`AntiAgyProfiles` 的局部按钮方言。
   - 在 `Autonomous` `ScheduleCard`、`Tasks` `TaskCard`、`MyKey`（`remove`、`handleOpenFile`、`handleUploadSync`/`handleFetchSync`、`toggleAutoSync`、`SessionCard.runTest`、`SessionDialog.save`）、`FontAppearancePanel`（全部 4 个操作 + 导入）及 `AntiAgyProfiles`（`刷新授权状态`）落地 **`useRef` 同步入口锁 + React 状态反馈 + `finally` 释放**，防止同 tick 连击穿透及确认弹窗期重入。
   - 收口 `SubagentSettingsModal`、`FileTransferBox`、`Tasks`、`AntiChat` 横幅的 `CloseIconButton`，对齐 `AntiChat` 顶栏 `h-[35px]`，放大 `AntiChat` 授权回收按钮点击热区至 `h-4 w-4`，并提取 `.ga-floating-handle` 与 `.ga-account-tier-icon--*` 适配 `dark-forest`。

#### 2.1.3 关键决断与取舍（含未采纳方案与原因）

- **决断 1：双轨制（`ga-actions.css` 优先 + `<Button>` 原语增量引入），不强行重写全仓 361 个原生 `<button>`**  
  - *原因*：大量现有测试（如 `AntiChat.test.tsx`、`MyKey.test.tsx`、`Tasks.test.tsx`）与高密度工具栏直接依赖精简 DOM 和精确类名；在 `ga-actions.css` 完成语义收敛的同时提供 `<Button>`（默认 `type="button"` 与 `loading`），并以 TypeScript AST 扫描保障所有 `<button>` 显式声明 `type=`，既立刻消除样式与行为分歧，又避免无收益的机械重构风险。
- **决断 2：保留部分弹窗页脚或下拉条中的文字「关闭」按钮（如 `AntiOrchestratorModal`、`AntiAgyProfiles`/`AntiDaemonControl` 顶条）**  
  - *原因*：`AntiChat.test.tsx` 显式通过文本 `'关闭'` 查询并操作这些关闭按钮，且文字「关闭」在多标签设置面板中有助于消除「× 是清除账号还是关闭浮层」的歧义；因此将图形 `×` 收口至 `CloseIconButton`（并修正 `variant="compact"` 尊重传入 `rounded-*` 类），保留已有测试契约的文字关闭按钮。
- **决断 3：外部协作者并行提交 `f76870e` 的兼容收尾**  
  - *背景*：在 Commit 3 (`a911669`) 与 Commit 4 (`3b8ac2a`) 之间，外部协作者合并了 `f76870e`（将 `AntiAgyProfiles` 与 `AntiDaemonControl` 从模态框改为顶部下拉浮层）。我们未在 Commit 3 中硬改其并行修改文件，而是在 `f76870e` 落库后专门新增 `ef274c1` 清理其中残留的 `compactBtn`、裸关闭按钮、`tier` 单选框禁用游标及 `刷新授权状态` 异步锁。

#### 2.1.4 问题清单、独立 Git Commit SHA 与涉及文件映射表

| Commit SHA | 类型 / 摘要 | 解决的核心问题 | 涉及文件（摘要） |
|---|---|---|---|
| `502d31b` | `fix(webui): add explicit button types and fix focus-visible rings` | 补齐 35 处缺失 `type="button"`；移除 `index.css` `:focus-visible` 的 `border-radius: 6px`；修复 `model-select.css`/`AntiModelSelector`/`ga-actions.css` 焦点环 | `App.tsx`, `AntiModelSelector.tsx`, `CommandPalette.tsx`, `ErrorBoundary.tsx`, `MyKeyRawView.tsx`, `ThemeConversationHistory.tsx`, `ThemeTaskHistory.tsx`, `Autonomous.tsx`, `Conductor.tsx`, `GoalHive.tsx`, `MyKey.tsx`, `Tasks.tsx`, `ThemeTasks.tsx`, `TokenStats.tsx`, `ga-actions.css`, `index.css`, `model-select.css`（17 文件） |
| `e4502e9` | `style(webui): standardize ga-actions button sizes, disabled states, semantic variants, and Button primitive` | 统一三档按钮尺寸、语义变体、`disabled:active:scale-100`；新增 `<Button>` 组件与单测；修复 `ThemeTasks.tsx` 类冲突 | `Button.tsx`, `Button.test.tsx`, `ThemeTasks.tsx`, `ga-actions.css`（4 文件） |
| `a911669` | `refactor(webui): converge module-local button dialects onto ga-actions` | 收敛 `mykey.css`、`token-stats.css`、`conductor.css`、`compactBtn` 及各页面内联按钮样式 | `AntiOrchestratorModal.tsx`, `LiveChatComposer.tsx`, `NovaSettingsPanel.tsx`, `StorageSettingsPanel.tsx`, `TaskCard.tsx`, `TaskConversation.tsx`, `WorkerDossier.tsx`, `Conversations.tsx`, `MyKey.tsx`, `Tasks.tsx`, `TokenStats.tsx`, `conductor.css`, `mykey.css`, `token-stats.css`（14 文件） |
| `f76870e` | *[外部协作者提交]* `ui(anti): convert account management and runtime diagnostics into top-down dropdowns` | 将 Agy 账号管理与运行时诊断转为顶部下拉浮层 | `AntiAgyProfiles.tsx`, `AntiDaemonControl.tsx`, `AntiChat.tsx`, `AntiChat.test.tsx`（4 文件） |
| `3b8ac2a` | `fix(webui): guard async button actions against double-clicks and misleading disabled cues` | 为 `Autonomous` `ScheduleCard`、`MyKey` 删/开/同步、`FontAppearancePanel` 加异步锁；修复 `AntiAccountUsageButton` 伪禁用游标 | `AntiAccountUsageButton.tsx`, `AntiAccountUsageButton.test.tsx`, `FontAppearancePanel.tsx`, `FontAppearancePanel.test.tsx`, `Autonomous.tsx`, `Autonomous.test.tsx`, `MyKey.tsx`, `MyKey.test.tsx`（8 文件） |
| `1447241` | `ui(webui): unify close buttons, header control heights, revoke hit-target, and dark-forest button contrast` | 收口 `CloseIconButton`；对齐顶栏 35px 高度；扩大授权回收热区；统一 `.ga-floating-handle` 与 `dark-forest` 按钮对比度 | `AntiAccountUsageButton.tsx`, `AntiAgyProfiles.tsx`, `CollapseToLatestButton.tsx`, `FileTransferBox.tsx`, `SessionRail.tsx`, `SubagentSettingsModal.tsx`, `AntiChat.tsx`, `Tasks.tsx`, `ga-actions.css`（9 文件） |
| `2be82aa` | `fix(webui): add synchronous useRef locks and loading labels to async actions` | （Iter 1 评审/对抗整改）为 `Tasks` `TaskCard`、`FontAppearancePanel` 全 4 动作、`MyKey` `runTest`/`SessionDialog.save`/`toggleAutoSync` 补齐同 tick `useRef` 锁与加载态文案 | `FontAppearancePanel.tsx`, `FontAppearancePanel.test.tsx`, `MyKey.tsx`, `MyKey.test.tsx`, `Tasks.tsx`, `Tasks.test.tsx`（6 文件） |
| `ef274c1` | `refactor(webui): clean up residual f76870e button dialects, CloseIconButton radius, and disabled styles` | （Iter 1 评审/对抗整改）清理 `f76870e` 残留按钮方言与 `刷新授权状态` 异步锁；`CloseIconButton` 尊重外部 `rounded-*`；修复 `.conductor-history-delete:disabled` 与 `ThemeTasks`/`Conversations` 覆写 | `ActionIcons.tsx`, `ActionIcons.test.tsx`, `AntiAgyProfiles.tsx`, `AntiDaemonControl.tsx`, `AntiChat.tsx`, `AntiChat.test.tsx`, `Conversations.tsx`, `ThemeTasks.tsx`, `conductor.css`（9 文件） |

---

### 2.2 Theme 2：弹窗、抽屉、浮层堆叠与破坏性操作确认体系

#### 2.2.1 真实需求差与核心痛点

1. **未入栈浮层与 `Escape` 穿透 / `Z_LAYERS` 倒置**：
   - `zLayers.ts` 原定义为 `modal: 50, palette: 55, dialog: 60, tooltip: 62, contextMenu: 65`，注释声称 tooltip 不应压过弹窗，实际 `tooltip (62)` 和 `contextMenu (65)` 均高于 `DialogHost (60)` 和 `CommandPalette (55)`。
   - `AntiAccountUsageButton`、`ConversationTurnMinimap`、`FileTransferBox`、`BtwDialog`（`ImagePasteInput.tsx`）、`HistoryDropdown`、`PathLink` 菜单、`AntiModelSelector`、`AntiChat` `policyOpen`、`AntiAgyProfiles`、`AntiDaemonControl`、`DesktopRuntimeGate` (`lost`) 共 10+ 个浮层均未接入 `overlayStack`，有的仅绑元素内 `onKeyDown`（焦点移出后 `Esc` 失效），有的绑全局 `window/document` 监听器且不检查顶层栈（导致在 `HistoryDropdown` 内按 `删除` 弹出 `dialog.confirm` 时，按一次 `Esc` 同时关闭确认框和下拉列表），`DesktopRuntimeGate`（`z=80`）背后底层 `ModalOverlay` 仍能响应 `Esc`/`Tab`。
   - `BtwDialog` 拖拽边界未钳位，用户可将其拖出可视窗口外，且在窗口缩小后不会自动回弹。
2. **编辑类弹窗静默丢弃未保存修改**：
   - `Tasks.tsx` (`TaskDialog`) 与 `Autonomous.tsx` (`ScheduleDialog`) 原写 `closeOnBackdrop={!saving}`——空闲时 `saving === false`，实为 `true`，误点遮罩立即丢失全部草稿。
   - `AntiOrchestratorModal`、`SubagentSettingsModal`、`GoalHive` 弹窗、`AntiChat` 创建弹窗直接缺失 `closeOnBackdrop={false}`。
   - 全部 11 个编辑/创建弹窗在 `Esc`、`×`、「取消」路径上均无脏数据提示；同时 `AntiAgyProfiles` 存在渲染期同步调用 `setView({ kind: initialView })` 的反模式，且关闭/切回列表会直接丢失 `renameDraft` 或遗留过期异步 `codeLoginStatus` 轮询结果。
3. **高危不可逆操作缺失确认 & 确认边界碎片化**：
   - `AntiQueuedDock`「清空」（一次性清空全部待发队列）、`AntiAgyProfiles`「清除凭据」（立即注销 OAuth 凭据，而同页「删除账号」却用了两步内联 state）、`FontAppearancePanel`「移除」（删除 10–30MB 本地字体包）、`Conductor` `WorkerDossier`「终止」（强行中止运行中子代理）均一键直接执行，无任何确认。
   - `FileTransferBox` 内联确认条缺少 `role="alertdialog"` 与 `aria-label`。

#### 2.2.2 交互逻辑、代码组织与统一解决方案

1. **浮层栈仲裁与层级重排（`7ac9252`, `0ad9ff3`）**：
   - **重排 `Z_LAYERS`**：`tooltip: 40, popover: 45, modal: 50, contextMenu: 52, palette: 55, dialog: 60, toast: 70, gate: 80, chrome: 10000`。确保页面悬浮气泡/工具提示永远低于模态框/命令面板/确认框，而模态框内呼出的右键菜单/下拉菜单（`52`）高于模态框（`50`）又低于系统确认框（`60`）。
   - **扩展 `overlayStack.ts` 并新增 `useOverlayRegistration.ts`**：增加 `trapFocus?: boolean`（默认 `true`）与 `hasHigherLayerOverlay(zIndex)`；在 Iter 2 (`0ad9ff3`) 进一步实现**嵌套 `Tab` 跨面板捕获**（当顶层是 `trapFocus: false` 的传送门菜单如 `AntiModelSelector` 时，向下寻址最近的 `trapFocus: true` 祖先面板并合并焦点序列，防止 `Tab` 逃逸到背景页）以及**受保护的焦点恢复**（`restoreOverlayFocus` 优先检查当前是否存在更高层 `trapFocus: true` 浮层如 `DesktopRuntimeGate`，避免底层弹窗卸载时把焦点偷走）。
   - 将上述全部 11 处浮层/门控统一接入 `useOverlayRegistration`，并为 `SessionRail` 内联 `Esc` 监听增加 `hasActiveOverlay()` 守卫；为 `BtwDialog` 提取 `clampBtwPosition`（`8px` 边距）并在 `mousemove` 与 `window.resize` 同步执行。
2. **统一脏关闭守卫 `useDirtyClose.ts`（`a98cd58`, `f7e3cea`）**：
   - 新增 `useDirtyClose({ dirty, busy, onClose, ... })`：当 `dirty === false` 时同步关闭（完全保留既有的无修改按 `Esc` 瞬时关闭测试）；当 `dirty === true` 时以 `confirmingRef` 防重入锁拉起 `dialog.confirm(..., { confirmText: '放弃修改', cancelText: '继续编辑', tone: 'danger' })`。
   - 为全部分布于 `Tasks`、`Autonomous`、`MyKey`、`ThemeTasks`、`LiveChat`、`AntiOrchestratorModal`、`SubagentSettingsModal`、`GoalHive`、`AntiAgyProfiles`、`AntiChat` 的编辑/创建弹窗统一落地 `closeOnBackdrop={false}` + `useDirtyClose`；并将 `AntiAgyProfiles` 的同步渲染期 `setView` 改为 `useLayoutEffect` + `codeLoginEpochRef` 异步防串台。
   - 在 Iter 2 (`f7e3cea`) 修复 `MyKey` `SessionDialog` 复制模式下 `apikey` 在 `undefined` 与 `''` 间往返被误判为脏数据的边界，并对齐 `AntiAgyProfiles` 关闭按钮 `disabled={busy}`。
3. **破坏性操作确认边界统一（`f54cbdf`）**：
   - 确立双层规范：常规页面/弹窗/抽屉的不可逆操作（`AntiQueuedDock` 清空、`AntiAgyProfiles` 清除凭据与删除账号、`FontAppearancePanel` 移除字体包、`Conductor` 终止子代理）统一经 `dialog.confirm(..., { tone: 'danger' })`（红按钮 + 安全默认焦点在「取消」+ 同步防重入）；窄侧边栏或非模态小浮层（`SessionRail` 200px、`FileTransferBox` 288px、`AntiDaemonControl` 顶栏）保留紧凑内联 `role="alertdialog"` 条，避免全屏遮罩与外点击关闭冲突。

#### 2.2.3 关键决断与取舍（含未采纳方案与原因）

- **决断 1：`overlayStack` 支持 `trapFocus: false` 而非强制所有浮层改用 `ModalOverlay`**  
  - *原因*：`AntiAccountUsageButton`、`FileTransferBox`、`HistoryDropdown`、`BtwDialog`、`ConversationTurnMinimap` 均属于非阻塞工具浮层，用户在打开它们时仍需要点击聊天框或使用 `Tab` 切回主流程，强加全屏遮罩与 Tab 锁死会严重破坏多任务效率。`trapFocus: false` 让非模态浮层既享受全局 `Esc` 栈序仲裁，又保持非阻塞工作流。
- **决断 2：`SessionRail` / `FileTransferBox` / `AntiDaemonControl` 保留内联两步确认条，不全部替换为全局 `dialog.confirm`**  
  - *原因*：在 `288px` 非模态浮层（如 `FileTransferBox`）内弹出全屏确认框会打断视觉上下文，且窄侧栏内的就地确认条响应更快；相比之下，`AntiAgyProfiles` 内的 `删除账号` 原先自己维护一套 `confirmDeleteId` 状态，与其同卡内的 `清除凭据` 一并收口到 `dialog.confirm`，既消除冗余局部状态，又统一了账号危险动作的体验。

#### 2.2.4 问题清单、独立 Git Commit SHA 与涉及文件映射表

| Commit SHA | 类型 / 摘要 | 解决的核心问题 | 涉及文件（摘要） |
|---|---|---|---|
| `7ac9252` | `fix(webui): unify overlay stack registration, z-layers, Escape arbitration, and BtwDialog drag bounds` | 重排 `Z_LAYERS`；`overlayStack` 加 `trapFocus`/`hasHigherLayerOverlay`；新增 `useOverlayRegistration` 并接入 11 处浮层/门控；`BtwDialog` 拖拽钳位与 IME 229 保护 | `zLayers.ts`, `overlayStack.ts`, `useOverlayRegistration.ts`, `OverlayStack.test.tsx`, `AntiAccountUsageButton.tsx`, `AntiAgyProfiles.tsx`, `AntiDaemonControl.tsx`, `AntiModelSelector.tsx`, `ConversationTurnMinimap.tsx`, `ConversationTurnMinimap.test.tsx`, `FileCitation.tsx`, `FileTransferBox.tsx`, `FileTransferBox.test.tsx`, `ImagePasteInput.tsx`, `ImagePasteInput.test.tsx`, `SessionRail.tsx`, `HistoryDropdown.tsx`, `AntiChat.tsx`, `Conductor.test.tsx`, `DesktopRuntimeGate.tsx`, `DesktopRuntimeGate.test.tsx`（21 文件） |
| `a98cd58` | `fix(webui): guard dirty edit modals on close, enforce closeOnBackdrop=false, and fix AntiAgyProfiles render-phase state sync` | 新增 `useDirtyClose`；全部编辑/创建弹窗统一 `closeOnBackdrop={false}` 与脏关闭提示；修复 `AntiAgyProfiles` 渲染期 `setView` 与 `codeLoginStatus` 过期响应复活；`ThemeTasks` 关闭选会话清空 `search` | `useDirtyClose.ts`, `useDirtyClose.test.tsx`, `AntiAgyProfiles.tsx`, `AntiOrchestratorModal.tsx`, `SubagentSettingsModal.tsx`, `AntiChat.tsx`, `AntiChat.test.tsx`, `Autonomous.tsx`, `Autonomous.test.tsx`, `Conductor.test.tsx`, `GoalHive.tsx`, `GoalHive.test.tsx`, `LiveChat.tsx`, `MyKey.tsx`, `MyKey.test.tsx`, `Tasks.tsx`, `Tasks.test.tsx`, `ThemeTasks.tsx`, `ThemeTasks.test.tsx`（19 文件） |
| `f54cbdf` | `fix(webui): add missing confirmations for destructive actions and unify confirmation boundaries` | 为 `AntiQueuedDock` 清空、`AntiAgyProfiles` 清除凭据/删除账号、`FontAppearancePanel` 移除字体、`Conductor` 终止子代理补齐 `dialog.confirm(..., { tone: 'danger' })`；为 `FileTransferBox` 内联确认条补 `role="alertdialog"` | `AntiAgyProfiles.tsx`, `FileTransferBox.tsx`, `FileTransferBox.test.tsx`, `FontAppearancePanel.tsx`, `FontAppearancePanel.test.tsx`, `AntiChat.tsx`, `AntiChat.test.tsx`, `Conductor.tsx`, `Conductor.test.tsx`, `Settings.test.tsx`（10 文件） |
| `0ad9ff3` | `fix(webui): fix nested overlay Tab trap, gate focus preservation, and BtwDialog resize clamp` | （Iter 1 对抗整改）修复 `ModalOverlay` + 传送门 `AntiModelSelector` 的 Tab 逃逸；修复底层弹窗卸载偷走 `DesktopRuntimeGate` 焦点；`BtwDialog` 监听 `window.resize` 重新钳位 | `overlayStack.ts`, `OverlayStack.test.tsx`, `ImagePasteInput.tsx`, `ImagePasteInput.test.tsx`, `DesktopRuntimeGate.test.tsx`（5 文件） |
| `f7e3cea` | `fix(webui): normalize empty apikey in MyKey dirty check and align AntiAgyProfiles close disabled state` | （Iter 1 对抗/评审整改）修复 `MyKey` 复制模式清空 `apikey` 误判脏状态；对齐 `AntiAgyProfiles` 关闭按钮 `disabled={busy}` | `MyKey.tsx`, `MyKey.test.tsx`, `AntiAgyProfiles.tsx`（3 文件） |

---

### 2.3 Theme 3：反馈、错误路由、加载与空状态体系

#### 2.3.1 真实需求差与核心痛点

1. **原始 `HttpError` JSON 泄漏与错误提取工具错位**：
   - `HttpError` 构造 `JSON.stringify(body)`，而 `AntiChat`（14 处）、`AntiAgyProfiles`、`AntiAccountUsageButton`、`AntiOrchestratorModal`、`NovaSettingsPanel`、`Conductor.stopConductor` 直接读取 `.message`，向用户展示 `'{"detail":"..."}'` 原始 JSON。
   - 唯一较完善的格式化函数 `errorMessageFromError` 寄居在会话专用模块 `utils/sessionUi.ts` 中，且未能解包顶层 `body.message` / `body.error` 及多层嵌套空信封（如 `{ detail: {} }`）。
2. **`ToastHost` / `toastStore` 无障碍与可读性缺陷**：
   - `ToastHost` 所有提示（包含 `error`）一律使用 `role="status"` 而非 `role="alert"`。
   - 整卡绑定 `onClick` + `cursor-pointer`，用户无法划选复制报错文本；且无明确关闭按钮、无悬停/聚焦暂停计时、无同文案去重，连点会刷屏并在阅读时突然消失。
3. **静默吞错、隐形弹窗报错与竞态通道混用**：
   - `SessionRail` (`onBlur`/`remove` `.catch(() => {})`)、`AntiChat.handleSelectFamily` (`.catch(() => undefined)`)、`AntiAgyProfiles` 手动点击「刷新」(`.catch(() => undefined)`)、`StorageSettingsPanel` (`agyGcPolicy` `.catch(() => null)`) 静默丢失错误。
   - `AntiChat` 将 `rename.error` / `remove.error` 传入顶部 `<Errors />` 且从不 `.reset()`，导致一次失败永久钉死在页面顶部；`AntiAgyProfiles` 将 `activeError` 放在可滚动容器内部顶端，滚到底部点击操作报错时完全不可见。
   - `LiveChat.tsx` 将侧边栏/标题栏操作（重命名、删会话、改项目、改模型、中止、取消定时）失败全部通过 `pushSystem` 塞进当前聊天记录气泡，当用户在侧栏重命名另一个会话失败时，报错气泡会污染当前会话正文；同时 `Tasks` 与 `Autonomous` 反馈完全不对称（`Tasks` 有部分 `toast.success`、失败用 `dialog.alert`；`Autonomous` 成功零反馈、失败全用 `dialog.alert`）。
   - `AntiOrchestratorModal` 忽略 `modelsConfigQuery.isError` 并悄悄用默认预设填表，允许用户误点保存覆盖服务端配置；`NovaSettingsPanel` 轮询成功后不清除旧的拉取错误。
4. **错误态与空状态互斥失效 & 缺失重试入口**：
   - `ThemeTasks.tsx` 在请求失败且无数据时同时渲染「加载失败」和「暂无主题任务」；`LiveChatTranscript.tsx` 在 `history_error` 且消息为空时同时渲染「历史消息加载失败」和「开始一段对话…」。
   - `FontAppearancePanel`、`StorageSettingsPanel`、`ThemeTaskSettings`、`ChatRetryPanel`、`AntiAccountUsageButton`、`GoalHive`、`Conductor` (`llmsFailed`)、`MyKey` (`autoSync`) 多处加载失败无「重试」按钮。

#### 2.3.2 交互逻辑、代码组织与统一解决方案

1. **提取通用错误格式化与增强 `ToastHost` / `QueryLoadState`（`d76392e`, `5c11e18`, `86d167f`, `2c4905b`）**：
   - 新建 `webui/src/utils/errors.ts` 导出 `extractErrorMessage(error, fallback)`（保留 `utils/sessionUi.ts` 对 `errorMessageFromError` 的兼容重导出），支持 FastAPI `detail` 字符串/对象、顶层 `message`/`error`、JSON 字符串包裹错误、空对象/嵌套空信封（`{ detail: {} }` / `{ error: {} }` / `{ detail: [] }`）安全回退及 `HttpTimeoutError`/`NetworkError` 友好文案。
   - 重构 `toastStore.ts` 与 `ToastHost.tsx`：追踪定时器句柄与剩余毫秒数，实现 `pause`/`resume`（Iter 2 在 `ToastHost` 引入 `hoveredRef` + `focusedRef` 双态跟踪避免鼠标移出但焦点仍在内部关闭按钮时提前恢复计时）、相同 `(kind, message)` 去重刷新、误差提示改用 `role="alert"`、移除整卡点击关闭并改为 `select-text` + 独立 `<button type="button" aria-label="关闭提示">`；同时在 `1ae8172`（M4 收尾）加固 jsdom 卸载时的定时器清理。
   - 为 `QueryLoadState.tsx` 扩展 `compact` / `showDetail` 模式（使用 `extractErrorMessage`）。
2. **消除吞错与通道收敛（`eea4164`, `e987379`, `5c11e18`）**：
   - **确立统一反馈路由契约**：
     - 瞬时变更结果（保存/切换/触发/删除/重命名/清空/中止）→ `toast.success` / `toast.error`（经 `extractErrorMessage`）；
     - 长诊断 stderr/多行详情（如 `MyKey` 同步、`CommandPalette`、`LiveChat` 回溯失败）→ `dialog.alert(..., { detail })`；
     - 模态框内上下文强相关表单提交错 → 固定置顶于滚动区外的 `role="alert"` 横幅；
     - 查询加载失败 → `QueryLoadState`（或带 `重试` 按钮的 `role="alert"` 区域），严禁与空状态「暂无…」共存；
     - 聊天回合内流式状态提示 → `pushSystem`。
   - 落地清理 `SessionRail`、`AntiChat`（全部 14 处裸 `.message`、`handleSelectFamily`、`rename/remove` 转 `toast.error`）、`FileTransferBox`、`AntiAccountUsageButton`（离浮层报错转 toast + 浮层内报错重试）、`AntiAgyProfiles`（状态/错误条钉死在滚动体上方、切换视图清除旧错、手点刷新报 toast）、`AntiOrchestratorModal`（拉取失败阻断误保存并提供重试）。
   - 统一 `LiveChat`（外围/侧栏失败走 `toast.error`）、`Tasks` / `Autonomous`（成功补齐 `toast.success`，接口错误改 `toast.error`）、`Settings`（`ChatRetryPanel` / `NotifyPanel` 定时器清理与状态报错）、`NovaSettingsPanel`（分离状态轮询错与动作操作错，状态恢复自动清除旧错）、`StorageSettingsPanel`、`Conductor`、`GoalHive`（`llms` 失败重试 & WS `send` 返回 `false` 提示）。
3. **加载/空状态互斥与重试覆盖（`fb7dc49`, `d453bad`）**：
   - 修复 `ThemeTasks` 与 `LiveChatTranscript` 错误态与空状态同时出现的逻辑漏洞；在 `FontAppearancePanel`、`StorageSettingsPanel`、`MyKey` (`autoSync` + 主列表)、`ThemeTaskSettings` 补齐 `QueryLoadState` 与重试按钮。
   - **质量门禁纠偏记录**：M3 首轮 `fb7dc49` 重写了 `FontAppearancePanel.test.tsx`，取证审计员（`efa58d8b`）检出其误删了 M1/M2 的 2 条异步锁与移除确认回归测试并触发 `INTEGRITY VIOLATION` 否决；第二轮通过 `d453bad` 完整恢复并扩充了全部 M1/M2 回归测试，并获审计员 `CLEAN` 放行。

#### 2.3.3 关键决断与取舍（含未采纳方案与原因）

- **决断 1：将 `extractErrorMessage` 独立至 `utils/errors.ts` 并在 `sessionUi.ts` 保留重导出别名**  
  - *原因*：设置面板、任务页、Conductor 等模块与会话毫无关系，依赖 `sessionUi.ts` 造成架构反向耦合；保留 `sessionUi.ts` 重导出则使已有 24 个单测与第三方调用零破坏平滑过渡。
- **决断 2：`LiveChat` 保留回合级 `pushSystem`，仅将侧栏/标题栏/项目/模型/计划/中止错误迁至 `toast`**  
  - *原因*：发送受阻、队列回退或 `/rewind` 冲突需要锚定在对话时间线中并配合草稿恢复提示，且 `chatStore.test.ts` 与 `LiveChat.submission.test.tsx` 均依赖该语义；而侧栏重命名/删会话错属于外围操作，迁入 `toast` 彻底解决了「串台气泡」痛点。

#### 2.3.4 问题清单、独立 Git Commit SHA 与涉及文件映射表

| Commit SHA | 类型 / 摘要 | 解决的核心问题 | 涉及文件（摘要） |
|---|---|---|---|
| `d76392e` | `feat(webui): harden ToastHost/toastStore a11y & extract shared error formatter / QueryLoadState modes` | 抽出 `utils/errors.ts`；强化 `toastStore` 去重与暂停计时；`ToastHost` 错误 `role="alert"` + 文本可选 + 显式关闭钮；扩展 `QueryLoadState` 模式 | `App.setup.test.tsx`, `QueryLoadState.tsx`, `QueryLoadState.test.tsx`, `ToastHost.tsx`, `ToastHost.test.tsx`, `toastStore.ts`, `toastStore.test.ts`, `errors.ts`, `errors.test.ts`, `sessionUi.ts`（10 文件） |
| `eea4164` | `fix(webui): eliminate swallowed errors, raw HttpError JSON leaks & hidden modal errors` | 消除 `AntiChat`/`SessionRail`/`FileTransferBox`/`AntiAccountUsageButton`/`AntiAgyProfiles`/`AntiOrchestratorModal` 吞错、JSON 原文泄漏、滚动区隐藏报错及配置误覆盖 | `AntiAccountUsageButton.tsx`, `AntiAccountUsageButton.test.tsx`, `AntiAgyProfiles.tsx`, `AntiAgyProfiles.test.tsx`, `AntiDaemonControl.tsx`, `AntiOrchestratorModal.tsx`, `AntiOrchestratorModal.test.tsx`, `FileTransferBox.tsx`, `FileTransferBox.test.tsx`, `SessionRail.tsx`, `AntiChat.tsx`, `AntiChat.test.tsx`（12 文件） |
| `e987379` | `refactor(webui): unify feedback routing across LiveChat, Tasks, Autonomous, Settings, Conductor & GoalHive` | 统一全站 6 大工作区反馈渠道；清理 `Settings` 未销毁 `setTimeout`；对齐 `Tasks`/`Autonomous` toast 提示；`Conductor`/`GoalHive` 模型失败与 WS 失败可见反馈 | `NovaSettingsPanel.tsx`, `NovaSettingsPanel.test.tsx`, `SessionRail.tsx`, `StorageSettingsPanel.tsx`, `AntiChat.tsx`, `Autonomous.tsx`, `Autonomous.test.tsx`, `Conductor.tsx`, `Conductor.test.tsx`, `GoalHive.tsx`, `GoalHive.test.tsx`, `LiveChat.tsx`, `LiveChat.creation.test.tsx`, `Settings.tsx`, `Settings.test.tsx`, `Tasks.tsx`, `Tasks.test.tsx`, `errors.ts`（18 文件） |
| `fb7dc49` | `fix(webui): standardize QueryLoadState adoption, retry controls & error/empty state exclusivity` | 修复 `ThemeTasks`/`LiveChatTranscript` 错误+空状态互斥；在 `FontAppearancePanel`/`StorageSettingsPanel`/`MyKey`/`ThemeTasks` 补全 `QueryLoadState` 与重试控制 | `FontAppearancePanel.tsx`, `FontAppearancePanel.test.tsx`, `LiveChatTranscript.tsx`, `LiveChatTranscript.test.tsx`, `QueryLoadState.tsx`, `StorageSettingsPanel.tsx`, `MyKey.tsx`, `MyKey.test.tsx`, `ThemeTasks.tsx`, `ThemeTasks.test.tsx`（10 文件） |
| `d453bad` | `test(webui): restore FontAppearancePanel M1/M2 async lock and confirm regression tests` | （Iter 1 审计纠偏）完整恢复并验证 `fb7dc49` 覆写遗失的 M1 异步锁定与 M2 删除确认回归测试 | `FontAppearancePanel.test.tsx`（1 文件） |
| `5c11e18` | `fix(webui): harden ToastHost pause state, error extraction, profile view error reset, and Nova status vs action errors` | （Iter 1 对抗/评审整改）修复 `ToastHost` hover+focus 双态暂停竞态；强化 `errors.ts` 422/null/空对象解包；`AntiAgyProfiles` 切视图清错；`NovaSettingsPanel` 分离状态错误与操作错误；`chatStore` `historyError` 经 `extractErrorMessage` 清洗 | `AntiAgyProfiles.tsx`, `AntiAgyProfiles.test.tsx`, `NovaSettingsPanel.tsx`, `NovaSettingsPanel.test.tsx`, `ToastHost.tsx`, `ToastHost.test.tsx`, `chatStore.ts`, `chatStore.test.ts`, `errors.ts`, `errors.test.ts`（10 文件） |

---

### 2.4 Theme 4：表单、输入、选择器、校验与搜索筛选体系

#### 2.4.1 真实需求差与核心痛点

1. **选择器实现分裂与 `AntiModelSelector` 键盘瘫痪**：
   - `ThemedSelect`（`ModelSelect`/`ProjectSelect`）具备完整键盘支持，而 `AntiModelSelector` 的 `onKeyDown` **仅处理 `Escape`**——完全无法用 `ArrowUp`/`ArrowDown`/`Home`/`End`/`Enter`/`Space`/首字母键入选择模型；且因下拉面板传送（Portal）到 `document.body`，在触发器按 `Tab` 会直接跳过页脚的「思考等级」单选组与设置按钮。
   - `.ga-select` 定义在未分层的 `index.css` 中，`.ga-select:focus { outline: none; }` 覆写了 `@layer base` 的 `:focus-visible` 焦点环；同时 `ThemeTaskSettings`、`MyKey` `SessionDialog`（3 处）、`AntiOrchestratorModal`（2 处）原生 `<select>` 未应用 `.ga-select`。
2. **表单校验阻塞与数值输入可用性缺陷**：
   - `Tasks` (`TaskDialog`) 与 `Autonomous` (`ScheduleDialog`) 用叠加模态框 `dialog.alert` 提示表单必填或 Cron/分钟错误，既打断上下文又无字段红框或自动聚焦；`ThemeTaskSettings` 在字段为空时直接静默禁用「保存」按钮，不提示哪一项未填。
   - `MyKey` `SessionDialog` 的 `thinking_budget_tokens` 受控绑定 `value={s.fields.thinking_budget_tokens ?? 32768}`，用户删空输入框打算重新输入时数值会瞬间弹回 `32768`。
   - `StorageSettingsPanel` 存在三重缺陷：(a) 4 个数值框使用不存在的 Tailwind 类 `bg-surface`，背景透明；(b) `onChange` 逐键触发 `PATCH` 请求并连带执行全盘 `storageApi.summary()` 扫描，中途 `savingPolicy` 还会锁死所有输入框；(c) 清空 `l1_grace_hours` 会立即把 `0` 提交到后端，清空 L0/L2/L3 则被 `min` 检查弹回，且缺少 JS 上界校验与双输入共裹同一 `<label>` 的语义问题。
   - `UpdateSettingsPanel` 本地 ZIP 表单在 `sha256` 非 64 位十六进制时静默禁用提交无内联提示；`GoalHive` 未配置可用 LLM 时底部无显式引导提示。
3. **搜索框与输入框 Token 碎片化**：
   - `ThemeTasks`（挑选会话弹窗）、`ConversationTurnMinimap`（原生 `type="search"`）、`CommandPalette` 搜索框缺少统一 `<Search>` 图标与清除 `×` 按钮；`ThemeTasks` 关闭挑会话弹窗时不重置 `search`。
   - 各页面各自声明 `inp`、`field`、`settingsField`、`inputClass` 等 7+ 套不兼容输入框样式。

#### 2.4.2 交互逻辑、代码组织与统一解决方案

1. **`AntiModelSelector` 全键盘化与 `.ga-select*` 统一（`bb6e16a`, `2d7a438`）**：
   - 为 `AntiModelSelector` 引入 `activeIndex`、`aria-activedescendant`、`tabIndex={-1}`、`scrollIntoView({ block: 'nearest' })`、700ms 前缀键入定位（键入期间暂缓 Space 提交以支持带空格模型名如 `"Claude Sonnet 5.5"`）、`Tab` 从触发器移交焦点至 `[data-anti-model-footer]`、`radiogroup` `ArrowLeft`/`ArrowRight` 游走选择，并在 `overlayStack.ts` 新增 `isInsideTrappedOverlay` 辅助判断，确保在 `ModalOverlay` 内打开时 `onBlur` 与循环 `Tab` 协同不抢焦。
   - Iter 2 (`2d7a438`) 进一步修复了 Iter 1 评审与对抗测试发现的 3 个真实边界 bug：从 `[data-anti-model-footer]` 按 `Shift+Tab` 返回触发器、在模态框内 `Shift+Tab` 越过触发器时正确回环至模态框末尾控件，以及方向键移动时清空键入缓冲避免下一字接力错误。
   - 将 `.ga-select` 迁入 `ga-actions.css` `@layer components`（新增 `.ga-select-sm`、`:focus-visible` 环、`:disabled`、`aria-[invalid="true"]` 与 `dark-forest` `<option>` 配色）并应用到 `ThemeTasks`、`MyKey`、`AntiOrchestratorModal` 的全部表单 `<select>`。
2. **行内无障碍校验与数值输入修复（`a16f259`, `3898197`）**：
   - 在 `ga-actions.css` 新增 `.ga-field-error`；重构 `TaskDialog`、`ScheduleDialog`、`ThemeTaskSettings`、`SessionDialog`、`UpdateSettingsPanel`、`GoalHive` 采用一致的 `errors` + `aria-invalid` + `aria-describedby` + `<p role="alert" className="ga-field-error">` + 自动聚焦首个错误字段 + 输入即清除对应错误。
   - `MyKey` `SessionDialog` 引入本地字符串 `budgetDraft` 彻底消灭 `32768` 回弹；Iter 2 (`3898197`) 补齐了切回 `thinking_type='enabled'` 时重新同步 `budgetDraft`、阻止小数（如 `1024.5`）通过 `Number.isInteger` 检查（同步修复 `Tasks`/`Autonomous` 周期分钟小数拦截），以及 `ThemeTasks` 纯空格搜索词处理。
3. **`StorageSettingsPanel` 草稿化提交、搜索清理与 `.ga-input*` 收口（`2d03eb6`, `1ae8172`）**：
   - 在 `ga-actions.css` 定义 `.ga-input`、`.ga-input-sm`、`.ga-textarea` 并替换全站 7+ 处重复局部常量。
   - 重构 `StorageSettingsPanel`：修复 `bg-surface` 为 `.ga-input-sm`（`bg-bg-card`）；改为本地字符串草稿 + `noValidate` 表单 + 整数边界校验（`1–365` / `0–720` / `1–365` / `7–3650`）+ 显式「保存策略」提交按钮；拆开双控件 `<label>`。
   - 为 `ThemeTasks`（关弹窗重置 `search`）、`ConversationTurnMinimap`（改用 `type="text"` + 显式清除钮）、`CommandPalette`（仅当 `q.length > 0` 时渲染清除钮以不破坏空态 `Shift+Tab` 聚焦链）统一搜索清理与回焦行为。

#### 2.4.3 关键决断与取舍（含未采纳方案与原因）

- **决断 1：表单内部原生 `<select>` 统一收敛到 `.ga-select` / `.ga-select-sm`，不强转为 `ThemedSelect`**  
  - *原因*：`ThemedSelect` 适用于顶栏带品牌图标的自定义组合框（渲染 `<button role="combobox">`），而 `Tasks`/`Autonomous`/`ThemeTasks`/`MyKey`/`AntiOrchestratorModal` 均属于表单弹窗内字段，保留原生 `<select>` 可兼容屏幕阅读器表单语义与现有测试（如 `ThemeTasks.test.tsx` `querySelectorAll('select')`、`AntiChat.test.tsx` `select[aria-label=...]`）。
- **决断 2：`StorageSettingsPanel` 采用显式「保存策略」提交按钮，而非静默防抖（debounce）`PATCH`**  
  - *原因*：每次修改 GC 保留策略后端都会重新执行全盘 `storageApi.summary()` 扫描；采用同 `Settings.tsx` `ChatRetryPanel` 一致的本地草稿 + 显式「保存策略」按钮，既彻底避免输入过程中触发昂贵磁盘扫描与输入框锁定，又支持多字段原子整数区间校验。
- **决断 3：`UpdateSettingsPanel` 保留无效 `sha256` 时按钮禁用态并叠加行内 `role="alert"` 说明**  
  - *原因*：`UpdateSettingsPanel.test.tsx` 显式断言输入 `'bad'` 时「校验并准备」按钮为 `disabled === true`；叠加行内 `role="alert"` 既保留既有防误触契约，又让用户立刻看懂禁用原因。

#### 2.4.4 问题清单、独立 Git Commit SHA 与涉及文件映射表

| Commit SHA | 类型 / 摘要 | 解决的核心问题 | 涉及文件（摘要） |
|---|---|---|---|
| `bb6e16a` | `feat(webui): add full keyboard navigation to AntiModelSelector and unify .ga-select styling` | `AntiModelSelector` 全键盘导航、700ms 键入（Space 缓冲）、`Tab` 进页脚与 `ArrowLeft`/`ArrowRight` 思考等级；`.ga-select`/`.ga-select-sm` 移入 `@layer components` 并统一 6 处原生 `<select>` | `AntiModelSelector.tsx`, `AntiModelSelector.test.tsx`, `AntiOrchestratorModal.tsx`, `MyKey.tsx`, `ThemeTasks.tsx`, `ga-actions.css`, `index.css`, `overlayStack.ts`（8 文件） |
| `a16f259` | `fix(webui): replace dialog.alert/silent-disabled validation with accessible inline field validation` | `Tasks`/`Autonomous` 移除校验型 `dialog.alert`；`ThemeTaskSettings` 取消静默禁用；`MyKey` 修复 `budgetDraft` 回弹与为空校验；`UpdateSettingsPanel`/`GoalHive` 加内联提示 | `UpdateSettingsPanel.tsx`, `UpdateSettingsPanel.test.tsx`, `Autonomous.tsx`, `Autonomous.test.tsx`, `GoalHive.tsx`, `GoalHive.test.tsx`, `MyKey.tsx`, `MyKey.test.tsx`, `Tasks.tsx`, `Tasks.test.tsx`, `ThemeTasks.tsx`, `ThemeTasks.test.tsx`, `ga-actions.css`（13 文件） |
| `2d03eb6` | `fix(webui): fix StorageSettingsPanel numeric editing & bg-surface, standardize search clear/reset & shared .ga-input tokens` | 修复 `StorageSettingsPanel` `bg-surface` 与逐键 `PATCH`；统一 `.ga-input*`/`.ga-textarea` 清理 7+ 套局部常量；统一 3 处搜索框清空/重置 | `AntiAgyProfiles.tsx`, `CommandPalette.tsx`, `CommandPalette.test.tsx`, `ConversationTurnMinimap.tsx`, `ConversationTurnMinimap.test.tsx`, `NovaSettingsPanel.tsx`, `StorageSettingsPanel.tsx`, `StorageSettingsPanel.test.tsx`, `UpdateSettingsPanel.tsx`, `Autonomous.tsx`, `MyKey.tsx`, `Settings.tsx`, `Tasks.tsx`, `ThemeTasks.tsx`, `ThemeTasks.test.tsx`, `ga-actions.css`（16 文件） |
| `2d7a438` | `fix(webui): fix AntiModelSelector Shift+Tab footer return, modal wrap & arrow typeahead reset` | （Iter 1 对抗/评审整改）修复 `AntiModelSelector` 页脚 `Shift+Tab` 回退触发器、模态框内回环、`Arrow` 键清理键入缓冲 | `AntiModelSelector.tsx`, `AntiModelSelector.test.tsx`, `OverlayStack.test.tsx`（3 文件） |
| `3898197` | `fix(webui): fix MyKey budgetDraft sync/integer check, Tasks/Autonomous int validation & ThemeTasks search trim` | （Iter 1 对抗/评审整改）修复 `MyKey` 切回 `enabled` 同步 `budgetDraft` 与整数校验、`Tasks`/`Autonomous` 小数周期拦截、`ThemeTasks` 空白搜索归一化 | `Autonomous.tsx`, `Autonomous.test.tsx`, `MyKey.tsx`, `MyKey.test.tsx`, `Tasks.tsx`, `Tasks.test.tsx`, `ThemeTasks.tsx`, `ThemeTasks.test.tsx`（8 文件） |
| `1ae8172` | `fix(webui): guard toastStore timer cleanup against jsdom teardown` | （Iter 1 评审附加清理）防护 `toastStore` 在 jsdom 环境卸载后 `window` 已销毁时的定时器清理异常 | `toastStore.ts`, `toastStore.test.ts`（2 文件） |

---

### 2.5 Theme 5：导航标签、跨引擎输入流、键盘无障碍与暗色主题一致性

#### 2.5.1 真实需求差与核心痛点

1. **SPA 路由切换丢草稿、URL 子状态失忆与 `ErrorBoundary` 强刷**：
   - `Memory`（`VersionedMemoryEditor`）和 `MyKey`（`RawView`）虽有浏览器 `beforeunload` 监听和内部 tab 切换弹窗，但 `MyKey` 的 `GlobalsSection` 连 `beforeunload` 都没有；更重要的是点击 `SidebarNav`、`CommandPalette`（`Ctrl+K`）、`Dashboard` 链接或桌面通知跳转时，React Router 直接卸载页面，未保存草稿瞬间静默丢失。
   - `Settings` 的 `activeTab` 仅存于 `useState`，刷新或外跳即重置回 `'general'`；`AntiChat` 读取 `?session=` 后立即用 `navigate(pathname, { replace: true })` 抹掉，与 `LiveChat` 保留 `?session=` 的行为割裂。
   - `ErrorBoundary` 只有「返回首页」并硬执行 `window.location.href = '/'`，不仅无法原地重试，还会销毁全部内存草稿（`useDraftStore`）与连接态。
2. **`role="tablist"` 键盘导航残缺**：
   - 全站 5 处（6 个实例）`role="tablist"` 中仅 `Settings` 与 `ThemeTaskHistory` 支持方向键与流动 `tabIndex`；`Memory`、`MyKey` 和 `Conductor`（移动端视图栏 + 右侧上下文栏）完全缺失键盘左右/Home/End 切换。
3. **跨引擎输入框（IME、回底、引用上限反馈）不对等**：
   - 主输入框 `ImagePasteInput` 具备完整的 `80ms` 中文输入法 `compositionend` 防误发送护栏，而同文件的 `BtwDialog`、`Conductor` (`TaskConversation`) 与 `GoalHive` 均缺少 `80ms` 护栏，拼音选词后紧跟 `Enter` 易误发半截句子。
   - `TaskConversation` 与 `GoalHive` 在流式输出期间用户上滑查看历史后，缺少悬浮「跳到底部/回到底部」控件。
   - `AntiChat` 后端契约限制单次最多引用 `8` 个中转箱文件（`references: max_length=8`），但前端仅静默 `disabled` 插入按钮，用户不知是达 8 个上限还是因任务运行中而被禁用；`LiveChat` 插入中转文件未检查 `MAX_ATTACHMENTS = 256` 上限。
4. **鼠标独占核心交互与 `dark-forest` 暗色主题残缺**：
   - `SessionRail` 会话重命名仅绑定在 `onDoubleClick`，键盘用户与触屏用户无法重命名。
   - `FileCitation`（`PathLink`）上下文菜单仅绑定 `onContextMenu`，无 `Shift+F10`/`ContextMenu` 快捷键、无 `role="menu"`/`menuitem`、无方向键/Esc 焦回，且窗口边界钳位硬编码 `440` / `260`。
   - `tailwind.config.js` 头部注释仍谎称「单亮色纸黄主题无暗色机制」；`SessionRail` 状态点、折叠把手（`SessionRail`/`ConversationIndexRail`/`CollapseToLatestButton`）、`AntiAgyProfiles`/`antiUsage` 等级徽章与框体、助理圆点（`bg-[#54735D]`）、停用态圆点（`bg-[#9A8E7D]`）、`TokenStats` 柱状图颜色及弹窗遮罩（`bg-[#241B12]/40`）仍硬编码亮色 hex，在 `dark-forest` 下对比度不足或色彩刺眼。

#### 2.5.2 交互逻辑、代码组织与统一解决方案

1. **SPA 脏路由守卫、URL 子状态与 `ErrorBoundary` 原地重试（`1720100`, `ed047d2`）**：
   - 新增 `webui/src/stores/navigationGuardStore.ts`（`useDirtyRouteGuard` / `hasDirtyGuard` / `confirmLeaveIfDirty`）集中管理 `beforeunload` 与 SPA 离开确认，并接入 `VersionedMemoryEditor`、`MyKeyRawView` 及之前漏守卫的 `MyKey` `GlobalsSection`。
   - 新增 `GuardedLink` / `GuardedNavLink` 与 `useGuardedNavigate` 覆盖 `SidebarNav`、`CommandPalette`（先关面板再弹确认避免双叠框）、`Dashboard`、`CitationLink`、`useDesktopNotifyEffects`、`Conversations`、`ThemeTasks`、`LiveChat`。
   - `Settings.tsx` 通过 `useInRouterContext()` 拆分路由感知包装层，支持 `?tab=` 双向同步且不破坏无 Router 的 `Settings.test.tsx`；`AntiChat.tsx` 保留并同步 `?session=` 参数（更新 `AntiChat.test.tsx` 契约）；`ErrorBoundary.tsx` 增加主按钮「重试」原地清除错误边界状态，次按钮「返回首页」优先走 SPA 路由跳转。
   - **Iter 2 深度修复（`ed047d2`）**：M5 对抗员发现当 `Memory` 或 `MyKey` 的脏标签切换触发 `dialog.confirm` 且用户选「取消」时，卸载中的确认弹窗 `ModalOverlay` 的 `useEffect` cleanup 会在弹窗退出后把焦点强行拉回关闭前保存的 `openerRef`，从而把刚被切回去或保持原位的 tablist 焦点抢走。通过在 `ModalOverlay` 与 `overlayStack` 中引入有条件恢复标记（仅当未被主动程序移交焦点且非取消切回场景时恢复），根治了焦点窃取。
2. **全站 `role="tablist"` 键盘无障碍收口（`97ac438`）**：
   - 新增 `webui/src/utils/tabListA11y.ts` 抽象 `handleTabListKeyDown`（支持水平/垂直方向键、`Home`/`End` 环绕与异步切换后聚焦回调），统一覆盖 `Memory`、`MyKey`、`Conductor`（两套 tablist）、`Settings` 与 `ThemeTaskHistory`。
3. **跨引擎输入护栏、回底控制与中转箱反馈（`19f6fcb`）**：
   - 抽取 `webui/src/hooks/useImeCompositionGuard.ts`（`80ms` post-`compositionend` + `composingRef` + `keyCode === 229`），接入 `ImagePasteInput`（主框与 `BtwDialog`）、`TaskConversation` 与 `GoalHive`（双 `<textarea>` 绑定 `Ctrl/Cmd+Enter` 提交）。
   - 为 `TaskConversation`（「跳到底部」，置于 `<form className="relative">` 内部以保持测试断言的兄弟 DOM 结构）和 `GoalHive`（「回到底部」）补齐流式回底悬浮钮。
   - 为 `toastStore`/`ToastHost` 增加 `toast.warning`；`FileTransferBox` 支持展示 `insertDisabledReason`（`role="status"` + 按钮 `title`），在 `AntiChat` 明示 8 引用上限与运行锁原因，在 `LiveChat` 守卫 256 附件上限。
4. **`SessionRail` 键盘改名、`FileCitation` 菜单键盘化与 `dark-forest` Token 补齐（`fbaedc4`, `61865a5`, `2c4905b`）**：
   - `SessionRail` 在现有 `actionGroup` 内增设 `Pencil` 重命名按钮与 `F2` 快捷键，并用 `rowButtonRefs` 在 `Enter`/`Escape` 结束编辑后准确回焦行按钮而不干扰鼠标失焦提交。
   - `FileCitation`（`PathLink`）支持 `Shift+F10` / `ContextMenu` 键盘唤起、注册入 `overlayStack`、`role="menu"`/`menuitem`、方向键/Home/End 导航及 `useLayoutEffect` 动态视口钳位；Iter 2 (`61865a5`) 修复了打开前未清空旧 `info` 导致短暂闪现前次路径详情，以及将键盘焦点错误锁在 `disabled` 菜单项上的缺陷。
   - 完成 `dark-forest` 全域变量适配：`--c-modal-backdrop`、`--c-rail-dot-*`、`--c-chart-*`、`.ga-rail-dot--*`、`.ga-tier-badge--*`/`.ga-tier-frame--*`、`.ga-floating-handle`、`bg-accent` 助理圆点、`bg-ink-faint/75` 未知态圆点，并清理 `tailwind.config.js` 过时注释；Iter 2 (`2c4905b`) 同时修复了 `extractErrorMessage` 对多层嵌套空信封（`{ detail: { detail: {} } }`）漏出 JSON 的边界。

#### 2.5.3 关键决断与取舍（含未采纳方案与原因）

- **决断 1：在 `<BrowserRouter>` 上以 `navigationGuardStore` + `GuardedLink`/`useGuardedNavigate` 实现脏路由守卫，而非迁移至 `createBrowserRouter`**  
  - *原因*：`main.tsx` 使用 `<BrowserRouter>`，全仓大量测试依赖 `<MemoryRouter>` 或干脆不包任何 Router（`Settings.test.tsx`、`Conductor.test.tsx`、`GoalHive.test.tsx`）；强行切换 Data Router 以换取 `useBlocker` 会触发大面积测试架构破坏，且 `navigationGuardStore` 零 Router 耦合即可拦截全部应用内跳转与 `beforeunload`。该取舍的唯一边界（浏览器原生前进/后退 `popstate`）已明确记录于第 5 节待次日确认。
- **决断 2：`GoalHive` 采用 `Ctrl/Cmd+Enter` 提交，而不采用单键 `Enter` 提交**  
  - *原因*：`GoalHive` 表单内同时包含「目标」与「补充约束（可选）」两个多行 `<textarea>`，需要顺畅换行；绑定 `Ctrl/Cmd+Enter`（配合 `80ms` IME 守卫）在两个输入域均行为一致且避免误提交。
- **决断 3：维持 `AntiChat` 中转箱 8 引用后端硬上限，前端改为显式原因提示而非强行放开至 256**  
  - *原因*：经核查后端 `server/routes/anti.py` 与 `server/services/anti_references.py`，`references` 明确校验 `max_length=8`（与 `attachments` `256` 区分），放开前端只会导致 422 校验报错，因此补充 `insertDisabledReason` 消除「莫名变灰」的困惑。

#### 2.5.4 问题清单、独立 Git Commit SHA 与涉及文件映射表

| Commit SHA | 类型 / 摘要 | 解决的核心问题 | 涉及文件（摘要） |
|---|---|---|---|
| `1720100` | `feat(webui): add SPA dirty-route guard, persist Settings ?tab= & AntiChat ?session=, and add ErrorBoundary in-place retry` | 新增 `navigationGuardStore` / `GuardedLink` / `useGuardedNavigate` 守卫全部 SPA 跳转与 `GlobalsSection`；`Settings` `?tab=` 与 `AntiChat` `?session=` 持久化；`ErrorBoundary` 原地重试 | `App.tsx`, `CommandPalette.tsx`, `CommandPalette.test.tsx`, `ErrorBoundary.tsx`, `ErrorBoundary.test.tsx`, `FileCitation.tsx`, `GuardedLink.tsx`, `MyKeyRawView.tsx`, `SidebarNav.tsx`, `VersionedMemoryEditor.tsx`, `useDesktopNotifyEffects.ts`, `useGuardedNavigate.ts`, `AntiChat.tsx`, `AntiChat.test.tsx`, `Conversations.tsx`, `Dashboard.tsx`, `LiveChat.tsx`, `Memory.dirty.test.tsx`, `MyKey.tsx`, `Settings.tsx`, `Settings.test.tsx`, `ThemeTasks.tsx`, `navigationGuardStore.ts`, `navigationGuardStore.test.ts`（24 文件） |
| `97ac438` | `feat(webui): add arrow-key and roving tabIndex keyboard navigation to Memory, MyKey, and Conductor tablists` | 新增 `tabListA11y.ts` 并统一全站全部 6 处 `role="tablist"` 键盘方向键与流动 `tabIndex`（兼容异步脏切换） | `ThemeTaskHistory.tsx`, `Conductor.tsx`, `Conductor.test.tsx`, `Memory.tsx`, `Memory.dirty.test.tsx`, `Memory.navigation.test.tsx`, `MyKey.tsx`, `MyKey.test.tsx`, `Settings.tsx`, `tabListA11y.ts`（10 文件） |
| `19f6fcb` | `feat(webui): unify 80ms composer IME guard, add TaskConversation/GoalHive jump-to-bottom, and surface transfer cap feedback` | 新增 `useImeCompositionGuard` 统一主框/`BtwDialog`/`TaskConversation`/`GoalHive`；`TaskConversation`/`GoalHive` 加回底浮钮；新增 `toast.warning` 与中转箱禁用原因提示 | `FileTransferBox.tsx`, `FileTransferBox.test.tsx`, `ImagePasteInput.tsx`, `ImagePasteInput.test.tsx`, `ToastHost.tsx`, `TaskConversation.tsx`, `useImeCompositionGuard.ts`, `AntiChat.tsx`, `Conductor.test.tsx`, `GoalHive.tsx`, `GoalHive.test.tsx`, `LiveChat.tsx`, `toastStore.ts`（13 文件） |
| `fbaedc4` | `feat(webui): add keyboard rename in SessionRail, accessible PathLink menu in FileCitation, and dark-forest token parity` | `SessionRail` 按钮+`F2` 改名与焦点回落；`FileCitation` 键盘右键菜单与动态视口钳位；`dark-forest` 全套颜色/圆点/图表/遮罩 Token 对齐 | `CommandPalette.tsx`, `ConversationIndexRail.tsx`, `FileCitation.tsx`, `MarkdownView.test.tsx`, `MessageBubble.tsx`, `ModalOverlay.tsx`, `SessionRail.tsx`, `SessionRail.test.tsx`, `ActivityTimeline.tsx`, `presentation.ts`, `AntiChat.tsx`, `Conversations.tsx`, `TokenStats.tsx`, `ga-actions.css`, `index.css`, `token-stats.css`, `antiUsage.ts`, `antiUsage.test.ts`, `tailwind.config.js`（19 文件） |
| `86d167f` | `fix(webui): polish extractErrorMessage empty-envelope fallback and MyKey thinking_type revert dirtiness` | （M3/M4 遗留微瑕收尾）修复 `extractErrorMessage` 空信封与 `MyKey` `thinking_type` 来回切换脏态误报 | `MyKey.tsx`, `MyKey.test.tsx`, `errors.ts`, `errors.test.ts`（4 文件） |
| `ed047d2` | `fix(webui): prevent ModalOverlay unmount cleanup from stealing focus after dirty tablist confirm` | （Iter 1 对抗整改）修复 `Memory`/`MyKey` 脏标签确认弹窗取消后卸载 `ModalOverlay` 窃取 tablist 焦点 | `ModalOverlay.tsx`, `ModalOverlay.test.tsx`, `Memory.dirty.test.tsx`, `MyKey.test.tsx`, `overlayStack.ts`（5 文件） |
| `61865a5` | `fix(webui): clear stale PathLink menu info and avoid trapping focus on disabled menuitem` | （Iter 1 对抗整改）修复 `FileCitation` `PathLink` 打开菜单闪现旧 `info` 及向 `disabled` 项移交焦点 | `FileCitation.tsx`, `MarkdownView.test.tsx`（2 文件） |
| `2c4905b` | `fix(webui): prevent nested empty error envelopes from leaking JSON in extractErrorMessage` | （Iter 1 对抗整改）修复多层嵌套空信封（如 `{ detail: { detail: {} } }`）在 `extractErrorMessage` 中漏出原始 JSON | `errors.ts`, `errors.test.ts`（2 文件） |

---

## 3. 全部 Git Commit 总索引（按时间顺序，支持逐项 `git revert`）

> 以下列出基线 `602fd7b` 之后、当前 `HEAD` (`2c4905b`) 前的全部 **33 个提交**（精确对应 `git log --reverse 602fd7b..2c4905b`）。  
> **回退提示**：每个提交均按单一问题边界独立提交；若需回退某一底层原语早期提交（如 `502d31b`、`e4502e9`、`7ac9252`、`d76392e`、`bb6e16a`、`1720100`），请注意按主题内从新到旧的逆序执行 `git revert <sha>` 以避免引入对后置整改提交的上下文冲突；后置修复提交均可直接独立 `git revert`。

| # | Commit SHA | 所属阶段 / 性质 | 提交时间 (+0800) | 提交标题 | 变更规模 |
|---|---|---|---|---|---|
| 1 | `502d31b` | Theme 1（M1） | 02:06:46 | `fix(webui): add explicit button types and fix focus-visible rings` | 17 files (+44/-33) |
| 2 | `e4502e9` | Theme 1（M1） | 02:09:43 | `style(webui): standardize ga-actions button sizes, disabled states, semantic variants, and Button primitive` | 4 files (+257/-24) |
| 3 | `a911669` | Theme 1（M1） | 02:18:34 | `refactor(webui): converge module-local button dialects onto ga-actions` | 14 files (+40/-91) |
| 4 | `f76870e` | **[外部协作者并行提交]** | 02:19:50 | `ui(anti): convert account management and runtime diagnostics into top-down dropdowns` | 4 files (+700/-563) |
| 5 | `3b8ac2a` | Theme 1（M1） | 02:21:12 | `fix(webui): guard async button actions against double-clicks and misleading disabled cues` | 8 files (+396/-72) |
| 6 | `1447241` | Theme 1（M1） | 02:23:13 | `ui(webui): unify close buttons, header control heights, revoke hit-target, and dark-forest button contrast` | 9 files (+71/-49) |
| 7 | `2be82aa` | Theme 1（M1-r2） | 02:34:44 | `fix(webui): add synchronous useRef locks and loading labels to async actions` | 6 files (+335/-32) |
| 8 | `ef274c1` | Theme 1（M1-r2） | 02:37:41 | `refactor(webui): clean up residual f76870e button dialects, CloseIconButton radius, and disabled styles` | 9 files (+97/-23) |
| 9 | `7ac9252` | Theme 2（M2） | 02:51:45 | `fix(webui): unify overlay stack registration, z-layers, Escape arbitration, and BtwDialog drag bounds` | 21 files (+573/-107) |
| 10 | `a98cd58` | Theme 2（M2） | 02:59:35 | `fix(webui): guard dirty edit modals on close, enforce closeOnBackdrop=false, and fix AntiAgyProfiles render-phase state sync` | 19 files (+747/-76) |
| 11 | `f54cbdf` | Theme 2（M2） | 03:05:09 | `fix(webui): add missing confirmations for destructive actions and unify confirmation boundaries` | 10 files (+290/-81) |
| 12 | `0ad9ff3` | Theme 2（M2-r2） | 03:18:28 | `fix(webui): fix nested overlay Tab trap, gate focus preservation, and BtwDialog resize clamp` | 5 files (+326/-23) |
| 13 | `f7e3cea` | Theme 2（M2-r2） | 03:19:09 | `fix(webui): normalize empty apikey in MyKey dirty check and align AntiAgyProfiles close disabled state` | 3 files (+34/-1) |
| 14 | `d76392e` | Theme 3（M3） | 03:28:00 | `feat(webui): harden ToastHost/toastStore a11y & extract shared error formatter / QueryLoadState modes` | 10 files (+557/-48) |
| 15 | `eea4164` | Theme 3（M3） | 03:34:39 | `fix(webui): eliminate swallowed errors, raw HttpError JSON leaks & hidden modal errors` | 12 files (+672/-68) |
| 16 | `e987379` | Theme 3（M3） | 03:40:45 | `refactor(webui): unify feedback routing across LiveChat, Tasks, Autonomous, Settings, Conductor & GoalHive` | 18 files (+410/-147) |
| 17 | `fb7dc49` | Theme 3（M3） | 03:42:33 | `fix(webui): standardize QueryLoadState adoption, retry controls & error/empty state exclusivity` | 10 files (+197/-211) |
| 18 | `d453bad` | Theme 3（M3-r2） | 03:57:09 | `test(webui): restore FontAppearancePanel M1/M2 async lock and confirm regression tests` | 1 file (+188/-19) |
| 19 | `5c11e18` | Theme 3（M3-r2） | 03:59:05 | `fix(webui): harden ToastHost pause state, error extraction, profile view error reset, and Nova status vs action errors` | 10 files (+307/-39) |
| 20 | `bb6e16a` | Theme 4（M4） | 04:12:15 | `feat(webui): add full keyboard navigation to AntiModelSelector and unify .ga-select styling` | 8 files (+374/-53) |
| 21 | `a16f259` | Theme 4（M4） | 04:14:40 | `fix(webui): replace dialog.alert/silent-disabled validation with accessible inline field validation` | 13 files (+510/-57) |
| 22 | `2d03eb6` | Theme 4（M4） | 04:18:28 | `fix(webui): fix StorageSettingsPanel numeric editing & bg-surface, standardize search clear/reset & shared .ga-input tokens` | 16 files (+588/-149) |
| 23 | `2d7a438` | Theme 4（M4-r2） | 04:31:04 | `fix(webui): fix AntiModelSelector Shift+Tab footer return, modal wrap & arrow typeahead reset` | 3 files (+122/-3) |
| 24 | `3898197` | Theme 4（M4-r2） | 04:33:09 | `fix(webui): fix MyKey budgetDraft sync/integer check, Tasks/Autonomous int validation & ThemeTasks search trim` | 8 files (+198/-18) |
| 25 | `1ae8172` | Theme 4（M4-r2） | 04:33:42 | `fix(webui): guard toastStore timer cleanup against jsdom teardown` | 2 files (+21/-3) |
| 26 | `1720100` | Theme 5（M5） | 04:45:26 | `feat(webui): add SPA dirty-route guard, persist Settings ?tab= & AntiChat ?session=, and add ErrorBoundary in-place retry` | 24 files (+604/-69) |
| 27 | `97ac438` | Theme 5（M5） | 04:46:56 | `feat(webui): add arrow-key and roving tabIndex keyboard navigation to Memory, MyKey, and Conductor tablists` | 10 files (+276/-27) |
| 28 | `19f6fcb` | Theme 5（M5） | 04:50:54 | `feat(webui): unify 80ms composer IME guard, add TaskConversation/GoalHive jump-to-bottom, and surface transfer cap feedback` | 13 files (+377/-57) |
| 29 | `fbaedc4` | Theme 5（M5） | 04:55:02 | `feat(webui): add keyboard rename in SessionRail, accessible PathLink menu in FileCitation, and dark-forest token parity` | 19 files (+435/-62) |
| 30 | `86d167f` | Theme 5（M5） | 04:56:53 | `fix(webui): polish extractErrorMessage empty-envelope fallback and MyKey thinking_type revert dirtiness` | 4 files (+92/-34) |
| 31 | `ed047d2` | Theme 5（M5-r2） | 05:10:46 | `fix(webui): prevent ModalOverlay unmount cleanup from stealing focus after dirty tablist confirm` | 5 files (+150/-3) |
| 32 | `61865a5` | Theme 5（M5-r2） | 05:11:27 | `fix(webui): clear stale PathLink menu info and avoid trapping focus on disabled menuitem` | 2 files (+82/-2) |
| 33 | `2c4905b` | Theme 5（M5-r2） | 05:12:05 | `fix(webui): prevent nested empty error envelopes from leaking JSON in extractErrorMessage` | 2 files (+10/-2) |

---

## 4. 自动化测试、独立评审与对抗验证总表

### 4.1 最终 `HEAD` (`2c4905b`) 全量自动化实测结果

以下所有命令均在提交 `2c4905b` 之后于 `D:\study\GA-Hub` 直接运行并记录原始输出：

| 验证命令 | 退出码 | 实测结果（逐字指标） | 说明 |
|---|---|---|---|
| `npm --prefix webui run lint` | `0` | `tsc -b --noEmit` 零错误 | 类型检查全绿 |
| `npm --prefix webui test -- --run` | `0` | `Test Files  144 passed (144)`，`Tests  1341 passed (1341)`，`Duration  17.89s` | 全量前端单测与集成测试全绿 |
| `npm --prefix webui run api:check` | `0` | `API contract check passed: 113 frontend HTTP call shapes match 206 OpenAPI operations.` | 前后端接口契约一致 |
| `python -m pytest tests/test_repo_hygiene.py -q` | `0` | `3 passed in 0.11s` | 仓库根目录零散件、白名单合规 |
| TypeScript AST `<button type=` 扫描（`webui/src/**/*.tsx` 排除 `*.test.*` / `*.spec.*`） | `0` | `files: 88`, `total: 377`, `missing: 0`, `spread: 3` | 377 个生产 `<button>` 全部显式包含 `type=`（3 个展开属性元素均额外显式声明 `type=`） |
| `python -m pytest tests -q`（默认 `runtime-tmp` 路径） | `1` | `2 failed, 1491 passed, 84 skipped, 40 warnings, 74 subtests passed in 73.66s` | 2 项失败与本次前端改动无关，见下方诊断复测 |
| ↳ 单项复跑 `tests/test_anti.py::test_session_queued_prompts_auto_dispatch_reorder_steer_pause_and_cleanup` | `0` | `1 passed in 3.86s` | 独立运行通过；全量并发高负载下 `DELETE /api/anti/sessions/{sid}` 偶现 409 后台调度竞争（既有时序波动） |
| ↳ 短路径复跑 `tests/test_anti_daemon.py::test_workspace_lossless_migration_and_conversation_rescue --basetemp=D:\study\GA-Hub\temp\pt` | `0` | `1 passed in 0.59s`（事后已清空临时目录） | 默认 `runtime-tmp` 深路径下 `sqlite3.OperationalError: unable to open database file`（第 2499 行）；缩短 `--basetemp` 后通过，确认为既有 Windows `MAX_PATH` 限制 |

### 4.2 M1–M5 独立评审、对抗验证与取证审计闭环汇总

本次任务未把初稿提交直接视作完成，而是对每个主题运行「Reviewer + Adversarial Challenger + Forensic Auditor」三路独立验证；**全部 5 个里程碑均在首轮拦截了真实缺陷并在二轮修补验证后通过门禁**：

| 里程碑 | 首轮门禁结果 | 首轮独立验证捕获的真实缺陷与异常 | 二轮整改提交与最终门禁 |
|---|---|---|---|
| **M1 (Theme 1)** | **FAIL** | Reviewer 指出 `Tasks.tsx` `TaskCard` 仅状态锁及 `f76870e` 残留；Challenger 实测复现 `FontAppearancePanel` 全部 4 个操作及 `MyKey` `runTest`/`SessionDialog.save`/`toggleAutoSync` 同 tick 连击双发请求（各发出 2 次 API 调用）。 | `2be82aa`、`ef274c1`；二轮 Reviewer `APPROVE` + Challenger `CONFIRMED` + Auditor `CLEAN` → **PASS** |
| **M2 (Theme 2)** | **FAIL** | Challenger 探针实测复现 4 个真实 Bug：(1) `ModalOverlay` 内打开传送门 `AntiModelSelector` 时 `Tab` 穿透至背景页；(2) `DesktopRuntimeGate` (`lost`) 激活状态下卸载底层 `ModalOverlay` 时焦点被偷走；(3) `BtwDialog` 拖拽后缩小窗口会停留在视口之外；(4) `MyKey` 复制模式输入并清空 `apikey` 误触发脏保存提示。 | `0ad9ff3`、`f7e3cea`；二轮 Reviewer `APPROVE` + Challenger `CONFIRMED 13/13` + Auditor `CLEAN` → **PASS** |
| **M3 (Theme 3)** | **FAIL（INTEGRITY VIOLATION）** | Auditor (`efa58d8b`) 否决 `fb7dc49` 覆写 `FontAppearancePanel.test.tsx` 删掉了 2 条 M1/M2 回归测试；同时 Challenger 实测复现 `ToastHost` hover+focus 抢占、422/null/`{}` 错误解包漏洞、`AntiAgyProfiles` 切视图残错与 `NovaSettingsPanel` 状态/操作错混淆；Reviewer 指出 `chatStore.historyError` 未清洗。 | `d453bad`、`5c11e18`；二轮 Reviewer `APPROVE` + Challenger `CONFIRMED 14/14` + Auditor `CLEAN` → **PASS** |
| **M4 (Theme 4)** | **FAIL** | Reviewer 指出 `AntiModelSelector` `Shift+Tab` 顺序与 `MyKey` 切回 `enabled` 时 `budgetDraft` 同步问题；Challenger 实测复现 7 项边界缺陷（`AntiModelSelector` 模态回环与方向键未清键入缓冲、`MyKey` 与 `Tasks`/`Autonomous` 小数通过整数校验、`ThemeTasks` 纯空格搜索词），另指出 `toastStore` 卸载边界。 | `2d7a438`、`3898197`、`1ae8172`；二轮 Reviewer `APPROVE` + Challenger `CONFIRMED 14/14` + Auditor `CLEAN` → **PASS** |
| **M5 (Theme 5)** | **FAIL** | Challenger 25 项探针复现 3 个真实 Bug：(1) `Memory`/`MyKey` 脏标签切换取消后，卸载的 `ModalOverlay` 会从 `tablist` 偷走焦点；(2) `FileCitation` `PathLink` 重开菜单时闪现上次路径详情，且方向键可跳上禁用菜单项或锁死；(3) `extractErrorMessage` 对多层嵌套空信封（如 `{ detail: { detail: {} } }`）仍泄漏 JSON。 | `ed047d2`、`61865a5`、`2c4905b`；二轮 Reviewer `APPROVE` + Challenger `CONFIRMED 14/14` + Auditor `CLEAN` → **PASS** |

---

## 5. 待次日人工确认与最后收尾事项（Actionable Checklist）

全部自动化门禁已通过，但以下 **7 项** 属于运行期实机视觉体验、范围边界决策或架构取舍，建议次日人工审阅并决定是否需要微调收尾：

- [ ] **1. Live Tauri WebView2 实机视觉抽检（`dark-forest` 为主）**
  - 本轮验证运行于 Vitest JSDOM 与 TypeScript/Tailwind 编译检查，未启动实际桌面窗口截图比对。建议次日在运行态桌面窗口切换至 `dark-forest`（`/settings?tab=display`）逐一抽检：
    1. 原生 `<select>` 弹出菜单 `<option>` 背景/字色在 Windows WebView2 下的渲染可读性（`Tasks`、`Autonomous`、`ThemeTasks`、`MyKey`、`Conductor`、`AntiOrchestratorModal`）；
    2. `AntiAgyProfiles` 与账号胶囊上的等级徽章/边框/图标（`.ga-tier-badge--*`、`.ga-tier-frame--*`、`.ga-account-tier-icon--*`）；
    3. `SessionRail` 折叠把手（`.ga-floating-handle`）与会话运行/完成/空闲/报错状态点（`--c-rail-dot-*`）；
    4. `BtwDialog` 在小窗口拖拽并实时缩放主窗口时的 8px 边距钳位表现；
    5. `TaskConversation`（「跳到底部」）与 `GoalHive`（「回到底部」）悬浮按钮在流式滚动时的遮挡与点击手感。

- [ ] **2. `assets/remote_access/remote.html` 移动端页面是否纳入补齐**
  - 范围界定：`assets/remote_access/` 属于独立移动端远程访问静态页，不在 `webui/` 工程范围内，本轮未做修改。
  - 已知客观现状：`assets/remote_access/remote.html` 中共有 **7 个 `<button>`** 缺少 `type="button"`（第 8 行 3 个筛选按钮 `all`/`running`/`starred`，第 12 行 `#sidebarBackdrop`，第 14 行 `#openSidebar`，第 16 行 `#toolsBackdrop`，第 19 行 `#older`）。若次日计划一并整治移动端 HTML 规范，可直接补齐 `type="button"`。

- [ ] **3. `<BrowserRouter>` + `navigationGuardStore` 与浏览器原生 `popstate` 的未来演进取舍**
  - 当前取舍：为了不破坏大量 `<MemoryRouter>` 与无 Router 单测，本轮保留 `<BrowserRouter>` 并以 `navigationGuardStore` 守卫全部应用内 SPA 跳转，以 `beforeunload` 守卫关闭/刷新。
  - 待确认点：在此架构下，用户若在桌面壳/浏览器内**直接点击浏览器原生后退/前进按钮（`popstate`）**离开 `Memory`/`MyKey` 脏编辑页，无法在跳转前同步弹出 `dialog.confirm`。若未来确认需要拦截 `popstate`，需规划将 `main.tsx` 迁移至 React Router Data Router（`createBrowserRouter` + `useBlocker`）并同步改造现有无 Router 测试夹具。

- [ ] **4. `GoalHive` 双 `<textarea>` 提交快捷键交互偏好确认**
  - 当前实现：`GoalHive` 表单存在「目标」与「补充约束（可选）」两个 `<textarea>`，本轮均绑定为 **`Ctrl/Cmd + Enter`** 提交（附带 80ms IME 护栏），以保留两处换行输入能力。请次日确认是否符合预期，或是否希望将主「目标」框改为单键 `Enter` 发送、`Shift+Enter` 换行。

- [ ] **5. `AntiChat` `?session=` 与 `Settings` `?tab=` URL 持久化产品预期确认**
  - `Settings` 现已持久化 `?tab=<id>`，`AntiChat` 现已保留并双向同步 `?session=<id>`（与 `LiveChat` 一致，刷新/深链可直达当前会话与设置分页）。请确认这符合桌面壳与网页端预期，无需保留之前 `AntiChat` 自动剥离 `?session=` 的旧行为。

- [ ] **6. 既有后端 `pytest` 两项环境/时序现象说明（无需本轮修改 Python）**
  - `tests/test_anti_daemon.py::test_workspace_lossless_migration_and_conversation_rescue` 在工作区默认的深层 `runtime-tmp` 路径下触发 Windows `MAX_PATH` 导致 `sqlite3.OperationalError: unable to open database file`（第 2499 行）；使用短 `--basetemp` 实测 `0.59s` 通过。
  - `tests/test_anti.py::test_session_queued_prompts_auto_dispatch_reorder_steer_pause_and_cleanup` 在全量并发测试高压下偶发第 1254 行 `409 == 204` 时序竞争，单独运行 `3.86s` 通过。如需消除 CI 噪音，可后续在单独的后端工单中缩短嵌套临时路径或加宽测试等待栅栏。

- [ ] **7. 极低风险遗留微瑕与并行合并复核**
  - **M5 评审记录的 3 项非阻塞微瑕**（仅在极端并发或边缘路径存在）：
    1. `Settings.tsx` `SettingsWithRouter` 的 `useEffect` 依赖 `[initialMode, urlTab, activeTab]`：目前 React 18 同步批处理下全绿，未来若引入异步并发 Transition 可能出现一次短暂回弹，且导航回无参 `/settings` 时保留上次 tab 而非重置为 `'general'`；
    2. `AntiChat.tsx` `remove.onSuccess` 中 `if (sid === id)` 读取闭包 `sid`：仅当用户在删除请求在途时立即切换另一会话才可能误清；
    3. `FileCitation.tsx` `PathLink` 菜单内按 `Tab` 会关闭菜单但未显式先回焦 `triggerRef.current`；
    4. *(M4 评审记录)* `MyKey.tsx` `SessionDialog` 从 `adaptive -> enabled -> adaptive` 切换时，`enabled` 态会视觉预填 `32768`（切回 `adaptive` 已确保不误报脏态）。
  - **外部协作者提交 `f76870e`**：已确认其在 M1 期间合入且与本次全部 32 个 UI 修复提交和谐共存；M1 的 `ef274c1`、M2 的 `7ac9252`/`a98cd58`/`f54cbdf`、M3 的 `eea4164`/`5c11e18` 均已将 `f76870e` 新增的顶栏下拉态 `AntiAgyProfiles` 与 `AntiDaemonControl` 纳入一致规范。
