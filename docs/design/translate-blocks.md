# 按块切分翻译单元与译文回填对齐（阶段 D 第一步）

状态：实现文件 `python/app/translate_blocks.py`（纯函数内核），测试
`python/tests/test_translate_blocks.py`。本模块**不接真实翻译调用**
（不改 `python/app/translate.py` 的既有行为），只把「哪些块进同一个
翻译单元」与「译文回来后落到哪个块」做成可测的纯函数，为接入真实
翻译链路做地基。依据 `docs/audit-pdf-pipeline.md` §3（S5 段落碎裂、
S6 双栏对齐差）与 §6（统一结构化块三必填字段）。

## 单元切分

`group_blocks(blocks, opts) -> list[dict]`：输入 blocks_adapter 产出的
统一结构化块列表（`stableId` / `blockType` / `sourceRegion` / `text`），
输出翻译单元列表。**白名单**（可译）：`paragraph` / `heading` /
`caption` / `reference`；**黑名单**（不可译，绝不进可译文本，各单独成一个
`translatable=False` 单元）：`equation` / `equation-number` /
`math-inline` / `table` / `figure`。规则按优先级：

1. 黑名单块是单元边界，`text` 为空串，原文只留在块里。
2. `heading` / `caption` 必须断开：各占一个可译单元，不与前后合并。
3. 不可跨页合并：任何块与当前单元的 `sourceRegion.page` 不同（含页号
   缺失）都立刻断开；页号缺失的块单独成单元。
4. 长度上限 `opts["maxChars"]`（默认 1200）：可译段落在同页内按阅读顺序
   合并，合并后总字符数超限则先断开再开新单元；单个超长块自成一个
   单元（不二分）。

单元字段：`unitId`（形如 `p{页}-u{页内序}`，页号缺失时 `u{序}`）、
`page`、`translatable`、`text`（可译文本；黑名单单元为空串）、`blocks`
（引用输入块；输入顺序即阅读顺序，本函数不重排）。单元展平后与输入
块一一对应、不重叠——这是回填完整性的前提。

`build_units_payload(units) -> list[dict]` 生成发给翻译服务的载荷：每
单元 `unitId` / `translatable` / `text` / `blocks`（逐块
`stableId` / `blockType` / `text` / `sourceRegion`，供回填与对齐核账）。
黑名单单元 `text` 为空串、正文不进载荷。

## 回填规则

`align_reply(units, replies) -> {"blocks": [...], "warnings": [...]}`。
`replies` 接受三种形态：`{unitId: text}` 字典、`[{"unitId": ...,
"text": ...}]` 列表（按 unitId 匹配）、`["译文", ...]` 纯字符串列表
（按序号与 units 对齐）；`None` 视为完全没有译文。

匹配规则：每个可译单元取自己的译文，写入该单元**每个块**的
`translation` 字段；不可译单元不看 replies，`translation` 恒为块原文
（公式/表格/图原样保留）。返回的块按单元顺序展平，每块带 `unitId`
与 `translation`，块为深拷贝，**不修改输入**（纯函数）。

正常路径（三种 replies 形态全命中）`warnings` 为空。

## 降级

以下四类恶劣输入都**不抛异常**，返回完整块列表（块数与 units 展平
一致）并追加 warning，对应可译块 `translation` 置空串：

1. **replies 少于 units**：每个没有译文对应的可译单元记一条
   warning（不可译单元本就不需要译文，缺失不算异常）。
2. **unitId 对不上**：未命中任何单元的可译单元降级空译文并记
   warning；replies 里对不上任何单元的 unitId 追加「已忽略」warning。
3. **译文为空字符串**：空串或全空白的译文降级为空译文，每单元记一条
   「译文为空」warning。
4. **replies 形态未知**（既非字典也非列表，或 `None`）：全部可译块降级
   空译文并记一条 warning。

降级的判定只落在**可译**单元上；幂等、无副作用，任何情况下都返回
完整的块列表 + warnings，供调用方把 warnings 上报到产物侧类似
blocks_adapter 的 warnings 通道。

## 与链路其他部分的关系

- 输入约定来自 `python/app/blocks_adapter.py`（阶段 B 统一块：
  `stableId` 形如 `p{页}-b{序}`，`sourceRegion.rect` 底边原点四元组）；
  本模块只消费 `blockType` / `sourceRegion.page` / `text` / `stableId`，
  不依赖其余字段。
- 输出方向（后续阶段）：`build_units_payload` 交给真实的翻译调用
  （Node → Python sidecar → 模型网关），`align_reply` 承接模型返回后
  落回块；块上的 `translation` 直接可用于双语渲染。接入时不改
  `python/app/translate.py` 既有函数签名，只新增调用点。
- 验收：`python python/tests/test_translate_blocks.py` 输出 `ALIGN_OK`
  且退出码 0；既有 `test_equation_anchor.py`（`EQUATION_OK`）与
  `test_modules.py`（`MODULES_OK`）不回归。
