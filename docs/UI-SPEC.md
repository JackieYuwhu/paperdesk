# PaperDesk UI 规范（UI-SPEC）

> 2026-11-13 用户已审核授权工作区重设计。本轮以 README「工作区 UI 与启动优化」及 CODE-MAP 同日章节为新布局基线；下述 PD45–PD47「只改样式、令牌值冻结」仅适用于历史任务，不限制本轮导航/懒加载/启动维护改造。已有语义色、PDF批注颜色、IPC与数据服务继续兼容。


> 适用基线：`f2c8b5e4d9742af3077dd621a2d93b50a6a791cc`（PD01–PD44 已合入）
> 适用任务：PD45（产出本文档）、PD46 / PD47（按本文档改样式）
> 状态：已冻结，PD46/PD47 以本文档为准。实现与本文档冲突时，先改文档再改代码，不允许“代码即规范”。
> 边界：PD45 只新增本文档。`src/renderer/src/styles.css` 仅用于只读核对，未修改；未改任何 `.ts` / `.tsx`。
> PD46 更新：已按本文档在 `styles.css` 落地 `:root` 与暗色块令牌、改基础控件样式并删除第二处 `button {}`；只改了 `styles.css` 与本文档（见 §1.8–§1.10），行号以基线 `f2c8b5e` 为准，PD46 后整体下移约 122 行。

---

## 0. 目的与硬约束

PaperDesk 的样式集中在 6130 行的 `src/renderer/src/styles.css`。当前 `:root`（styles.css:4-52）只有颜色、阴影、圆角与两栏宽度，**没有间距、字号、行高、控件高度令牌**；`html[data-theme='dark']`（styles.css:54-87）只覆盖颜色与阴影。结果是：同一类按钮高度与内边距在各面板各不相同（例如 `button` 基础 5px 10px、`.seg button` 3px 10px、`.entries button` 1px 8px、`.lookup__actions button` 3px 8px），空态/加载态/错误态至少有四套并行写法，暗色下还有三处硬编码颜色未跟随主题。

本文档给出**增量令牌**、**五态统一写法**、**表格/图表/代码块约束**、**暗色一致性规则**与**差距清单**，供 PD46（令牌落地）与 PD47（组件收敛）执行。

硬约束（违反即打回）：

1. **只改样式与类名**：不改业务逻辑，不改 `data-testid`，不放宽任何 e2e 断言，不改 IPC / 数据库 / 状态管理。
2. **令牌只加不改**：`--r-sm/--r-md/--r-lg/--r-xl`、`--shadow-sm/md/lg`、全部颜色语义变量保持现有值，避免全局视觉回归；新增令牌追加在既有令牌之后。
3. **暗色成对**：每个新令牌都必须在 `html[data-theme='dark']` 中再声明一次（含尺寸类令牌，按 §4.1 字面要求）。
4. **样式唯一来源**：静态样式只能写在 `styles.css`；组件内联样式仅允许数据驱动的动态值（`left/top/width/transform/background` 等），不允许内联间距、字号、圆角、边框。
5. **不引入新依赖**：不引入 UI 框架、图标库、CSS-in-JS、Tailwind；图标继续走现有 `Icon` 组件。
6. **语义顺序**：每个区域先有“空态/加载态/错误态”，再有内容；不允许“空白区域无任何说明”。

---

## 1. 设计令牌

命名沿用现有风格（`--kebab-case`）。分三类：**结构令牌**（间距/字号/行高/高度/圆角/阴影）、**颜色令牌**（语义色，禁止直接写 hex）、**语义别名**（给具体构件用的具名尺寸）。

### 1.1 间距刻度 `--space-*`

刻度只有 6 档：4 / 8 / 12 / 16 / 24 / 32。任何 `padding`、`margin`、`gap`、`top/left` 偏移都必须落在这 6 档上（0 与 1px 边框除外）。

| 令牌 | 值 | 典型用途 | 与现状的映射 |
| --- | --- | --- | --- |
| `--space-1` | 4px | 图标与文字间隙、chip 内水平、紧凑行间距 | 现状 3/4/5px（如 styles.css:734 `margin-top:3px`、styles.css:1449 `padding:1px 5px`） |
| `--space-2` | 8px | 控件间距、卡片内边距、面板 gap | 现状 6/7/8/9/10px 混合（styles.css:2088、1425、1099） |
| `--space-3` | 12px | 区块内边距、列表行左右、控件水平内边距 | 现状 10/12px（styles.css:155、2088） |
| `--space-4` | 16px | 面板内边距、区块间距、工具栏左右 | 现状 14px（styles.css:1093） |
| `--space-5` | 24px | 空态上下留白、对话框分区 | 现状 22/24/26px（styles.css:944、5687） |
| `--space-6` | 32px | 大空态、页面级留白 | 现状 34px（styles.css:5978） |

迁移规则：`10px → var(--space-3)`（向上取整到 12），`14px → var(--space-4)`，`6px → var(--space-2)`，`9px → var(--space-2)`，`5px → var(--space-1)`。取整方向统一为“就近上取”，避免整体变挤。

### 1.2 字号与行高 `--text-*` / `--lh-*`

只允许 5 档字号。**每个字号必须成对使用对应的行高令牌**，不允许 `font-size` 配 `line-height: 1.55` 这类相对值。

| 字号令牌 | 值 | 行高令牌 | 值 | 用途 | 与现状的映射 |
| --- | --- | --- | --- | --- | --- |
| `--text-xs` | 12px | `--lh-xs` | 18px | 元信息、说明文字、表格表头、轴标签 | styles.css:743/1124/5689 的 12px |
| `--text-sm` | 13px | `--lh-sm` | 20px | 正文默认、列表标题、按钮文字 | `body` 现为 13.5px/1.55（styles.css:103-110） |
| `--text-md` | 14px | `--lh-md` | 22px | 面板标题、对话框标题、空态标题 | `.errbox__title` 14px（styles.css:1517）、`.stage__title` 14px（styles.css:5020） |
| `--text-lg` | 16px | `--lh-lg` | 24px | 一级标题、知识库条目标题 | 现状 15/16px 混用 |
| `--text-xl` | 20px | `--lh-xl` | 28px | 页面级标题（仅对话框/详情页） | 现状未使用，预留 |

**`body` 收敛决定**：`13.5px / 1.55`（≈20.9px 行高）改为 `--text-sm` / `--lh-sm`（13px / 20px）。理由：13.5 不在刻度内，13px 与 13.5px 的密度差小于 4%，行高 20px 与现 20.9px 差 4%，不会造成版面重排；若 PD46 视觉对比发现过密，整体改到 14px/22px，**但必须整站一致**，不允许局部 13.5。

