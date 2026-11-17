"""统一结构化块适配层（阶段 B 最小 PoC）。

设计依据：docs/audit-pdf-pipeline.md §6（6.1 接口路径 / 6.2 三必填字段 / 6.3 开关方案）。

要点：
- 开关：环境变量 ``PAPERDESK_BLOCKS_ADAPTER``（``0``/未设置=关，``1``=开）。
  读取位置在适配层入口 :func:`attach_blocks`，不在 ``extract_modules`` 主流程里。
- 默认关闭时 :func:`attach_blocks` 直接返回 ``None``，调用方产物与关闭前逐字节一致。
- 开启时只做**标注**（stableId / blockType / sourceRegion），不做公式 LaTeX 重建，
  也绝不改写文本。
- 本层任何异常由调用方 catch 并只写入 ``warnings``，绝不影响 ``modules`` 主流程。
- 不新增第三方依赖（复用 PyMuPDF ``page.get_text("dict")``）。

阶段 C 增量——公式编号锚定（纯标注，:func:`anchor_equation_numbers`）：
对每个 ``equation-number`` 块，在**同一页**内找到可关联的 ``equation`` 块并
双向写 ``relatedEquationId``（同行左右优先，其次上一行，垂直间距阈值
``_ANCHOR_PREV_ROW_GAP = 1.6`` × 行高）；未命中保持 ``null`` 并写 ``warnings``。
公式本体只补 ``numberText`` / ``numberStableId``，绝不写任何 LaTeX。
详见 docs/design/blocks-adapter.md 的「编号锚定」小节。

坐标约定：`sourceRegion.rect` 与 ``python/app/modules.py:420 to_bottom`` 一致，
使用**底边原点** ``[x0, ph - y1, x1, ph - y0]``（ph=该页页高）。

对齐规则：块矩形与既有 ``modules[i].rect`` 的交集面积 / 较小者面积 > 0.6
即认为是同一块，记 ``moduleId``；否则标 ``orphan: true``。
"""

from __future__ import annotations

import os
import re

import fitz

ENV_VAR = "PAPERDESK_BLOCKS_ADAPTER"
ADAPTER_VERSION = "blocks-adapter/1"

# 行内数学判定：span 含数学特征字符（≥2 个）或上下标记号。
_MATH_CHARS = set("+−=<>≤≥≈±×÷^~|{}/∫∑∏√∞∂∇")
_EQNUM_RE = re.compile(r"^\((\d{1,4})\)$")
_REF_RE = re.compile(r"^\[\d+\]")
_CAPTION_RE = re.compile(r"^(图|表|Fig(ure)?\.?)\s*\d")
_OVERLAP_RATIO = 0.6

# 编号锚定（阶段 C）：equation-number → 同页 equation 的上一行垂直间距阈值（× 行高）。
# 同行档（两块垂直区间相碰）不用这个阈值；跨页一律不关联。
_ANCHOR_PREV_ROW_GAP = 1.6

# 编号解析：括号形式（含全角括号），如 (3) / （3） / (3a)，可带 Eq. / Equation 前缀。
_EQ_NUM_TOKEN_RE = re.compile(r"(?:Eq(?:uation)?\.?\s*)?([(（]\s*(\d{1,4}[A-Za-z]?)\s*[)）])")


def adapter_enabled() -> bool:
    """开关默认关闭：仅当环境变量严格为 1 打开。"""
    return os.environ.get(ENV_VAR) == "1"


def _to_bottom(rect: "fitz.Rect", page_h: float) -> list[float]:
    """fitz 顶边原点 bbox → 底边原点 [x0, y0, x1, y1]（与 modules.to_bottom 一致）。"""
    return [round(rect.x0, 2), round(page_h - rect.y1, 2),
            round(rect.x1, 2), round(page_h - rect.y0, 2)]


def _overlap_ratio(a: list[float], b: list[float]) -> float:
    """两块矩形（同坐标系 [x0,y0,x1,y1]）的重合度 = 交集面积 / 较小者面积。"""
    x0 = max(a[0], b[0]); y0 = max(a[1], b[1])
    x1 = min(a[2], b[2]); y1 = min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    aa = max((a[2] - a[0]) * (a[3] - a[1]), 1e-6)
    bb = max((b[2] - b[0]) * (b[3] - b[1]), 1e-6)
    return inter / min(aa, bb)


