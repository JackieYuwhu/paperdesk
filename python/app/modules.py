"""结构化模块层（纯脚本，PyMuPDF，不调用模型）。

把论文拆成统一模块：章节 / 段落 / 图片 / 表格 / 图注 / 表注 / 公式 / 定理 / 参考文献，
每个模块带**唯一 id、页码、原文坐标（底边原点，y 向上，与 pdf.js 一致）、阅读顺序（栏 + 行）**，
并建立**关联关系**：图注↔图、表注↔表、正文引用编号↔文末参考文献条目。

重点处理三类难点（正则与坐标作为辅助与回退）：
  * **跨行断裂**：同栏、字号接近、垂直间距很小的相邻块合并（含多行题注、文献条目续行）。
  * **双栏排版**：按列聚类 → 先左栏后右栏的阅读顺序。
  * **编号与内容分离**：题注编号与正文分块、文献条目编号与正文分块时，按「紧邻 + 同栏」合并。

上层（阅读器预览 / 原文跳转 / 问答引用）以模块定位为主，正则为兜底。
"""

from __future__ import annotations

import re

import fitz

from .blocks_adapter import attach_blocks  # 统一结构化块适配层入口（开关在适配层内读取）
from .formula import EXTRACTOR_VERSION as FORMULA_EXTRACTOR_VERSION
from .formula import build_formula
from .structure import (
    ENV_RE,
    EQ_TRAILING_NUM_RE,
    MATH_CHARS,
    MATH_FUNCS_RE,
    _is_equation_line,
)
from .translate import _figure_regions

CAP_RE = re.compile(r"^(fig(?:ure)?|tab(?:le)?|图|表)\.?\s*0*(\d+)\s*([a-z])?", re.I)
REF_HEADING_RE = re.compile(r"^\s*(references|bibliography|literature cited|参考文献)\s*$", re.I)
REF_ENTRY_RE = re.compile(r"^\s*\[?\s*(\d{1,3})\s*[\].)]\s*")
SECTION_RE = re.compile(r"^\s*\d+(?:\.\d+)*\.?\s+\S")

MAX_MODULES = 5000# 题注与图/表的最大绑定距离（pt）
BIND_MAX_DIST = 120.0
# 单页绘图子项上限：超过则跳过表格识别（极端矢量图，如整页散点/地图）
MAX_DRAW_ITEMS = 8000
# 单页绘图对象上限：超过则跳过图形区域识别（_figure_regions 为 O(n²) 合并）
MAX_DRAWINGS = 1500

_STRONG_OP = "∑∫∂∏√±→≈≤≥≠≡"
# 「数学密度」字符：几乎不出现在正文/表头里的符号（Greek + 数学算符，**不含 =**）
_MATH_DENSITY = set("∑∏∫∮∂√±×÷·⋅≈≠≤≥≡∈∉⊂⊆∪∩∀∃∇∞→←↔⇒⇔") | set(
    "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ"
)
# 公式必须含某个「运算符/关系符」
_OP_RE = re.compile(r"[=+\-*/^_<>]")
_PROSE_WORD_RE = re.compile(r"[A-Za-z]{4,}")


def _is_equation_like(t: str) -> bool:
    """比 `_is_equation_line` 更严：排除「含等号的表格行 / 正文行」这类噪声。

    规则：必须含运算符/关系符；然后 强算符 / 数学密度字符 / 数学函数 → 公式；
    否则要求行内**不含 ≥2 个 4 字母以上的英文单词**（否则像散文/表头）。
    """
    if not _is_equation_line(t):
        return False
    s = t.strip()
    if not _OP_RE.search(s):
        return False
    if any(ch in s for ch in _MATH_DENSITY):
        return True
    if MATH_FUNCS_RE.search(s) and ("=" in s or "(" in s):
        return True
    return len(_PROSE_WORD_RE.findall(s)) < 2


def _latex_from_lines(
    lines: list[dict],
    draws: list | None = None,
    page_h: float = 0.0,
    rect: list[float] | None = None,
) -> str | None:
    """兼容包装：委托给统一公式结构树（formula.build_formula）。"""
    return build_formula(lines, draws, page_h, rect)["latex"]


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _is_cjk(ch: str) -> bool:
    return bool(ch) and ("\u4e00" <= ch <= "\u9fff")