禁止值：10px、10.5px、11px、11.5px、12.5px、13.5px、15px（现状大量存在，见差距清单）。

### 1.3 控件高度 `--control-h-*`

控件高度必须显式声明（`height` 或 `min-height`），不允许只靠 padding 拼出高度。

| 令牌 | 值 | 用途 | 与现状的映射 |
| --- | --- | --- | --- |
| `--control-h-sm` | 28px | 图标按钮、分段控件、侧栏分组触发器、紧凑行内按钮 | `button.icon` 现为 28×28（styles.css:197-201）；`.group-picker__trigger` 26px（styles.css:512） |
| `--control-h-md` | 30px | 普通按钮、单行输入框 | 现状 `input` padding 6px 9px ≈ 30px（styles.css:203-213） |
| `--control-h-lg` | 32px | 主按钮、对话输入框、对话框底部按钮 | 现状 `button` padding 5px 10px + 20px 行高 + 2px 边框 = 32px（styles.css:144-159） |
| `--control-h-xl` | 36px | 对话框主操作、发布确认键、危险操作键 | 现状无，新增 |

`padding` 只决定水平内边距：图标按钮 `padding: 0`；文字按钮 `padding: 0 var(--space-3)`。垂直方向一律由 `height` 控制，避免同一类按钮因字号不同而高低不齐。

### 1.4 圆角、阴影与语义尺寸

| 令牌 | 值 | 状态 | 说明 |
| --- | --- | --- | --- |
| `--r-xs` | 4px | **新增** | 替换全线硬编码 2/3/4/5px（`border-radius: 3px` styles.css:1543、`4px` styles.css:2705、`5px` styles.css:1145） |
| `--r-sm` | 6px | 保留 | 按钮、输入框、chip（styles.css:45） |
| `--r-md` | 8px | 保留 | 卡片、提示条（styles.css:46） |
| `--r-lg` | 12px | 保留 | 工具条容器、弹层（styles.css:47） |
| `--r-xl` | 16px | 保留 | 对话框（styles.css:48） |
| `--r-pill` | 999px | **新增** | 替换 99px / 9px / 50% 的药丸与圆点（styles.css:717、4230、5404） |
| `--shadow-sm` | 现有值 | 保留 | 悬浮元素、激活分段按钮 |
| `--shadow-md` | 现有值 | 保留 | 弹层卡片 |
| `--shadow-lg` | 现有值 | 保留 | 对话框 |
| `--shadow-page` | `0 6px 22px rgba(0,0,0,0.22)` | **新增** | 阅读器纸张投影；暗色成对为 `0 6px 22px rgba(0,0,0,0.5)`（对应 styles.css:4578-4581） |
| `--bar-h` | 46px | **新增** | 顶栏高度（styles.css:1092）；语义别名，不改视觉 |
| `--tree-indent` | 14px | **新增** | 文库树层级缩进步长（styles.css 无，现散落在 LibraryList.tsx:367/440） |
| `--opacity-disabled` | 0.45 | **新增** | 统一禁用态（现状 styles.css:171） |
| `--focus-ring` | `0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)` | **新增** | 统一焦点环；用于 `input/select/textarea:focus` 与已删除的 `.ai__preset:focus-visible`；全局 `:focus-visible` 保留 outline（偏差与理由见 §1.9） |
| `--page-bg` | `#ffffff` | **新增** | PDF 纸张底色，恒白（styles.css:1542）；暗色同值，纸张不随主题反色 |
| `--danger-fg` | `#ffffff` | **新增** | 实心危险键前景（暗色见 §4.2） |

### 1.5 颜色语义表

颜色令牌**已经在 `:root`（styles.css:9-39）与暗色块（styles.css:55-82）成对存在**，本节只规定语义与用法，不改值。新增 `--warn` / `--warn-bg` / `--st-*` 见 1.6。

| 令牌 | 浅色 | 暗色 | 语义（只能用在这些地方） |
| --- | --- | --- | --- |
| `--bg-app` | `#f4f5f7` | `#101215` | 应用最底层、主区背景 |
| `--bg-panel` | `#ffffff` | `#17191e` | 侧栏、顶栏、卡片、按钮默认底 |
| `--bg-elev` | `#ffffff` | `#1d2026` | 对话框、浮层 |
| `--bg-hover` | `#f1f3f6` | `#23262d` | 悬停底 |
| `--bg-active` | `#e8effd` | `#1c2942` | 选中行底色 |
| `--bg-inset` | `#f7f8fa` | `#1b1e24` | 输入框、内嵌区、说明条 |
| `--bg-canvas` | `#e8eaee` | `#0b0d10` | 画布/阅读区底 |
| `--border` | `#e6e8ec` | `#262a31` | 默认分隔线、控件描边 |
| `--border-strong` | `#d3d7de` | `#373c45` | 悬停描边、对话框外框 |
| `--text` | `#191c1f` | `#e7e9ec` | 主文字 |
| `--text-muted` | `#667085` | `#98a1ae` | 次要文字、说明 |
| `--text-faint` | `#98a2b3` | `#6b7280` | 占位符、元信息、禁用文字 |
| `--accent` | `#3b82f6` | `#60a5fa` | 强调色、选中、进度 |
| `--accent-strong` | `#2563eb` | `#3b82f6` | 主按钮底、强调文字 |
| `--accent-soft` | `#eaf1fe` | `#17233a` | 强调弱底、悬停底 |
| `--accent-fg` | `#ffffff` | `#0b1220` | **所有强调底上的文字/图标**（替代 `#fff`） |
| `--danger` | `#e5484d` | `#f2555a` | 破坏性操作、错误文字、失败态 |
| `--success` | `#12a150` | `#3dd68c` | 成功、完成态 |

用法规则：

- 强调色块上的文字**一律 `var(--accent-fg)`**，禁止 `#fff`（暗色下 `--accent-fg` 是深色，写 `#fff` 会白字压浅蓝，见差距 C4）。
- 错误文字用 `--danger`，错误底用 `color-mix(in srgb, var(--danger) 10%, transparent)`，禁止手写 `rgba(...)`。
- 图表/状态点/进度条必须用令牌或 `color-mix` 派生，禁止十六进制（见差距 F1/F2）。
- 命中高亮继续用现有 `--hit-*` / `--hl-*`，不要新增第二套。

### 1.6 新增状态色（警告 / 批处理 / 提案）

现状 `#b25e09` 在 styles.css:5413、5423、5720 三处重复，暗色完全未覆盖；批处理另有 6 个 hex（BatchPanel.tsx:68-75）。统一为下列令牌：

