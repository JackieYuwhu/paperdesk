"""按块切分翻译单元 + 译文回填对齐（阶段 D 第一步，纯函数内核）。

背景（依据 docs/audit-pdf-pipeline.md §3 S5/S6 与 §6）：现有翻译链路把块
逐个送审，段落碎裂、译文与原文错位。本文本模块不接翻译调用，只把两件事
做成可测试的纯函数：

1. ``group_blocks(blocks, opts)``——把 blocks_adapter 产出的统一结构化块
   （stableId / blockType / sourceRegion / text）按阅读顺序合并成翻译单元：
   - 不可译块（equation / equation-number / math-inline / table / figure，
     黑名单）单独成单元，**绝不进可译文本**；
   - heading / caption 是边界（白名单内但必须断开），各占一个单元；
   - 相邻 paragraph / reference 在**同一页**内合并，跨页绝不合并
     （以 ``sourceRegion.page`` 的分页判断为准）；
   - 单单元字符上限 ``opts["maxChars"]``（默认 1200），超限先断开。
2. ``build_units_payload(units)``——生成发给翻译服务的载荷，每单元带
   ``unitId`` 与 ``blocks`` 列表；不可译单元 ``text=""`` 且不携带正文。
3. ``align_reply(units, replies)``——把译文按 ``unitId`` 回填到每个块。
   对三种恶劣输入（replies 少于 units、unitId 对不上、译文为空字符串）
   一律**降级为空译文 + 记 warning，绝不抛异常**。

硬约束：不联网；不改 python/app/translate.py 既有行为；不引入第三方依赖；
不触碰数据库与前端。
"""

from __future__ import annotations

import copy

DEFAULT_MAX_CHARS = 1200

# 可译类型白名单：只有这些类型参与合并与翻译。
TRANSLATABLE_TYPES = frozenset({"paragraph", "heading", "caption", "reference"})
# 不可译类型黑名单：绝不进可译文本，也绝不与前后段落合并成一个单元。
UNTRANSLATABLE_TYPES = frozenset(
    {"equation", "equation-number", "math-inline", "table", "figure"}
)
# 白名单内必须断开的边界类型：标题与题注各占一个单元。
BREAK_TYPES = frozenset({"heading", "caption"})


def _block_page(block: dict) -> int | None:
    """取块的页号（sourceRegion.page，1 基）；缺失或形状不合法返回 None。"""
    region = block.get("sourceRegion")
    if isinstance(region, dict):
        page = region.get("page")
        if isinstance(page, int):
            return page
    return None


def group_blocks(blocks: list[dict], opts: dict | None = None) -> list[dict]:
    """把结构化块按阅读顺序切成翻译单元（纯函数，不改输入）。

    规则（按优先级）：
    1. **黑名单块**（blockType 命中不可译类型，或正文为空白）边界必须断开：
       单独成一个 ``translatable=False`` 的单元，``text=""``，原文只在块里。
    2. **边界类型**（heading / caption）单独成一个可译单元，不与前后合并。
    3. **跨页不合并**：任何块与当前单元的 page 不同（含 page 缺失）都断开。
    4. **长度上限**：可译段落合并后总字符数超过 ``opts["maxChars"]``（默认
       1200）时，先断开再开新单元；单个超长块自成一个单元（不二分）。未知
       blockType 且有正文按可译段落处理（白名单默认放行，便于扩展）。

    返回单元列表，每单元：``unitId``（形如 ``p{页}-u{页内序}``）/ ``page`` /
    ``translatable`` / ``text``（可译文本，黑名单单元为 ""）/ ``blocks``
    （引用输入块，不做拷贝——输入顺序即阅读顺序，本函数不重排）。
    """
    o = dict(opts or {})
    max_chars = int(o.get("maxChars") or DEFAULT_MAX_CHARS)
    translatable_types = frozenset(o.get("translatableTypes") or TRANSLATABLE_TYPES)
    untranslatable_types = frozenset(
        o.get("untranslatableTypes") or UNTRANSLATABLE_TYPES
    )

    units: list[dict] = []
    cur: dict | None = None
    seq_by_page: dict[int, int] = {}

    def unit_id(page: int | None) -> str:
        key = page if isinstance(page, int) else -1
        seq = seq_by_page.get(key, 0)
        seq_by_page[key] = seq + 1
        return f"p{key}-u{seq}" if isinstance(page, int) else f"u{seq}"

    def close() -> None:
        nonlocal cur
        if cur is not None:
            units.append(cur)
            cur = None

    for block in list(blocks or []):
        btype = block.get("blockType")
        page = _block_page(block)
        text = str(block.get("text") or "")
        translatable = (
            btype in translatable_types
            and btype not in untranslatable_types
            and bool(text.strip())
        )

        # 1) 不可译块：单元边界，绝不进可译文本。
        if not translatable:
            close()
            units.append({
                "unitId": unit_id(page),
                "page": page,
                "translatable": False,
                "text": "",
                "blocks": [block],
            })
            continue

        # 2) 边界类型：heading / caption 各占一个单元，前后都断开。
        if btype in BREAK_TYPES:
            close()
            units.append({
                "unitId": unit_id(page),
                "page": page,
                "translatable": True,
                "text": text,
                "blocks": [block],
            })
            continue

        # 3) 跨页不合并：page 不同（或当前无单元 / page 缺失）立刻断开。
        def fresh_unit() -> dict:
            return {
                "unitId": unit_id(page),
                "page": page,
                "translatable": True,
                "text": "",
                "blocks": [],
            }

        same_page = (
            cur is not None
            and cur.get("translatable") is True
            and isinstance(page, int)
            and cur.get("page") == page
        )
        if not same_page:
            close()
            cur = fresh_unit()
        else:
            # 4) 长度上限：合并会超限就先断开，重开一个新单元。
            if len(str(cur.get("text") or "")) + len(text) > max_chars:
                close()
                cur = fresh_unit()

        cur["blocks"].append(block)
        cur["text"] = (str(cur.get("text") or "") + text) if cur["text"] else text

    close()
    return units