def _classify(text: str, max_size: float, body_size: float) -> str:
    """块级类型判定：编号 / 题注 / 公式编号 / 公式 / 参考文献 / 标题 / 正文。"""
    t = text.strip()
    if _EQNUM_RE.match(t):
        return "equation-number"
    if _CAPTION_RE.match(t) and len(t) < 200:
        return "caption"
    from .modules import _is_equation_like  # 局部导入避免循环依赖
    if _is_equation_like(t):
        return "equation"
    if _REF_RE.match(t):
        return "reference"
    if body_size > 0 and max_size >= body_size + 1.0 and 0 < len(t) <= 80:
        return "heading"
    return "paragraph"


def _is_math_span(text: str) -> bool:
    """span 级「疑似行内数学」判定：数学特征字符 ≥2 或 ^/~ 上下标记号。"""
    s = text.strip()
    if not s:
        return False
    if sum(1 for ch in s if ch in _MATH_CHARS) >= 2:
        return True
    return ("^" in s or "~" in s) and len(s) <= 30


def _page_modules(modules: list[dict]) -> dict[int, list[tuple[list[float], str, str]]]:
    """把 modules 按 (rect, id, type) 汇总到页号（1 基）。rect 已是底边原点。"""
    by_page: dict[int, list[tuple[list[float], str, str]]] = {}
    for m in modules:
        r = m.get("rect")
        if not r or "page" not in m:
            continue
        by_page.setdefault(int(m["page"]), []).append((list(r), m["id"], m["type"]))
    return by_page


def _page_body_size(sizes: list[float]) -> float:
    """页内正文字号估计：取众数（与 modules.py 的字符加权法对齐，这里按 span 数）。"""
    if not sizes:
        return 0.0
    counter: dict[int, int] = {}
    for s in sizes:
        r = round(s)
        if r > 0:
            counter[r] = counter.get(r, 0) + 1
    return float(max(counter, key=counter.get)) if counter else 0.0


def _parse_eq_number(text: str) -> tuple[str | None, str | None]:
    """从文本抽公式编号：(3) / (3a) / （3） / Eq. (3) → (number, numberRaw)。

    ``number`` 是去括号的核心（如 ``3`` / ``3a``）；``numberRaw`` 是括号形式的
    原文（如 ``(3a)`` / ``（3）``，``Eq. (3)`` 只保留括号部分 ``(3)``）。
    抽不出则返回 ``(None, None)``（身份仍是 equation-number，只是没有编号）。
    """
    m = _EQ_NUM_TOKEN_RE.search(text)
    if m is None:
        return None, None
    return m.group(2), m.group(1)


def _block_region(b: dict) -> tuple[int, list[float]] | None:
    """取块的（页号, 矩形）；不满足三必填形状的块返回 None（跳过，不抛错）。"""
    region = b.get("sourceRegion")
    if not isinstance(region, dict):
        return None
    page = region.get("page")
    rect = region.get("rect")
    if not isinstance(page, int) or not (isinstance(rect, list) and len(rect) == 4):
        return None
    return page, rect


def _block_line_height(b: dict) -> float:
    """行高估计：优先 span 级 ``rects`` 的最大高度（单行高度），否则用块矩形高度。

    ``rect`` 为底边原点四元组 [x0, y0, x1, y1]，y 方向高度 = |y1 - y0|。
    """
    region = b.get("sourceRegion")
    if not isinstance(region, dict):
        return 0.0
    rects = region.get("rects") or []
    heights = [r[3] - r[1] for r in rects
               if isinstance(r, list) and len(r) == 4 and r[3] > r[1]]
    if heights:
        return max(heights)
    rect = region.get("rect") or []
    if isinstance(rect, list) and len(rect) == 4 and rect[3] > rect[1]:
        return rect[3] - rect[1]
    return 0.0