| 令牌 | 浅色 | 暗色 | 用途 |
| --- | --- | --- | --- |
| `--warn` | `#b25e09` | `#f5b544` | 警告文字、待办状态 |
| `--warn-bg` | `rgba(240, 173, 78, 0.12)` | `rgba(240, 173, 78, 0.16)` | 警告条底 |
| `--st-queued` | `#94a3b8` | `#7c8798` | 排队中 |
| `--st-scheduled` | `#f59e0b` | `#f5b544` | 待办/计划中 |
| `--st-running` | `#3b82f6` | `#60a5fa` | 执行中 |
| `--st-done` | `#12a150` | `#3dd68c` | 完成 |
| `--st-failed` | `#e5484d` | `#f2555a` | 失败 |
| `--st-cancelled` | `#6b7280` | `#98a1ae` | 已取消 |

`--st-done/--st-failed/--st-running` 与 `--success/--danger/--accent` 同值但**语义不同**：前者用于状态点/状态文字/进度条，后者用于交互控件。保留两套是为了将来单独调状态色时不牵动按钮。

### 1.7 落地位置与迁移顺序

1. 在 `:root` 内、`--r-xl`（styles.css:48）之后、`--sidebar-w`（styles.css:50）之前，追加 §1.1–§1.4、§1.6 的新令牌（约 34 行）。
2. 在 `html[data-theme='dark']` 内、styles.css:86 之后追加成对声明（§4.2），不得插在浅色块中间。
3. 先替换**全局规则**（`button`、`input`、`.panel__bar`、`.toolbar`、`.list__hint`、`.empty`、`.errbox`），再逐面板替换；每替换一个面板跑一次 `typecheck` + 该面板的 e2e。
4. `.icon` 尺寸（styles.css:197-201）改为 `width/height: var(--control-h-sm)`，但**保留 28px 视觉**。
5. 同一文件内重复的 `button {}` 块（styles.css:4585-4599）必须合并进基础块，合并后全文件 `^button {` 只允许出现一次（见 §6.2 第 3 条）。
6. 令牌命名以本文档为准。PD46 的验收条目另写了 `--sp-*` / `--fs-*` / `--ctl-*` 一套短名，按 §1.8 以**薄别名**兼容，不作为第二套真值。

### 1.8 兼容别名（PD46 临时）

PD46 验收条目同时要求 `--sp-1..--sp-6`、`--fs-xs..--fs-xl`、`--ctl-sm/md/lg`。为避免两套真值，实现以本文档的规范名为**唯一来源**，在 `:root` 与 `html[data-theme='dark']` 各补一组 `var()` 薄别名：

| 别名 | 指向 | 取值 |
| --- | --- | --- |
| `--sp-1` … `--sp-6` | `--space-1` … `--space-6` | 4/8/12/16/24/32 |
| `--fs-xs` … `--fs-xl` | `--text-xs` … `--text-xl` | 12/13/14/16/20 |
| `--ctl-sm` / `--ctl-md` / `--ctl-lg` | `--control-h-sm/md/lg` | 28/30/32 |

规则：别名只能是 `var()` 引用，不得写死具体值；组件样式**一律引用规范名**，不得引用别名。**PD47 删除全部别名**，并同步删除本小节。

### 1.9 焦点环偏差（PD46 记录）

本文档原计划用 `--focus-ring`（box-shadow）替代全局 `:focus-visible` 的 `outline`。PD46 实现后保留 outline，理由：`outline` 不被 `overflow: hidden` 的滚动/表格容器裁切，键盘焦点始终可见；换成 box-shadow 在这类容器里可能完全不可见。因此：

- 全局 `:focus-visible`：保留 `outline: 2px solid var(--accent)` + `outline-offset: 1px`，圆角改 `var(--r-xs)`；
- `input:focus / select:focus / textarea:focus`：`box-shadow: var(--focus-ring)`（输入框无 outline）；
- `.ai__preset:focus-visible`：删除自绘块，回到全局 outline。

PD47 如需彻底统一，必须先验证 `overflow: hidden` 容器内的可见性，再改本文档。

### 1.10 PD46 落地状态

- 已落地：`:root` 与暗色块**成对**新增 §1.1–§1.4、§1.6 全部令牌（含 §1.8 别名）；`body` 收敛到 `--text-sm/--lh-sm`；基础 `button`、`input/select/textarea`、标签页、面板栏、工具栏、空态/错误态、卡片与纸张改用令牌；删除第二处 `button {}`。
- 审计：`scripts/test-unit.ts` 的 `pd46DesignTokenTests()` 校验两主题键集合一致、令牌取值与命名、`^button {` 唯一、既有 `--r-*`/`--shadow-*` 未被改动、主按钮/输入框/空态卡两主题对比度 ≥ 4.5。
- 不在 PD46 范围（留给 PD47）：全文件十六进制清零、`tsx` 静态内联样式清零、其余面板的 `12.5px/11.5px` 等禁用字号、`.state` 五态组件化。
- 未执行（本岗位无 GUI）：`launch-visible.mjs` 浅色/暗色截图、`e2e`、逐区域像素复核。

---

## 2. 五态统一写法

所有“没有内容”的区域必须落到下面五态之一，不允许“只显示一行灰字”。

### 2.1 结构骨架

```html
<!-- 空态 / 错误态：整块居中 -->
<div class="state state--empty" data-testid="xxx-empty">
  <div class="state__icon"><svg .../></div>
  <div class="state__title">还没有内容</div>
  <p class="state__detail">一句话说明这是什么、为什么空。</p>
  <ol class="state__steps">
    <li>第一步</li>
    <li>第二步</li>
  </ol>
  <div class="state__actions">
    <button class="btn btn--primary">主要入口</button>
    <button class="btn btn--ghost">次要入口</button>
  </div>
</div>

<!-- 加载态：必须带 spinner 与 role=status -->
<div class="state state--loading" role="status" aria-live="polite">
  <span class="spinner" aria-hidden="true"></span>
  <span class="state__detail">正在读取…</span>
</div>

<!-- 错误态：整页失败用 state--error；顶部条用 state--inline -->
<div class="state state--error" role="alert">
  <div class="state__title">读取失败</div>
  <p class="state__detail">${原因}</p>
  <div class="state__actions">
    <button class="btn btn--ghost">重试</button>
  </div>
</div>
```