def _join_text(a: str, b: str) -> str:
    """跨行合并：连字符换行去掉连字符；中文之间不加空格；否则用空格。"""
    a = a.rstrip()
    b = b.lstrip()
    if not a:
        return b
    if not b:
        return a
    if a.endswith("-") and a[-2:-1].isalpha() and b[:1].islower():
        return a[:-1] + b
    if _is_cjk(a[-1]) or _is_cjk(b[0]):
        return a + b
    return a + " " + b


def _raw_blocks(page: "fitz.Page") -> list[dict]:
    """页内文本块（带 rect / size / 行数 / 每行 rect），已按 block 聚合。"""
    out: list[dict] = []
    data = page.get_text("dict")
    for b in data.get("blocks", []):
        if b.get("type") != 0:
            continue
        lines = b.get("lines", [])
        raw = "\n".join(
            "".join(s.get("text", "") for s in ln.get("spans", [])) for ln in lines
        ).strip()
        if not raw:
            continue
        size = max(
            (s.get("size", 0.0) for ln in lines for s in ln.get("spans", [])), default=0.0
        )
        bb = b.get("bbox") or (0, 0, 0, 0)
        lns: list[dict] = []
        for ln in lines:
            t = "".join(s.get("text", "") for s in ln.get("spans", []))
            if not t.strip():
                continue
            spans: list[dict] = []
            for s in ln.get("spans", []):
                st = s.get("text", "")
                if not st.strip():
                    continue
                o = s.get("origin") or (0.0, 0.0)
                spans.append(
                    {"text": st, "size": float(s.get("size") or 0.0), "x": float(o[0]), "y": float(o[1])}
                )
            lns.append({"raw": t, "rect": fitz.Rect(ln.get("bbox") or bb), "spans": spans})
        out.append(
            {
                "rect": fitz.Rect(bb),
                "raw": raw,
                "size": size,
                "nlines": max(1, len(lines)),
                "lines": lns,
            }
        )
    return out


def _detect_columns(blocks: list[dict], page_w: float) -> tuple[int, float]:
    """检测栏数：(columns, split_x)。仅当左右各有 ≥3 块且中间有明显空隙时判为双栏。"""
    if len(blocks) < 6:
        return 1, page_w / 2
    mid = page_w / 2
    left = [b for b in blocks if (b["rect"].x0 + b["rect"].x1) / 2 < mid]
    right = [b for b in blocks if (b["rect"].x0 + b["rect"].x1) / 2 >= mid]
    if len(left) < 3 or len(right) < 3:
        return 1, mid
    max_left_x1 = max(b["rect"].x1 for b in left)
    min_right_x0 = min(b["rect"].x0 for b in right)
    if min_right_x0 - max_left_x1 > 8:
        return 2, (max_left_x1 + min_right_x0) / 2
    return 1, mid


def _column_of(rect: "fitz.Rect", columns: int, split: float) -> int:
    if columns < 2:
        return 0
    return 0 if (rect.x0 + rect.x1) / 2 < split else 1


def _unfinished(t: str) -> bool:
    """上一块是否「未说完」（不以句末标点结尾）——用于判断是否属于同一逻辑单元的跨行断裂。"""
    s = t.rstrip()
    if not s:
        return True
    return s[-1] not in ".。:：!！?？"


def _order_and_merge(blocks: list[dict], columns: int, split: float, body: float = 0.0) -> list[dict]:
    """按（栏, y, x）排序，并合并同栏、字号接近的**跨行断裂**块。

    合并条件：紧邻（gap ≤ 0.7×字号）**或**（gap ≤ 1.6×字号 且上一块「未说完」）。
    这样多行题注/文献续行会被合并，而段落之间（以句号结尾、行距正常）不会；
    标题/参考文献标题不参与合并（它们是模块边界）。
    """

    def is_heading(b: dict) -> bool:
        t = (b.get("raw") or "").strip()
        if REF_HEADING_RE.match(t):
            return True
        if CAP_RE.match(t):
            return False
        return bool(b.get("size") and body and b["size"] >= body * 1.08 and len(t) < 160)

    for b in blocks:
        b["col"] = _column_of(b["rect"], columns, split)
    blocks.sort(key=lambda b: (b["col"], round(b["rect"].y0, 1), round(b["rect"].x0, 1)))
    merged: list[dict] = []
    for b in blocks:
        if merged:
            p = merged[-1]
            size = p["size"] or b["size"] or 10.0
            same_col = p["col"] == b["col"]
            size_ok = (not p["size"] or not b["size"]) or (
                max(p["size"], b["size"]) <= min(p["size"], b["size"]) * 1.18
            )
            gap = b["rect"].y0 - p["rect"].y1
            overlap = min(p["rect"].x1, b["rect"].x1) - max(p["rect"].x0, b["rect"].x0)
            wmin = min(p["rect"].width, b["rect"].width) or 1.0
            tight = gap <= max(3.0, size * 0.7)
            loose = gap <= max(4.0, size * 1.6) and _unfinished(p["raw"])
            close = (-1.5 <= gap) and (tight or loose)
            if same_col and size_ok and close and overlap > 0.35 * wmin and not is_heading(p):
                p["raw"] = _join_text(p["raw"], b["raw"])
                p["rect"] = fitz.Rect(
                    min(p["rect"].x0, b["rect"].x0),
                    p["rect"].y0,
                    max(p["rect"].x1, b["rect"].x1),
                    b["rect"].y1,
                )
                p["nlines"] += b["nlines"]
                p.setdefault("lines", []).extend(b.get("lines") or [])
                continue
        merged.append(dict(b))
    return merged


