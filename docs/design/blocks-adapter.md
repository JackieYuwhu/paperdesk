# 统一结构化块适配层（阶段 B 最小 PoC）

状态：PoC 已实现，**默认关闭**。设计依据：`docs/audit-pdf-pipeline.md` §6（6.1 接口路径、6.2 三必填字段、6.3 开关方案）。

- 适配层：`python/app/blocks_adapter.py`（`build_blocks` 生成块标注，`attach_blocks` 是带开关的入口）
- 接入点：`python/app/modules.py` `extract_modules` **末尾**追加（try/except 包裹），不改任何现有函数签名
- 测试：`python/tests/test_blocks.py`（输出 `BLOCKS_OK`）；老回归 `python/tests/test_modules.py` 保持 37 条全过

## 开关

- 环境变量 `PAPERDESK_BLOCKS_ADAPTER`：`0` / 未设置 = **关（默认）**；严格 `1` = 开。
- 读取位置在适配层入口 `attach_blocks`（blocks_adapter.py `adapter_enabled()`），**不在** `extract_modules` 主流程里。
- 关闭时 `attach_blocks` 直接返回 `None`、不写任何字段：产物与改动前**逐字节一致**（`test_modules.py` 37 条断言 + `test_blocks.py` 的 `modules` 数组 json 序列化逐字节对比共同证明）。
- 因此**不需要** bump `EXTRACTOR_VERSION`（保持 `FORMULA_EXTRACTOR_VERSION` 不变），老缓存不受污染（审计 R1）。
- 回退：删掉该环境变量即可（或不部署适配层文件后删除 `extract_modules` 末尾那一段 try/except）；无需回滚数据库、无需数据迁移。

## 在应用内开启

除环境变量外，开关也做成了应用内设置，普通用户不需要改系统环境变量。

- **入口**：设置面板 →「结构化解析（实验）」→「启用块标注」复选框（`data-testid="set-blocks-adapter"`）。切换即保存，只写这一项，不会连带提交表单里其它未保存的编辑。
- **持久化**：写入现有 settings 表，键 `ai.blocksAdapter`（值 `'1'` 开 / `'0'` 关），**不改数据库 schema**，不引入新依赖。
- **默认**：关闭（`false`）——设置库里没有该键时 `blocksAdapterEnabled()` 返回 `false`，解析产物与改动前一致。
- **注入方式**：主进程 `sidecar/manager.ts::ensureSidecar` 启动解析侧车时读取该设置，只有为 `true` 才在 spawn env 里加 `PAPERDESK_BLOCKS_ADAPTER: '1'`；为 `false` 时**整段不注入**（绝不写 `'0'`），侧车环境与旧版完全一致。python 侧判定逻辑（`blocks_adapter.py::adapter_enabled`）不变。
- **生效时机**：只影响**新解析**的文档；已有文档的块标注需要**重新解析**才会出现。侧车进程在启动时读取环境变量，所以开关切换后需要等下一次启动侧车（已运行的侧车要重启应用）才生效——设置页的提示文案也写了这一点。
- **取值优先级**：沿用「设置 > 环境变量 > 默认」：设置库没有该键时读 `PAPERDESK_BLOCKS_ADAPTER`（外部环境变量仍可作备选），设置库有值则以设置为准。读界面空态提示首选指向设置面板，环境变量只作备选。
- **回滚**：设置面板关闭开关（写入 `'0'`，不再注入）；或若一直只用环境变量，删掉该变量并重置缓存。回滚不需要数据迁移，重新解析后的产物回到旧形状。

## 对齐规则

`build_blocks` 对每个 PDF 页重新只读一次 `page.get_text("dict")`，把 dict 文本块与 `extract_modules` 产物对齐：