| 类名 | 作用 | 必带属性 |
| --- | --- | --- |
| `.state` | 基类：居中、纵向、`gap: var(--space-2)`、`padding: var(--space-6) var(--space-4)`、`--text-sm/--lh-sm`、`--text-muted` | — |
| `.state--empty` | 空态；标题 + 说明 + 可选步骤 + 可选主按钮 | 主导入按钮带 `data-testid` |
| `.state--loading` | 加载态；spinner + 一句现在进行时 | `role="status"` `aria-live="polite"` |
| `.state--error` | 错误态；标题 + 原因 + 重试 | `role="alert"`；原因必须原文展示，不吞异常 |
| `.state--filtered` | 有数据但筛选后为空；说明“为什么看不到” + 清除筛选按钮 | 必须能一键清除筛选 |
| `.state--inline` | 行内变体：`flex-direction: row`、`padding: var(--space-2) 0`、左对齐 | 用于面板顶部提示条、表格内单元格 |
| `.state__title` | `--text-md/--lh-md`、600、`--text` | 空态/错误态标题 |
| `.state__detail` | `--text-xs/--lh-xs`、`--text-muted`、`max-width: 560px` | 说明文字 |
| `.state__steps` | 有序步骤，`padding-left: var(--space-5)` | 空态“怎么开始” |
| `.state__actions` | 按钮行，`gap: var(--space-2)` | 最多 2 个按钮 |

尺寸约定：空态内边距 `var(--space-6) var(--space-4)`（32/16），行内变体 `var(--space-2) 0`；`state__icon` 24px，颜色 `color-mix(in srgb, var(--text-faint) 70%, transparent)`（沿用 styles.css:1501）。

### 2.2 空态（empty）

必须回答三件事：**这是什么**（标题）、**为什么会空**（说明）、**怎么开始**（至少一个可点入口或步骤）。禁止只写“暂无数据”“还没有”“（暂无明细）”。

已有正确范例可复用：`.stage-empty-guide`（styles.css:5973-6008）与 `KnowledgePanel.tsx:273-291`、`StagingPanel.tsx:1078-1087`。PD47 把 `.stage-empty-guide*` 合并进 `.state--empty`，类名迁移后删除旧类（`data-testid` 不动）。

### 2.3 加载态（loading）

- 必须出现 `.spinner`（styles.css:922-931），禁止纯文本加载。
- 文案是“正在读取已发布条目…”这类现在进行时，结尾用 `…`（U+2026），不用三个点。
- 容器 `role="status" aria-live="polite"`，避免读屏用户不知道在等待。
- 超过 300ms 才显示，避免闪烁；实现用现有 `loading` 布尔，不新增计时逻辑（如需要，由组件层加，不在样式层）。

### 2.4 错误态（error）

分两级，禁止第三种：

| 场景 | 结构 | 位置 |
| --- | --- | --- |
| 整块数据加载失败（列表/条目读不出来） | `.state .state--error`（居中） | 内容区中央，替换内容 |
| 操作失败但页面已有内容（保存失败、同步失败） | `.state .state--error .state--inline`（顶部条） | header 下方、内容上方，`role="alert"` |

错误文字必须是**真实异常信息**（`e instanceof Error ? e.message : String(e)`），不允许改写成“出错了”后再也不给原因。错误底色 `color-mix(in srgb, var(--danger) 8%, transparent)`，描边 `--border`，圆角 `--r-md`。

AI 回答失败**不得**把错误塞进 assistant 气泡冒充回答（见差距 C2），必须用 `.state--error` 并给“重试”。

### 2.5 筛选空结果（filtered）

与真空态区分：

- 真空态：`state--empty`，文案“还没有文献，先导入一篇”，按钮“导入 PDF”。
- 筛选空：`state--filtered`，文案“当前筛选下没有结果”，按钮“清除筛选”。

判断依据是“数据总量是否为 0”，不是“当前列表是否为空”。

### 2.6 禁用态（disabled）

- 用原生 `disabled`，不要用 `aria-disabled` 假装禁用（可聚焦但不可点的除外，如菜单项）。
- 统一 `opacity: var(--opacity-disabled)` + `cursor: not-allowed`，禁止各面板自写 0.4/0.5。
- 禁用时**不响应 hover**：`button:hover:not(:disabled)` 已有此保护（styles.css:161），新增规则必须带 `:not(:disabled)`。
- 禁用必须给原因：`title` 说明“为什么不能点”（例：`title="尚无译文，先点「翻译」"`，App.tsx:994）。

### 2.7 危险操作（danger）

危险 = 删除数据、取消运行中的作业、发布进正式知识库、覆盖已有条目。

| 层级 | 类名 | 视觉 | 用在哪 |
| --- | --- | --- | --- |
| 入口 | `.btn--danger`（描边式） | `--danger` 文字/描边，透明底，悬停 `color-mix(--danger 10%)` | 列表行删除、作业删除 |
| 最终确认 | `.btn--danger.btn--danger--solid` | `--danger` 实心 + `--danger-fg` 文字 | 确认框内的“确认删除/确认发布” |

确认框统一结构（`.confirm`）：标题（动作名）→ 影响面（影响 N 条，是否可撤销）→ 风险提示（`--warn`）→ 操作行（**取消在左、确认在右**，确认键用 danger）。

禁止：删除按钮用 `.ghost` 与“打开目录”同权重（见差距 F4）；发布确认用蓝色 `.primary`（见差距 E5）。

### 2.8 按钮：唯一来源

现状有两个 `button` 规则块：styles.css:144-159（基础）与 styles.css:4585-4599（二次定义 transition / hover / focus）。**这是重复与漂移的根源**（4585-4588 与 157-158 重复，4589-4591 与 161-164 重复，4597-4600 与 116-120 重复）。

规定：

1. 基础块只保留一处：styles.css:144-173（`button` + hover/active/disabled）。4585-4599 的规则合并进基础块后**删除**，不得保留第二个 `button {}`。
2. 类名体系收敛为 `.btn` + 修饰符：`.btn--primary`、`.btn--ghost`、`.btn--icon`、`.btn--danger`、`.btn--sm`。现有 `button.primary`（styles.css:175-185）、`button.ghost`（187-195）、`button.icon`（197-201）作为**兼容别名保留一轮**（PD46），PD47 改 TSX className 后删除旧别名。改名时必须逐个核 `data-testid` 不变。
3. 高度：`.btn--sm` = `--control-h-sm`，`.btn` = `--control-h-lg`，对话框主操作 = `--control-h-xl`；水平内边距 `--space-3`，图标按钮 `0`。
4. 焦点：统一 `box-shadow: var(--focus-ring)`，删除 `.ai__preset:focus-visible`（styles.css:4244-4248）这类局部自绘。

---

## 3. 表格 / 图表 / 代码块排版约束

### 3.1 表格