def build_units_payload(units: list[dict]) -> list[dict]:
    """生成发给翻译服务的载荷（纯函数）。

    每个单元一项：``unitId`` / ``translatable`` / ``text``（黑名单单元为
    ""，可译文本在此） / ``blocks``（stableId / blockType / text /
    sourceRegion 逐块列出，供回填与对齐核账）。
    """
    payload: list[dict] = []
    for unit in list(units or []):
        payload.append({
            "unitId": str(unit.get("unitId") or ""),
            "translatable": bool(unit.get("translatable")),
            "text": str(unit.get("text") or ""),
            "blocks": [
                {
                    "stableId": b.get("stableId"),
                    "blockType": b.get("blockType"),
                    "text": str(b.get("text") or ""),
                    "sourceRegion": b.get("sourceRegion"),
                }
                for b in list(unit.get("blocks") or [])
            ],
        })
    return payload


def align_reply(units: list[dict], replies) -> dict:
    """把返回的译文按 unitId 回填到每个块（纯函数，不改输入，不抛异常）。

    ``replies`` 接受三种形态：
    1. ``{unitId: text}`` 字典；
    2. ``[{"unitId": ..., "text": ...}, ...]`` 列表（按 unitId 匹配）；
    3. ``["译文", ...]`` 纯字符串列表（按序号与 units 对齐）。

    降级（replies 少于 units / unitId 对不上 / 译文空串 / replies 形态未知）：
    对应单元的每个可译块 ``translation=""`` 并追加一条 warning；不可译块
    译文恒为原文。返回 ``{"blocks": [完整块列表], "warnings": [...]}``，
    块按单元顺序展平、每块带 ``unitId`` 与 ``translation``，深拷贝不改输入。
    """
    warnings: list[str] = []
    unit_list = list(units or [])
    by_id: dict[str, object] | None = None
    positional: list | None = None

    if replies is None:
        warnings.append("回填：未收到任何译文（replies 为空），所有单元降级为空译文")
    elif isinstance(replies, dict):
        by_id = {str(k): v for k, v in replies.items()}
    elif isinstance(replies, list):
        all_dict = bool(replies) and all(
            isinstance(r, dict) and ("unitId" in r or "unit_id" in r)
            for r in replies
        )
        if all_dict:
            by_id = {}
            for r in replies:
                uid = str(r.get("unitId", r.get("unit_id", "")))
                by_id[uid] = r.get("text", r.get("translation", ""))
        else:
            positional = replies
    else:
        warnings.append(
            f"回填：replies 形态未知（{type(replies).__name__}），全部单元降级为空译文"
        )

    blocks_out: list[dict] = []
    for idx, unit in enumerate(unit_list):
        uid = str(unit.get("unitId") or f"#{idx}")
        translatable = bool(unit.get("translatable"))
        if positional is not None:
            if idx < len(positional):
                text = str(positional[idx])
            else:
                text = ""
                if translatable:  # 不可译单元本就不需要译文，缺失不算异常
                    warnings.append(
                        f"回填：replies 数量少于单元数，单元 {uid} 无对应译文，降级为空译文"
                    )
        elif replies is None:
            text = ""
        elif by_id is not None:
            if uid in by_id:
                text = str(by_id[uid] or "")
                if translatable and not text.strip():
                    warnings.append(
                        f"回填：单元 {uid} 译文为空字符串，降级为空译文"
                    )
                    text = ""  # 空串/全空白一律降级为空译文
            else:
                text = ""
                if translatable:
                    warnings.append(
                        f"回填：未找到单元 {uid} 对应的译文（unitId 对不上），降级为空译文"
                    )
        else:
            text = ""

        for block in list(unit.get("blocks") or []):
            filled = copy.deepcopy(block)
            filled["unitId"] = uid
            filled["translation"] = (
                text if translatable else str(block.get("text") or "")
            )
            blocks_out.append(filled)

    if by_id is not None:
        known = {str(u.get("unitId") or "") for u in unit_list}
        for uid in by_id:
            if uid not in known:
                warnings.append(f"回填：replies 里的 unitId {uid!r} 对不上任何单元，已忽略")

    return {"blocks": blocks_out, "warnings": warnings}