1. **坐标**：`sourceRegion.rect` 用与 `modules.py` `to_bottom`（modules.py:420）相同的**底边原点**约定 `[x0, ph - y1, x1, ph - y0]`（ph = 该页页高）；`rects` 为同形 span 级数组。
2. **重合度**：块矩形与既有 `modules[i].rect` 的交集面积 ÷ 较小者面积 **> 0.6** 即认为是同一块，标 `moduleId`；对不上任何模块的块标 `orphan: true` 并按原顺序追加。
3. **stableId**：`p{page}-b{seq}`（页内递增序号），同一 PDF 同一版本下稳定；跨版本允许变化。
4. **blockType** 枚举：`paragraph` / `heading` / `caption` / `equation` / `equation-number` / `math-inline`（作为行内片段记录在 `inlineMath`，含起止 offset + span rect，**不改写文本**）/ `table` / `figure` / `reference`。判定顺序：编号格式 → 题注开头 → 方程式判定（复用 `modules._is_equation_like`）→ 参考文献编号 → 字号显著大于整页正文众数 &= 标题 → 段落。
5. **附加信息**：`relatedEquationId`（公式编号 `(N)` 与同页公式块的双向关联，规则见下方「编号锚定」）、`font` / `fontSize`、`inlineMath`。
6. `type 1`（位图）dict 块不单列——位图插图已由 modules 的 figure 模块表达。
7. 公式编号块的编号字段：`number`（去括号核心，如 `3` / `3a`，抽不出为 `null`）、`numberRaw`（括号原文，如 `(3)` / `（3）` / `(3a)`；`Eq. (3)` 只保留括号部分）。解析失败不影响锚定。

### 编号锚定（阶段 C 增量）

对每个 `equation-number` 块，在**同一页**内寻找可关联的 `equation` 块并双向挂钩；实现在 `blocks_adapter.anchor_equation_numbers`（全部页生成完毕后统一执行一次）。

1. **同页约束**：只在 `sourceRegion.page` 相等的块之间关联，跨页绝不串——第 1 页的编号永远挂不到第 2 页的公式。
2. **两档优先级**：
   - **同行**：两块垂直矩形区间相碰（编号位于公式同一行，左右两侧均可，x 方向距离不设阈值，仅用于最近排序）；
   - **上一行**：编号块整块位于公式块下方，编号顶边与公式底边的垂直间距 ≤ **`1.6 × 行高`**（常数 `_ANCHOR_PREV_ROW_GAP = 1.6`；行高优先取 span 级 rect 的最大高度，否则取块矩形高度）。
3. **候选排序**：先同行后上一行，再按 y 轴中心距离、x 轴中心距离取最近——即「按 y 轴中心距离与 x 方向位置找最近的 equation 块」。
4. **命中**：编号块写 `relatedEquationId`（指向公式块 stableId）与 `number` / `numberRaw`；公式块补 `numberText`（编号原文）与 `numberStableId`（指向编号块，一个公式只记第一个命中编号）。公式本体**不写任何 LaTeX**，文本一律不改写。
5. **未命中**：`relatedEquationId` 保持 `null`（不设为真值），并向 `warnings` 追加一条说明——任何关联失败只写 warnings，不抛错、不影响 modules 主流程。
6. **已知局限**：双栏文档里跨列的「同行」块可能互相锚定（本层不做列检测）；该局限只影响 PoC 标注层，不影响渲染与主解析器。

三必填字段（6.2）：每个块都有 `stableId`、`blockType`、`sourceRegion`；开启后 `extract_modules` 产物额外含 `blocks` 数组与 `adapterVersion`（当前 `"blocks-adapter/1"`）。

## 回退

- 功能级回退：`PAPERDESK_BLOCKS_ADAPTER` 不设置即完全关闭——调用方拿到的 JSON 与旧版逐字节一致，读侧（`/modules` 响应、TS 透传层）把缺失的 `blocks` 字段当 `undefined` 处理即可，无需任何条件分支回归。
- 故障级回退：适配层任何异常都被 `extract_modules` 的 try/except 捕获，只向 `warnings` 追加一条 `blocks 适配层失败（不影响主流程）: <exc>`，`modules` 主流程照常返回（`test_blocks.py` 有注入 BuildBlocks 抛错的用例证明）。
- 缓存：开启后建议在 `doc_json` 里写 `adapterVersion` 并在 `readCache` 命中时校验；PoC 阶段可用 `opts.refresh` 强制重算（审计 6.3）。