| 项 | 规定 |
| --- | --- |
| 结构 | 必须 `thead/tbody`；表头 `th` 用 `scope="col"` |
| 字号 | 表头 `--text-xs/--lh-xs`，600，`--text-muted`；单元格 `--text-sm/--lh-sm` |
| 内边距 | `padding: var(--space-2) var(--space-3)`（8/12） |
| 行高 | 数据行 `min-height: var(--control-h-xl)`（36px） |
| 边框 | 只用 `border-bottom: 1px solid var(--border)`；禁止竖线与外框（容器另有边框时） |
| 对齐 | 文本左对齐；数字右对齐 + `font-variant-numeric: tabular-nums` |
| 斑马纹 | 仅当数据行 > 8 时使用 `--bg-inset`，否则不用 |
| 长内容 | 单元格 `overflow-wrap: anywhere`；禁止 `text-overflow: ellipsis` 裁掉关键数字 |
| 空表 | 表体位置渲染 `.state--empty .state--inline`，不允许留空白 `tbody` |
| 滚动 | 横向滚动容器 `overflow-x: auto`，表头 `position: sticky; top: 0`，背景 `--bg-panel` |
| 暗色 | 只用令牌；`th` 背景 `--bg-inset`，禁止 `#f5f5f5` 类硬编码 |

### 3.2 图表

| 项 | 规定 |
| --- | --- |
| 容器 | 高度为 4 的倍数，最小 `160px`；宽度 100%，`min-width: 0` |
| 配色 | 顺序固定：`--accent`、`--success`、`--warn`、`--danger`、`--text-muted`；禁止 hex |
| 坐标轴 | 轴线 `1px --border`；刻度标签 `--text-xs/--lh-xs`、`--text-muted`，**不得小于 12px** |
| 网格线 | `1px --border`，仅水平线；暗色自动变浅，靠令牌 |
| 图例 | `--text-xs`，色块 8×8、圆角 `--r-xs`，与文字间距 `--space-1` |
| 留白 | 图表内边距 `var(--space-3)`，标题与图间距 `var(--space-2)` |
| 空态 | 无数据时渲染 `.state--empty`，不画空坐标系 |
| 交互 | hover/选中高亮用 `color-mix(in srgb, 色 24%, transparent)`，与表格选区一致 |

### 3.3 代码块

| 项 | 规定 |
| --- | --- |
| 字体 | `var(--font-mono)`（styles.css:7）。**禁止 `var(--mono)`**——该令牌不存在，会静默走 fallback（差距 C1） |
| 字号 | 块 `--text-xs/--lh-xs`（12/18）；行内 `--text-xs` |
| 内边距 | 块 `var(--space-3) var(--space-4)`（12/16） |
| 背景/描边 | `--bg-inset` + `1px --border`；圆角 `--r-md`；行内圆角 `--r-xs` |
| 换行 | 块 `white-space: pre` + `overflow-x: auto`（保留代码缩进，横向滚动）；行内 `overflow-wrap: anywhere` |
| 行号 | 可选；若加，用 `--text-faint` + `user-select: none`，不参与复制 |
| 复制按钮 | 右上角，`--control-h-sm` 图标按钮，`data-testid` 必填 |
| 对比度 | 暗色下 `--text` 对 `--bg-inset` ≥ 7:1，禁止用 `--text-faint` 作代码正文 |

---

## 4. 暗色主题一致性

### 4.1 成对声明规则

1. **每个新令牌**都必须在 `html[data-theme='dark']` 中出现一次，包括间距/字号/高度这类与主题无关的令牌（按字面要求，值可相同）。理由：杜绝“新增令牌只写浅色、切暗色时 `var()` 失效回退到继承值”这类问题；也让后续审计可以机械比对两个令牌块的键集合。
2. 成对声明的位置：`:root` 之后、styles.css:87 结束的暗色块内，顺序与 `:root` 一致，便于 diff。
3. 颜色令牌**必须给不同值**（或明确同值并写注释），尺寸令牌给同值即可。
4. 审计脚本（PD46 已实现）：`scripts/test-unit.ts` 的 `pd46DesignTokenTests()` 比较 `:root` 与 `html[data-theme='dark']` 的 `--*` 键集合，`missing = rootKeys - darkKeys` 与反向 `extra = darkKeys - rootKeys` 都必须为空。

### 4.2 暗色值表（新增令牌）

| 令牌 | 浅色 | 暗色 |
| --- | --- | --- |
| `--space-1..6` | 4/8/12/16/24/32 | 同值（尺寸与主题无关，按 4.1 字面成对） |
| `--text-xs..xl` | 12/13/14/16/20 | 同值 |
| `--lh-xs..xl` | 18/20/22/24/28 | 同值 |
| `--control-h-sm..xl` | 28/30/32/36 | 同值 |
| `--r-xs` | 4px | 同值 |
| `--r-pill` | 999px | 同值 |
| `--bar-h` | 46px | 同值 |
| `--tree-indent` | 14px | 同值 |
| `--opacity-disabled` | 0.45 | 同值 |
| `--focus-ring` | `0 0 0 3px color-mix(--accent 18%)` | 同式（`--accent` 已按主题解析） |
| `--page-bg` | `#ffffff` | `#ffffff`（纸张恒白，不反色） |
| `--shadow-page` | `0 6px 22px rgba(0,0,0,0.22)` | `0 6px 22px rgba(0,0,0,0.5)` |
| `--danger-fg` | `#ffffff` | `#2a1213`（暗色 `--danger` 偏亮，反相前景保证 ≥4.5:1） |
| `--warn` | `#b25e09` | `#f5b544` |
| `--warn-bg` | `rgba(240,173,78,0.12)` | `rgba(240,173,78,0.16)` |
| `--st-queued` | `#94a3b8` | `#7c8798` |
| `--st-scheduled` | `#f59e0b` | `#f5b544` |
| `--st-running` | `#3b82f6` | `#60a5fa` |
| `--st-done` | `#12a150` | `#3dd68c` |
| `--st-failed` | `#e5484d` | `#f2555a` |
| `--st-cancelled` | `#6b7280` | `#98a1ae` |

### 4.3 暗色禁止清单

| 位置 | 现状 | 处理 |
| --- | --- | --- |
| styles.css:1542 | `background: #fff`（纸张） | 改 `var(--page-bg)`，暗色同值 |
| styles.css:4263 | `color: #fff`（用户气泡） | 改 `var(--accent-fg)` |
| styles.css:2707 | `color: #fff`（批处理 chip） | 改 `var(--accent-fg)` |
| styles.css:5720 | `color: #b25e09` | 改 `var(--warn)` |
| styles.css:5413、5423 | `color: #b25e09` | 改 `var(--warn)` |
| styles.css:5721 | `rgba(240,173,78,0.12)` | 改 `var(--warn-bg)` |
| BatchPanel.tsx:68-75 | 6 个状态 hex | 改 `var(--st-*)` |

其余例外只有一处：PDF 画布纸张与其投影（styles.css:1539-1546、4578-4581），通过 `--page-bg`/`--shadow-page` 令牌化后不再视为硬编码。

---

## 5. 差距清单

行号基于基线 `f2c8b5e4d9742af3077dd621a2d93b50a6a791cc`。若基线前进导致行号漂移，按“文件 + 符号名”复核（每条都标了类名/组件位置）。合计 **38 条**，六个区域各 5–7 条。