def _anchor_relation(n_rect: list[float], e_rect: list[float],
                     line_h: float) -> int | None:
    """编号块 ``n_rect`` 与公式块 ``e_rect``（同页、底边原点四元组）的锚定档位。

    返回 0 = 同行（两块垂直区间相碰，编号可在公式左右任意 x 位置）、
    1 = 上一行（编号块整块位于公式块下方，编号顶边与公式底边的垂直间距
    ``gap = e_rect[1] - n_rect[3]`` ≤ ``_ANCHOR_PREV_ROW_GAP`` × 行高）、
    None = 关系不成立（不同行、跨行太远、公式在编号下方等）。
    """
    v_overlap = min(n_rect[3], e_rect[3]) - max(n_rect[1], e_rect[1])
    if v_overlap > 0.0:
        return 0  # 同行：垂直相碰即同行，x 距离不设阈值，仅用于最近排序
    gap = e_rect[1] - n_rect[3]  # 上一行：公式底边（下）到编号顶边（上）的垂直间距
    if 0.0 <= gap <= _ANCHOR_PREV_ROW_GAP * line_h:
        return 1
    return None


def anchor_equation_numbers(blocks: list[dict], warnings: list[str]) -> None:
    """公式编号锚定（阶段 C 增量，纯标注）：equation-number ↔ equation 双向关联。

    - **同页约束**：只在 ``sourceRegion.page`` 相等的块之间关联，跨页绝不串。
    - **优先级**：同行（两块垂直区间相碰）优先，其次上一行（垂直间距 ≤ 1.6 × 行高）。
    - **候选排序**：档位 → y 轴中心距离 → x 轴中心距离，取最小者；x 方向位置
      只参与排序，不设阈值。
    - **写入字段**：编号块 ``relatedEquationId`` / ``number``（去括号核心）/
      ``numberRaw``（括号原文）；公式块 ``numberText``（编号原文）与
      ``numberStableId``（指向编号块，一个公式只记第一个命中编号）。公式本体
      不写任何 LaTeX。
    - **失败**：未命中保持 ``relatedEquationId`` 为 null（不设该键），只向
      ``warnings`` 追加一条说明，绝不抛错。
    """
    eqs_by_page: dict[int, list[tuple[int, list[float]]]] = {}
    for idx, b in enumerate(blocks):
        if b.get("blockType") != "equation":
            continue
        region = _block_region(b)
        if region is not None:
            eqs_by_page.setdefault(region[0], []).append((idx, region[1]))

    for b in blocks:
        if b.get("blockType") != "equation-number":
            continue
        region = _block_region(b)
        if region is None:
            continue
        page, n_rect = region
        number, number_raw = _parse_eq_number(b.get("text", ""))
        b["number"] = number
        b["numberRaw"] = number_raw
        best_key: tuple[int, float, float, int] | None = None
        best_idx: int | None = None
        for eq_idx, e_rect in eqs_by_page.get(page, []):
            line_h = max(_block_line_height(b), _block_line_height(blocks[eq_idx]))
            relation = _anchor_relation(n_rect, e_rect, line_h)
            if relation is None:
                continue
            y_dist = abs((n_rect[1] + n_rect[3]) - (e_rect[1] + e_rect[3])) / 2.0
            x_dist = abs((n_rect[0] + n_rect[2]) - (e_rect[0] + e_rect[2])) / 2.0
            key = (relation, round(y_dist, 4), round(x_dist, 4), eq_idx)
            if best_key is None or key < best_key:
                best_key = key
                best_idx = eq_idx
        if best_idx is None:
            warnings.append(
                f"blocks 适配层：公式编号 {b.get('stableId', '?')}"
                f"（第 {page} 页「{(b.get('text') or '')[:20]}」）未找到同页可关联的"
                "公式块，relatedEquationId 保持 null（跨页不关联）"
            )
            continue
        b["relatedEquationId"] = blocks[best_idx].get("stableId")
        eq = blocks[best_idx]
        if "numberStableId" not in eq:  # 一个公式本体只记第一个命中的编号
            eq["numberText"] = number_raw
            eq["numberStableId"] = b.get("stableId")