def _table_regions(page: "fitz.Page", draws: list | None = None) -> list["fitz.Rect"]:
    """像「表格」的绘图区域：≥3 条水平线 + ≥2 条竖线，且水平线互相重叠成一组。

    性能：单页绘图子项超过 MAX_DRAW_ITEMS 时**直接跳过**（极端矢量图，如整页散点/地图），
    避免 O(n²) 拖垮解析；分组时只与「垂直相邻」的组比较，避免全量两两比较。
    """
    try:
        draws = page.get_drawings() if draws is None else draws
    except Exception:  # noqa: BLE001
        return []
    hlines: list[tuple[float, float, float]] = []
    vlines: list[tuple[float, float, float]] = []
    seen = 0
    for d in draws:
        for it in d.get("items") or []:
            seen += 1
            if seen > MAX_DRAW_ITEMS:
                return []
            if it[0] == "re":
                r = fitz.Rect(it[1])
                hlines.append((r.x0, r.y0, r.x1))
                hlines.append((r.x0, r.y1, r.x1))
                vlines.append((r.x0, r.y0, r.y1))
                vlines.append((r.x1, r.y0, r.y1))
            elif it[0] == "l":
                p1, p2 = it[1], it[2]
                if abs(p1.y - p2.y) <= 1.2:
                    hlines.append((min(p1.x, p2.x), p1.y, max(p1.x, p2.x)))
                elif abs(p1.x - p2.x) <= 1.2:
                    vlines.append((p1.x, min(p1.y, p2.y), max(p1.y, p2.y)))
    if len(hlines) < 3 or len(vlines) < 2:
        return []
    # 按 y 排序，把「水平重叠 + 垂直相邻（行距 ≤ 45pt）」的横线聚成一组。
    # 只与「最近的组」比较：groups 按末行 y 升序维护，从尾部向前，超出 45pt 即停。
    hlines.sort(key=lambda h: h[1])
    groups: list[list[tuple[float, float, float]]] = []
    for h in hlines:
        placed = False
        for gi in range(len(groups) - 1, -1, -1):
            g = groups[gi]
            last = g[-1]
            if h[1] - last[1] > 45.0:
                break
            span = min(last[2], h[2]) - max(last[0], h[0])
            wmin = min(last[2] - last[0], h[2] - h[0]) or 1.0
            if span > 0.5 * wmin:
                g.append(h)
                placed = True
                break
        if not placed:
            groups.append([h])
            groups.sort(key=lambda gg: gg[-1][1])
    out: list["fitz.Rect"] = []
    for group in groups:
        if len(group) < 3:
            continue
        x0 = min(g[0] for g in group)
        x1 = max(g[2] for g in group)
        ys = sorted(g[1] for g in group)
        if ys[-1] - ys[0] < 20:
            continue
        vs = [
            v
            for v in vlines
            if x0 - 2 <= v[0] <= x1 + 2 and v[1] >= ys[0] - 2 and v[2] <= ys[-1] + 2
        ]
        if len(vs) < 2:
            continue
        out.append(fitz.Rect(x0, ys[0], x1, ys[-1]))
    return out