### 5.1 文件库侧栏（6 条）

| # | 文件:行号 | 现状 | 应改成什么 |
| --- | --- | --- | --- |
| A1 | src/renderer/src/features/library/LibraryList.tsx:367 | 条目树行内联 `style={{ paddingLeft: 6 + depth * 14 }}`，缩进起点与步长写死在组件里 | 删除内联；`.tree__row` 用 `padding-left: calc(var(--space-1) + var(--depth, 0) * var(--tree-indent))`，`--depth` 由 `data-depth` 样式传入 |
| A2 | LibraryList.tsx:440 | 分组树行内联 `style={{ paddingLeft: 8 + depth * 14 }}`，起点 8 与 A1 的 6 差 2px，两棵树层级不对齐 | 与 A1 共用 `--tree-indent` 与 `--space-1` 起点，抽同一个缩进函数/类 |
| A3 | LibraryList.tsx:670-671 | 搜索中与无结果都用 `.list__hint`（styles.css:740-745，12px 灰字），无结构、无 `aria-live`，加载与空结果不可区分 | 搜索中 → `.state .state--loading`（含 `.spinner`，`role="status"`）；无结果 → `.state--filtered` + “清除筛选”按钮 |
| A4 | LibraryList.tsx:498 | `import-pdf` 主操作直接用裸 `.primary`，高度靠 `padding: 5px 10px`（styles.css:155）拼出，与 28/30/32/36 刻度无关 | `.btn .btn--primary` + `height: var(--control-h-sm)`；`import-url-go`（533-542）同改 |
| A5 | src/renderer/src/styles.css:510-523 | `.group-picker__trigger` 写死 `height: 26px`、`font-size: 12px`、`border-radius: 6px`；26 不在刻度上，6 应走令牌 | `height: var(--control-h-sm)`（28）、`font-size: var(--text-xs)`、`border-radius: var(--r-sm)` |
| A6 | styles.css:740-745 | `.list__hint` `padding: 14px 10px`（14 非刻度）+ `font-size: 12px`，同时被空态、加载、状态提示三类场景复用 | `padding: var(--space-3) var(--space-2)`、`font-size: var(--text-xs)`；状态提示改走 `.state--inline` |

### 5.2 阅读器工具栏（7 条）

| # | 文件:行号 | 现状 | 应改成什么 |
| --- | --- | --- | --- |
| B1 | src/renderer/src/App.tsx:1176-1213 | 思维地图/知识库/暂存区三个开关只有 `.on` 类表示打开，无 `aria-pressed`；981-999 的 `view-modes` 同样 | 补 `aria-pressed={open}`，样式仍用 `.on`；按钮顺序与分组不变 |
| B2 | App.tsx:1113-1124 | 查找输入框内联 `style={{ width: 120 }}`，并复用为页码设计的 `.readerbar__jump`（styles.css:1439-1441，66px 宽） | 新增 `.toolbar__find`（`width: 120px`、`height: var(--control-h-sm)`），去掉内联 |
| B3 | styles.css:1091-1101 | `.toolbar` `min-height: 46px`、`padding: 0 14px`（14 非刻度）、`gap: 8px` | `min-height: var(--bar-h)`、`padding: 0 var(--space-4)`、`gap: var(--space-2)` |
| B4 | styles.css:1141-1148 | `.seg button` `padding: 3px 10px`、`border-radius: 5px`：内部高度约 22px，与 28/30/32 不同族，5px 非令牌 | `height: calc(var(--control-h-sm) - var(--space-1))`（24px）、`padding: 0 var(--space-3)`、`border-radius: var(--r-xs)` |
| B5 | styles.css:1416-1431 | `.readerbar` `gap: 10px`、`padding: 7px 12px`、`margin-bottom: 14px`：三处非刻度，且与顶栏 gap 8 不一致 | `gap: var(--space-2)`、`padding: var(--space-2) var(--space-3)`、`margin-bottom: var(--space-4)` |
| B6 | styles.css:1107-1113 | `.toolbar__zoom` `min-width: 46px`、`font-size: 12.5px`（12.5 不在字号刻度） | `min-width: calc(var(--control-h-sm) + var(--space-4))`（44px）、`font-size: var(--text-xs)` |
| B7 | styles.css:1539-1546 | 纸张 `.pageContainer` `background: #fff`、`box-shadow: 0 6px 22px rgba(0,0,0,0.22)` 硬编码；暗色分支另写一份（4578-4581） | `background: var(--page-bg)`、`box-shadow: var(--shadow-page)`，暗色重复声明同令牌 |

### 5.3 AI 问答（6 条）

| # | 文件:行号 | 现状 | 应改成什么 |
| --- | --- | --- | --- |
| C1 | src/renderer/src/features/ai/AiPanel.tsx:782 | `fontFamily: 'var(--mono, ui-monospace, monospace)'`——`--mono` 不存在（:root 只有 `--font-mono`，styles.css:7），实际一直走 fallback | `var(--font-mono)`；全仓搜 `var(--mono` 一并修 |
| C2 | AiPanel.tsx:560-570（关键行 566） | 请求失败把 `'失败：' + msg` 写进 assistant 消息文本，错误与回答同样式、无重试、气泡内容被污染 | 用 `.state .state--error .state--inline`（`role="alert"`）+ “重试”，气泡只承载模型输出 |
| C3 | AiPanel.tsx:729 | 公式结果 textarea 内联 `style={{ minHeight: 72 }}`；780-784 表格结果内联 `minHeight: 96` + `fontFamily` + `whiteSpace` | 统一 `.ai__result`（`min-height: 96px`、`font-family: var(--font-mono)`、`white-space: pre-wrap`），删内联 |
| C4 | styles.css:4261-4265 | 用户气泡 `color: #fff` 硬编码；暗色 `--accent-fg` 已翻成深色（styles.css:73），此处会白字压浅蓝 | `color: var(--accent-fg)` |
| C5 | styles.css:4229-4238 | `.ai__preset` `border-radius: 99px`、`padding: 5px 12px`（5 非刻度）：药丸圆角自成一派 | `border-radius: var(--r-pill)`、`padding: var(--space-1) var(--space-3)` |
| C6 | styles.css:4244-4248 | `.ai__preset:focus-visible` 自绘 `box-shadow: 0 0 0 2px var(--accent-soft)`，与全局 outline（116-120）、输入框 3px（220）三套焦点样式 | 删除自绘，统一 `box-shadow: var(--focus-ring)` |

### 5.4 知识库（6 条）