def build_blocks(doc_path: str, modules: list[dict], warnings: list[str]) -> list[dict]:
    """生成统一结构化块标注列表（只读 PDF，绝不改写文本）。

    参数：
        doc_path: PDF 路径（重新只读打开一次）。
        modules: ``extract_modules`` 产物的 modules 数组（对齐与归属）。
        warnings: 非致命问题追加到这里（不抛出）。

    返回：块列表，每块至少含 stableId / blockType / sourceRegion 三个必填字段。
    """
    doc = fitz.open(doc_path)
    try:
        mods_by_page = _page_modules(modules)
        blocks: list[dict] = []
        for pno, page in enumerate(doc, start=1):
            ph = float(page.rect.height)
            try:
                raw = page.get_text("dict")
            except Exception as exc:  # 单页读取失败：跳过该页并记警告
                warnings.append(f"blocks 适配层：第 {pno} 页 get_text 失败，已跳过: {exc}")
                continue
            pending: list[dict] = []
            all_span_sizes: list[float] = []
            for tb in raw.get("blocks", []):
                if tb.get("type") != 0:  # type 1 为位图块，天然属于 figure，不单列
                    continue
                lines = tb.get("lines", [])
                if not lines:
                    continue
                rect = _to_bottom(fitz.Rect(tb["bbox"]), ph)
                text_parts: list[str] = []
                span_rects: list[list[float]] = []
                span_sizes: list[float] = []
                span_fonts: list[str] = []
                offsets: list[tuple[int, int, str, list[float]]] = []
                cursor = 0
                for ln in lines:
                    for sp in ln.get("spans", []):
                        t = sp.get("text", "")
                        if not t:
                            continue
                        sr = _to_bottom(fitz.Rect(sp["bbox"]), ph)
                        size = float(sp.get("size", 0.0))
                        font = sp.get("font", "")
                        if _is_math_span(t):
                            offsets.append((cursor, cursor + len(t), t, sr))
                        text_parts.append(t)
                        span_rects.append(sr)
                        span_sizes.append(size)
                        span_fonts.append(font)
                        cursor += len(t)
                text = "".join(text_parts)
                if not text.strip():
                    continue
                pending.append({
                    "rect": rect, "text": text, "offsets": offsets,
                    "span_rects": span_rects, "span_sizes": span_sizes,
                    "span_fonts": span_fonts,
                })
                all_span_sizes.extend(span_sizes)

            # 正文字号按**整页** span 众数估计后再逐块分类：标题块自身只有大字号
            # span，若只按本块尺寸估计正文，标题永远分不出 heading。
            body_size = _page_body_size(all_span_sizes)
            for item in pending:
                text = item["text"]
                span_sizes = item["span_sizes"]
                rect = item["rect"]
                max_size = max(span_sizes) if span_sizes else 0.0
                block_type = _classify(text, max_size, body_size)
                block: dict = {
                    "stableId": f"p{pno}-b{len(blocks)}",
                    "blockType": block_type,
                    "sourceRegion": {"page": pno, "rect": rect,
                                     "rects": item["span_rects"]},
                    "text": text,  # 原文逐字保留，绝不改写
                }
                if span_sizes:
                    imax = max(range(len(span_sizes)), key=lambda i: span_sizes[i])
                    block["font"] = item["span_fonts"][imax]
                    block["fontSize"] = round(span_sizes[imax], 1)
                if item["offsets"]:
                    block["inlineMath"] = [
                        {"start": s, "end": e, "text": t, "rect": r}
                        for s, e, t, r in item["offsets"]
                    ]
                # 对齐：矩形重合度 > 0.6 即认为是既有模块的同一块
                hit: str | None = None
                best = _OVERLAP_RATIO
                for mod_rect, mid, _mtype in mods_by_page.get(pno, []):
                    ratio = _overlap_ratio(rect, mod_rect)
                    if ratio > best:
                        best = ratio
                        hit = mid
                if hit is not None:
                    block["moduleId"] = hit
                else:
                    block["orphan"] = True
                blocks.append(block)
        # 编号锚定（阶段 C）：全部页生成完毕后统一做同页几何关联，跨页绝不串。
        anchor_equation_numbers(blocks, warnings)
        return blocks
    finally:
        doc.close()


def attach_blocks(doc: dict, doc_path: str, warnings: list[str]) -> list[dict] | None:
    """适配层入口：开关在**这里**读取（6.3）。

    关闭时（``PAPERDESK_BLOCKS_ADAPTER`` != "1"）什么都不做、返回 ``None``，
    ``doc`` 不被改动——保证产物与关闭前逐字节一致。
    开启时把 ``doc["blocks"]`` 与 ``doc["adapterVersion"]`` 附加到产物上。
    本函数抛出的异常由 ``extract_modules`` 的 try/except 捕获、只写入 warnings。
    """
    if not adapter_enabled():
        return None
    doc["blocks"] = build_blocks(doc_path, doc["modules"], warnings)
    doc["adapterVersion"] = ADAPTER_VERSION
    return doc["blocks"]