def _split_ref_entries(lines: list[dict]) -> list[dict]:
    """按行切分参考文献条目：以 [n] / n. 开头的行开新条目，其余行并入上一条。"""
    entries: list[dict] = []
    for ln in lines or []:
        t = _norm(ln.get("raw") or "")
        if not t:
            continue
        m = REF_ENTRY_RE.match(t)
        if m:
            entries.append({"n": int(m.group(1)), "text": t, "rect": fitz.Rect(ln["rect"])})
        elif entries:
            entries[-1]["text"] = _join_text(entries[-1]["text"], t)
            entries[-1]["rect"] = entries[-1]["rect"] | fitz.Rect(ln["rect"])
        else:
            entries.append({"n": None, "text": t, "rect": fitz.Rect(ln["rect"])})
    return entries


def _overlaps_any(rect: "fitz.Rect", others: list["fitz.Rect"], ratio: float = 0.5) -> bool:
    for o in others:
        inter = o & rect
        if not inter.is_empty and float(inter.get_area()) > ratio * float(rect.get_area() or 1.0):
            return True
    return False


def _image_rects(page: "fitz.Page") -> list["fitz.Rect"]:
    """页面里的位图块（很多论文的插图是位图，没有矢量绘图）。"""
    out: list["fitz.Rect"] = []
    try:
        data = page.get_text("dict")
    except Exception:  # noqa: BLE001
        return out
    for b in data.get("blocks", []):
        if b.get("type") != 1:
            continue
        r = fitz.Rect(b.get("bbox") or (0, 0, 0, 0))
        if r.width >= 40 and r.height >= 40 and not r.is_infinite:
            out.append(r)
    return out


def _merge_regions(rects: list["fitz.Rect"], gap: float = 10.0) -> list["fitz.Rect"]:
    """把邻近/重叠的矩形并成整块（图形区域常被切成多个碎块）。"""
    out: list["fitz.Rect"] = []
    used = [False] * len(rects)
    for i, r in enumerate(rects):
        if used[i]:
            continue
        cur = fitz.Rect(r)
        used[i] = True
        changed = True
        while changed:
            changed = False
            for j, r2 in enumerate(rects):
                if used[j]:
                    continue
                if (
                    cur.x0 - gap <= r2.x1
                    and r2.x0 - gap <= cur.x1
                    and cur.y0 - gap <= r2.y1
                    and r2.y0 - gap <= cur.y1
                ):
                    cur = cur | r2
                    used[j] = True
                    changed = True
        out.append(cur)
    return out