| # | 文件:行号 | 现状 | 应改成什么 |
| --- | --- | --- | --- |
| D1 | src/renderer/src/features/knowledge/KnowledgePanel.tsx:271-272 | 加载态是纯文本 `<div className="stage__loading">正在读取已发布条目…</div>`，无 spinner、无 `role="status"` | `.state .state--loading` + `.spinner` + `aria-live="polite"` |
| D2 | KnowledgePanel.tsx:264-268 | 错误用 `.stage-error`（styles.css:5698-5705，贴 header 的色条），与 `.errbox`（1504-1536，居中）和 §2.4 的 `.state--error` 三套并存 | 顶部条 → `.state--error.state--inline`；整页失败 → `.state .state--error`；删除 `.stage-error` |
| D3 | KnowledgePanel.tsx:229-262 | 第二个 `.knowledge-intro`（检索模式 + 重排开关）复用“来源说明”容器，同类名承载两种语义，`data-testid="knowledge-retrieval"` 混在其中 | 拆 `.panel__section` / `.panel__section--muted`；`.knowledge-intro` 只留给来源说明 |
| D4 | styles.css:6010-6015 | `.knowledge-intro` `padding: 8px 14px 10px`：上下不对称、14 非刻度 | `padding: var(--space-2) var(--space-4)` |
| D5 | styles.css:6030-6038 | `.knowledge-intro__badge` `padding: 0 6px` + `line-height: 18px` 硬编码行高 | `padding: 0 var(--space-2)`、`line-height: var(--lh-xs)` |
| D6 | styles.css:5399-5409 | `.stage-chip` 硬编码 `height: 18px`、`border-radius: 9px`、`font-size: 10.5px`（低于字号下限），知识库与暂存区共用 | `height: var(--lh-xs)`、`border-radius: var(--r-pill)`、`font-size: var(--text-xs)`；宽度不足时用 `letter-spacing: -0.1px` 而不是缩字号 |

### 5.5 暂存区（6 条）

| # | 文件:行号 | 现状 | 应改成什么 |
| --- | --- | --- | --- |
| E1 | styles.css:5719-5722 | `.stage-notice--warn` `color: #b25e09` + `background: rgba(240,173,78,0.12)`：暗色块（54-87）未覆盖，深色底上对比不足；同值在 5411-5414、5421-5424 重复三次 | 新增 `--warn` / `--warn-bg` 并三处统一引用，暗色成对（§4.2） |
| E2 | src/renderer/src/features/knowledge/StagingPanel.tsx:783-792 | 错误与通知是两个不同类（`.stage-error` vs `.stage-notice--${tone}`），同一位置两种实现；tone 直接拼类名，新增 tone 会静默无样式 | 统一 `.state--error` / `.state--notice`，tone 走白名单映射，未知 tone 落到 `--notice` |
| E3 | StagingPanel.tsx:1076-1077 | 加载态纯文本“正在读取待审提案…”，无 spinner、无 `role` | `.state .state--loading` + `.spinner`，与 D1 同一实现 |
| E4 | styles.css:5685-5696 | `.stage__loading, .stage__empty` 共用一条规则（24px 12px、12px、muted），加载与空态视觉无法区分；`.stage__empty--inline` 又单独 6px 2px | 拆 `.state--loading`（带 spinner）与 `.state--empty`（标题+说明+步骤）；行内用 `.state--inline` |
| E5 | StagingPanel.tsx:1313-1345 | “确认发布”写入正式知识库（不可逆）却用蓝色 `.primary`，与取消键同权重方向，无危险色 | 确认键 `.btn .btn--danger.btn--danger--solid`，按 §2.7 结构重排（取消在左） |
| E6 | StagingPanel.tsx:1099-1100 | 分组内空用 `<div className="stage__empty stage__empty--inline">没有{group.label}</div>`：只有一个否定短语，无行动入口 | `.state--inline.state--empty`，附“刷新”次要按钮，文案改为“该分类暂无待审提案” |

### 5.6 批处理（7 条）

| # | 文件:行号 | 现状 | 应改成什么 |
| --- | --- | --- | --- |
| F1 | src/renderer/src/features/batch/BatchPanel.tsx:68-75 | `STATUS_COLOR` 六个硬编码 hex（`#94a3b8` `#f59e0b` `#3b82f6` `#12a150` `#e5484d` `#6b7280`），不随主题变化 | 改 `var(--st-queued/scheduled/running/done/failed/cancelled)`（§1.6） |
| F2 | styles.css:2703-2710 | `.batch__chip` `color: #fff`、`background: #94a3b8` 硬编码，与 F1 同值两处维护 | `color: var(--accent-fg)`、`background: var(--st-queued)` |
| F3 | BatchPanel.tsx:748 | chip 直接显示英文枚举 `{it.status}`（queued/running/done…），而同文件 54-61 已有中文 `STATUS_LABEL`，同一概念两种呈现 | `{STATUS_LABEL[it.status] ?? it.status}` |
| F4 | BatchPanel.tsx:592、633-646 | 取消（592）、打开产物目录（633-639）、删除记录（640-646）三个 icon 按钮无 `data-testid`；删除是破坏性操作却与“打开目录”同色同权重 | 补 `batch-cancel-${id}` / `batch-open-output-${id}` / `batch-remove-${id}`；删除用 `.btn--danger` |
| F5 | BatchPanel.tsx:394 | `<div className="panel__bar" style={{ flexWrap: 'wrap' }}>`；`.panel__bar` 本身已 `flex-wrap: wrap`（styles.css:2093），内联冗余 | 删除该内联 style |
| F6 | BatchPanel.tsx:472、512 | 两处 `style={{ borderBottom: 'none', paddingTop: 4 }}` 反复覆盖 `.panel__bar`（2087-2094） | 新增 `.panel__bar--flush`（`border-bottom: 0; padding-top: var(--space-1)`） |
| F7 | BatchPanel.tsx:562 | `<div className="list__hint" style={{ padding: '0 14px' }}>`，14 非刻度，且 `.list__hint` 是空态类被当作提示类 | 去内联；新增 `.list__hint--flush`（`padding: 0 var(--space-4)`）或改用 `.state--inline` |

---

## 6. 实施与验收

### 6.1 分工

| 任务 | 内容 | 允许改的文件 |
| --- | --- | --- |
| PD45（本轮） | 产出本规范与差距清单 | 仅 `docs/UI-SPEC.md` |
| PD46 | 落令牌：`:root` + 暗色块新增令牌；替换全局 `button/input/.panel__bar/.toolbar/.list__hint/.empty/.errbox` | `src/renderer/src/styles.css`（后端不改） |
| PD47 | 组件收敛：按 §5 逐区域改类名/结构，清理内联样式 | `styles.css` + 对应 `features/**/*.tsx`（仅 className/style） |

### 6.2 PD46/PD47 验收清单

1. `:root` 与 `html[data-theme='dark']` 键集合一致（§4.1 脚本），`missing` 为空。
2. 除 `:root`/暗色块与 `--page-bg` 纸张例外，`styles.css` 内不再有十六进制颜色：`rg -n "#[0-9a-fA-F]{3,8}" src/renderer/src/styles.css` 只命中令牌定义区。
3. 不再有第二个 `button {}` 块（§2.8），`rg -n "^button \{" src/renderer/src/styles.css` 仅 1 处。
4. `.tsx` 内不再出现静态 `style={{ padding|margin|fontSize|borderRadius }}`（动态值除外）。
5. `data-testid` 零变更：`rg -o "data-testid=\"[^\"]+\"" -r '$0'` 前后比对，集合相同。
6. 暗色逐区域人工截图核对（文件库、阅读器、AI、知识库、暂存区、批处理）；浅色同屏对照。
7. `typecheck` / `build` / `e2e` 全绿，由集成与验收岗位执行并留存日志。

### 6.3 本轮未执行的检查

本轮为纯文档产出，未改任何代码与样式，因此**未运行** `typecheck` / `build` / `e2e`，也未做 GUI 视觉复核；这三项“全绿”由后续实施与验收阶段证明，不在本文档内声称通过。差距清单的行号经只读核对（`styles.css`、`App.tsx`、`LibraryList.tsx`、`AiPanel.tsx`、`KnowledgePanel.tsx`、`StagingPanel.tsx`、`BatchPanel.tsx`），未做像素级截图比对。

### 6.4 PD46 执行记录

| §6.2 条目 | PD46 状态 |
| --- | --- |
| 1 键集合一致 | ✅ `pd46DesignTokenTests()` 断言双向为空 |
| 2 全文件无十六进制 | ⏳ 留 PD47（`.compare__warn`、`.scrollpage` 暗色底等仍在；本轮只清 `#fff`/`#b25e09` 的控件用法） |
| 3 唯一 `button {}` | ✅ 第二处（基线 4585-4599）已合并删除 |
| 4 tsx 无静态内联样式 | ⏳ 留 PD47（本轮未改任何 `.tsx`） |
| 5 `data-testid` 零变更 | ✅ 本轮未触碰 `.tsx`，`styles.css` 不含 `data-testid` |
| 6 暗色逐区域截图 | ⏳ 由验收岗位执行（本岗位无 GUI 权限） |
| 7 `typecheck`/`build`/`e2e` | 🔶 本岗位已跑 `typecheck`/`test:unit`/`build`；`e2e` 与截图由验收岗位执行 |

### 6.5 PD47 落地情况（四处高频界面）

本轮只改类名与样式（`styles.css` + 四个组件的 `className`/内联样式），未动业务逻辑、IPC、`data-testid` 与按钮文案。

新增公共类：`.state`（`--empty`/`--loading`/`--error`/`--filtered`/`--inline`，含 `__icon`/`__title`/`__detail`/`__steps`/`__actions`）、`.panel__section`（`--muted` + `-head/-title/-badge/-text/-actions`）、`.ai__result`（`--short`）、`.ai__error`，以及 `.btn`（`--primary`/`--ghost`/`--icon`/`--danger`/`--danger--solid`/`--sm`）；`button.primary/.ghost/.icon` 作为兼容别名保留（§1.8 的删除项因 `test-unit` 既有断言保留，属已记录偏差）。

| 界面 | 改了哪些 | 截图路径 |
| --- | --- | --- |
| 文件库（左栏） | 层级缩进从内联 `paddingLeft: 6/8 + depth*14` 改为 `--depth` + `calc(var(--depth) * var(--tree-indent))`（`.list__item.tree__row`、`.group-picker__item`）；展开箭头旋转移到 `.tree__caret-icon.is-open`；`import-pdf`/`import-url-go`/`library-more` 改用 `.btn.btn--primary`/`.btn.btn--ghost`；搜索中、无结果、空库三处提示换成 `.state--loading`（含 spinner + `role=status`）、`.state--inline.state--filtered`、`.state--empty` | `C:\Users\YOUR_USER\.dsh\nightshift\runs\c72f78bc-cca6-4f11-a8f8-f1a843185ed3\artifacts\6fce66da-1d85-4449-9852-85f4f9b6cff7\pd47-library-light.png`（暗色 `pd47-library-dark.png`）——待 GUI 验收岗位落盘 |
| 阅读器工具栏（标签页） | 结构未动，仅 `.doc-tabs`/`.doc-tab`/`.doc-tab__close`/`.doc-tabs__menu` 令牌化：gap `--space-1`、padding `--space-1 --space-2 --space-1 --space-3`、字号 `--text-xs`、关闭键圆角 `--r-xs`；标签高度与工具栏同层级控件对齐（`--control-h-sm`） | `...\artifacts\6fce66da-...\pd47-reader-light.png`（暗色 `pd47-reader-dark.png`）——待 GUI 验收岗位落盘 |
| AI 问答 | 公式结果 textarea 去掉内联 `minHeight:72` → `.ai__result.ai__result--short`；表格结果 textarea 去掉内联 `minHeight/fontFamily/whiteSpace` → `.ai__result`（等宽字体由 `var(--font-mono)` 承担）；调用失败不再把 `失败：…` 写进回答气泡，改为 `failed` 标记 + 气泡内 `.state.state--inline.state--error.ai__error`（`role=alert`，标题「回答失败」，失败消息不进上下文） | `...\artifacts\6fce66da-...\pd47-ai-light.png`（暗色 `pd47-ai-dark.png`）——待 GUI 验收岗位落盘 |
| 知识库 + 暂存区 | 两处 `.knowledge-intro` → `.panel__section`（检索块 `--muted`，内部 `-head/-title/-badge/-text/-actions`，重排按钮 `.btn.btn--ghost.btn--sm`）；错误条统一 `.state.state--inline.state--error`（`role=alert`）；加载态统一 `.state.state--loading`（spinner + `role=status`，新增 `knowledge-loading`/`staging-loading`）；空态统一 `.state.state--empty`（`__title/__detail/__steps/__actions`）；分组内空态 `.state--inline.state--filtered` 并补「刷新」按钮；发布确认框改为「取消」在左、「确认发布」（`.btn.btn--danger.btn--danger--solid`）在右 | `...\artifacts\6fce66da-...\pd47-knowledge-light.png`、`pd47-staging-light.png`（暗色 `pd47-knowledge-dark.png`、`pd47-staging-dark.png`）——待 GUI 验收岗位落盘 |

未落地（超出本轮 `ownedPaths`）：`App.tsx` 的 `aria-pressed` 与查找框内联 `width:120`（§5 的 B1/B2）。`docs/UI-SPEC.md` §5 的样式表行号已随 PD46/PD47 改动整体下移，按类名检索即可。