def extract_modules(path: str) -> dict:
    doc = fitz.open(path)
    modules: list[dict] = []
    pages: list[dict] = []
    captions: list[dict] = []
    refs: list[dict] = []
    columns_info: list[dict] = []
    warnings: list[str] = []
    draws_by_page: dict[int, list] = {}
    page_h_by_page: dict[int, float] = {}
    page_count = 0
    try:
        page_count = doc.page_count
        in_refs = False
        for pno, page in enumerate(doc):
            pw, ph = float(page.rect.width), float(page.rect.height)
            blocks = _raw_blocks(page)
            columns, split = _detect_columns(blocks, pw)
            columns_info.append({"page": pno + 1, "columns": columns})
            # 正文字号：按「字符数」加权取众数（先算，供合并时的标题边界判断）
            char_by_size: dict[int, int] = {}
            for b in blocks:
                rs = round(b["size"] or 0)
                if rs > 0:
                    char_by_size[rs] = char_by_size.get(rs, 0) + max(1, len(b["raw"]))
            body = float(max(char_by_size, key=char_by_size.get)) if char_by_size else 12.0
            ordered = _order_and_merge(blocks, columns, split, body)

            try:
                draws = page.get_drawings()
            except Exception:  # noqa: BLE001
                draws = []
            draws_by_page[pno] = draws
            page_h_by_page[pno] = ph
            fig_regions = _figure_regions(page, draws) if len(draws) <= MAX_DRAWINGS else []
            tbl_regions = _table_regions(page, draws)
            if len(draws) > MAX_DRAWINGS:
                warnings.append(
                    f"第 {pno + 1} 页图形对象过多（{len(draws)}），已跳过图形区域识别（仍可用题注定位）"
                )
            # 图形候选：矢量区域 + 位图块（很多插图是位图），合并碎块后过滤过小者
            fig_raw = list(fig_regions) + _image_rects(page)
            fig_cands = _merge_regions(fig_raw, gap=14.0) if len(fig_raw) <= 400 else fig_raw
            fig_cands = [r for r in fig_cands if r.width >= 60 and r.height >= 50]
            grid_cands = _merge_regions(tbl_regions, gap=6.0) if len(tbl_regions) <= 400 else tbl_regions
            grid_cands = [r for r in grid_cands if r.width >= 80 and r.height >= 60]
            # 网格若已被更大的图形候选覆盖，则不再单列（同一块图/表不重复）
            grid_cands = [r for r in grid_cands if not _overlaps_any(r, fig_cands, 0.8)]
            page_area = pw * ph

            def to_bottom(r: "fitz.Rect") -> list[float]:
                return [r.x0, ph - r.y1, r.x1, ph - r.y0]

            # 图形/表格模块（无文本）：先按候选建立，类型随后由「绑定的题注」定性
            graphic_mods: list[dict] = []
            k = 0
            for r in fig_cands:
                mid = f"p{pno + 1}-g{k}"
                k += 1
                m = {
                    "id": mid,
                    "type": "figure",
                    "page": pno + 1,
                    "column": _column_of(r, columns, split),
                    "rect": to_bottom(r),
                    "text": "",
                    "_grid": False,
                    "_area": float(r.get_area()),
                }
                graphic_mods.append(m)
            for r in grid_cands:
                mid = f"p{pno + 1}-g{k}"
                k += 1
                m = {
                    "id": mid,
                    "type": "table",
                    "page": pno + 1,
                    "column": _column_of(r, columns, split),
                    "rect": to_bottom(r),
                    "text": "",
                    "_grid": True,
                    "_area": float(r.get_area()),
                }
                graphic_mods.append(m)

            # 文本模块（body 已在上面按字符数加权算出）
            k = 0
            for b in ordered:
                text = _norm(b["raw"])
                if not text:
                    continue
                size = float(b["size"] or body)
                mcap = CAP_RE.match(text)
                # 页眉/页脚（版面上下 8%）：不参与参考文献续行合并，避免把页眉并入条目
                in_margin = b["rect"].y1 < ph * 0.08 or b["rect"].y0 > ph * 0.92
                if REF_HEADING_RE.match(text):
                    in_refs = True
                    mid = f"p{pno + 1}-t{k}"
                    k += 1
                    modules.append(
                        {
                            "id": mid,
                            "type": "section",
                            "level": 1,
                            "page": pno + 1,
                            "column": int(b["col"]),
                            "rect": to_bottom(b["rect"]),
                            "text": text,
                            "size": round(size, 2),
                        }
                    )
                    continue
                if mcap:
                    mid = f"p{pno + 1}-t{k}"
                    k += 1
                    kw = mcap.group(1).lower()
                    mod = {
                        "id": mid,
                        "type": "caption",
                        "page": pno + 1,
                        "column": int(b["col"]),
                        "rect": to_bottom(b["rect"]),
                        "text": text,
                        "size": round(size, 2),
                        "n": int(mcap.group(2)),
                        "letter": (mcap.group(3) or "").lower(),
                        "kind": "table" if kw.startswith("tab") or kw == "表" else "figure",
                    }
                    modules.append(mod)
                    captions.append(
                        {
                            "page": mod["page"],
                            "n": mod["n"],
                            "letter": mod["letter"],
                            "kind": mod["kind"],
                            "rect": mod["rect"],
                            "captionId": mod["id"],
                            "figureId": None,
                            "figureRect": None,
                        }
                    )
                    continue
                if in_refs and not in_margin:
                    # 参考文献区：按行切分条目（编号与内容分离 → 每条目一个模块）
                    entries = _split_ref_entries(b.get("lines") or [])
                    for j, e in enumerate(entries):
                        et = _norm(e["text"])
                        if not et:
                            continue
                        if e["n"] is None:
                            # 续行：并入上一条（**允许跨页**，但只并到同页/上一页，避免误并远处条目）
                            prev = next(
                                (
                                    m
                                    for m in reversed(modules)
                                    if m.get("type") == "reference"
                                    and m.get("page") in (pno + 1, pno)
                                ),
                                None,
                            )
                            if prev is not None:
                                prev["text"] = _join_text(prev["text"], et)
                                # 续行可能在同一页的另一个块、或下一页：
                                # 保护区域必须跟着续行走（旧实现只并文本不并 rect，
                                # 后半段参考文献会被当成正文送去翻译）。
                                _cont = {
                                    "page": pno + 1,
                                    "rect": to_bottom(e["rect"]),
                                }
                                prev.setdefault(
                                    "rects",
                                    [{"page": prev["page"], "rect": prev["rect"]}],
                                ).append(_cont)
                                # refs[] 与 modules[] 必须保持一致（refs 在创建时快照了文本）
                                for rr in refs:
                                    if rr.get("id") == prev.get("id"):
                                        rr["text"] = prev["text"]
                                        rr.setdefault(
                                            "rects",
                                            [{"page": rr["page"], "rect": rr["rect"]}],
                                        ).append(_cont)
                                continue
                            modules.append(
                                {
                                    "id": f"p{pno + 1}-t{k}.{j}",
                                    "type": "paragraph",
                                    "page": pno + 1,
                                    "column": int(b["col"]),
                                    "rect": to_bottom(e["rect"]),
                                    "text": et,
                                    "size": round(size, 2),
                                }
                            )
                            continue
                        emid = f"p{pno + 1}-t{k}.{j}"
                        emod = {
                            "id": emid,
                            "type": "reference",
                            "page": pno + 1,
                            "column": int(b["col"]),
                            "rect": to_bottom(e["rect"]),
                            "text": et,
                            "size": round(size, 2),
                            "refId": str(int(e["n"])),
                        }
                        modules.append(emod)
                        refs.append(
                            {
                                "n": int(e["n"]),
                                "page": emod["page"],
                                "text": et,
                                "rect": emod["rect"],
                                "id": emid,
                            }
                        )
                    k += 1
                    continue
                mid = f"p{pno + 1}-t{k}"
                k += 1
                mod: dict = {
                    "id": mid,
                    "type": "paragraph",
                    "page": pno + 1,
                    "column": int(b["col"]),
                    "rect": to_bottom(b["rect"]),
                    "text": text,
                    "size": round(size, 2),
                }
                if _is_equation_like(text):
                    mod["type"] = "equation"
                    mod["_lines"] = b.get("lines") or []
                    em = EQ_TRAILING_NUM_RE.search(text)
                    if em:
                        mod["eqNo"] = em.group(1)
                elif ENV_RE.match(text):
                    mod["type"] = "theorem"
                elif SECTION_RE.match(text) or (body and size >= body * 1.08 and len(text) < 160):
                    mod["type"] = "section"
                    mod["level"] = 1 if size >= body * 1.45 else 2
                modules.append(mod)

            # 绑定：题注 ↔ 图/表（同页、水平重叠、垂直距离最近；同距离取面积更大者）
            for cap in captions:
                if cap["page"] != pno + 1:
                    continue
                cx0, cy0, cx1, cy1 = cap["rect"]
                best = None
                best_d = 1e9
                best_area = 0.0
                for g in graphic_mods:
                    gx0, gy0, gx1, gy1 = g["rect"]
                    ov = min(gx1, cx1) - max(gx0, cx0)
                    if ov < 0.25 * min(gx1 - gx0, cx1 - cx0):
                        continue
                    d = (gy0 - cy1) if gy0 >= cy1 else (cy0 - gy1)
                    d = max(0.0, d)
                    if d > BIND_MAX_DIST:
                        continue
                    area = g.get("_area", 0.0)
                    if d < best_d - 1.0 or (abs(d - best_d) <= 1.0 and area > best_area):
                        best_d = d
                        best_area = area
                        best = g
                if best is not None:
                    cap["figureId"] = best["id"]
                    cap["figureRect"] = best["rect"]
                    # 由绑定的题注**定性**：表注 → table，图注 → figure
                    best["type"] = cap["kind"]
                    best.setdefault("captionIds", []).append(cap["captionId"])

            # 未绑定的候选：仅保留「较大的图形」（可能是无题注的图）；其余丢弃，避免错误关联
            kept_rects: list["fitz.Rect"] = []
            for g in graphic_mods:
                if g.get("captionIds"):
                    modules.append({kk: vv for kk, vv in g.items() if not kk.startswith("_")})
                    kept_rects.append(
                        fitz.Rect(g["rect"][0], ph - g["rect"][3], g["rect"][2], ph - g["rect"][1])
                    )
                elif not g.get("_grid") and g.get("_area", 0.0) >= 0.12 * page_area:
                    modules.append({kk: vv for kk, vv in g.items() if not kk.startswith("_")})
                    kept_rects.append(
                        fitz.Rect(g["rect"][0], ph - g["rect"][3], g["rect"][2], ph - g["rect"][1])
                    )

            # 仍未绑定的题注：用「题注上方到最近文本块」的启发式区域兜底，保证有可预览区域
            for cap in captions:
                if cap["page"] != pno + 1 or cap["figureId"] is not None:
                    continue
                cx0, cy0, cx1, cy1 = cap["rect"]  # 底边原点
                y_top = ph - cy1  # 题注上边（fitz 顶边原点）
                above = [
                    b["rect"].y1
                    for b in ordered
                    if b["rect"].y1 <= y_top - 2
                    and min(b["rect"].x1, cx1) - max(b["rect"].x0, cx0) > 0.2 * (cx1 - cx0)
                ]
                upper = max(above) if above else y_top - ph * 0.35
                if y_top - upper > ph * 0.45:
                    upper = y_top - ph * 0.35
                if y_top - upper < 30:
                    upper = max(0.0, y_top - ph * 0.2)
                region = fitz.Rect(cx0 - 4, upper + 2, cx1 + 4, y_top - 2)
                mid = f"p{pno + 1}-g{k}"
                k += 1
                mod = {
                    "id": mid,
                    "type": cap["kind"],
                    "page": pno + 1,
                    "column": _column_of(region, columns, split),
                    "rect": to_bottom(region),
                    "text": "",
                    "synthetic": True,
                }
                modules.append(mod)
                cap["figureId"] = mid
                cap["figureRect"] = mod["rect"]
                kept_rects.append(region)

            if kept_rects:
                pages.append(
                    {
                        "page": pno + 1,
                        "w": pw,
                        "h": ph,
                        "rects": [to_bottom(r) for r in kept_rects],
                    }
                )
    finally:
        doc.close()

    if not captions:
        warnings.append("未识别到图表题注（可能为扫描件无文本层，或该文不含图表）")
    if not refs:
        warnings.append("未识别到参考文献条目（可能无独立 References 区）")
    if any(c["columns"] > 1 for c in columns_info):
        warnings.append("检测到双栏排版：已按栏排序阅读顺序")

    # 公式模块：latex 优先**源文件直接提取**（文本层字号/基线重建，不用模型）；
    # 提取不出来时 latex=None，由上层「按需识别」（模型）后写回并标记 recognized。
    formulas = []
    for m in modules:
        if m["type"] != "equation":
            continue
        built = build_formula(
            m.get("_lines") or [],
            draws_by_page.get(m["page"] - 1, []),
            page_h_by_page.get(m["page"] - 1, 0.0),
            m.get("rect"),
        )
        formulas.append(
            {
                "id": m["id"],
                "page": m["page"],
                "n": m.get("eqNo"),
                "text": m["text"],
                "rect": m["rect"],
                "latex": built["latex"],
                "latexSource": "extracted" if built["latex"] else None,
                "rawText": built["rawText"],
                "structure": built["structure"],
                "detectionConfidence": built["detectionConfidence"],
                "reconstructionConfidence": built["reconstructionConfidence"],
                "status": built["status"],
                "extractorVersion": built["extractorVersion"],
            }
        )
    # 输出前去掉内部字段（_lines 等）
    modules = [{k: v for k, v in m.items() if not k.startswith("_")} for m in modules]

    result = {
        "pageCount": page_count,
        "extractorVersion": FORMULA_EXTRACTOR_VERSION,
        "pages": pages,
        "modules": modules[:MAX_MODULES],
        "captions": captions,
        "refs": refs,
        "formulas": formulas,
        "columns": columns_info,
        "counts": {
            "modules": min(len(modules), MAX_MODULES),
            "captions": len(captions),
            "figures": sum(1 for m in modules if m["type"] == "figure"),
            "tables": sum(1 for m in modules if m["type"] == "table"),
            "references": len(refs),
        },
        "warnings": warnings,
    }

    # 阶段 B 最小 PoC：统一结构化块标注（开关默认关闭，读取位置在适配层入口）。
    # 关闭时 attach_blocks 不做任何事，产物与关闭前逐字节一致（不 bump EXTRACTOR_VERSION）。
    # 适配层任何异常都不能影响 modules 主流程：只追加 warnings。（6.1/6.3）
    try:
        attach_blocks(result, path, result["warnings"])
    except Exception as exc:  # noqa: BLE001
        result["warnings"].append(f"blocks 适配层失败（不影响主流程）: {exc}")

    return result
