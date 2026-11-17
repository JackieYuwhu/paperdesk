"""公式结构树：span（+ 矢量横线）→ token → 结构树 → LaTeX。

为什么不是"按阅读顺序拼接"：分式/根号/矩阵/运算符上下限都是**二维布局**，
按行拼接会丢失结构（两行分式会被拼成 `a \\ b`，矩阵会串列）。

节点（`structure_json` 里就是这棵树）：
  {"k":"text","t":str}
  {"k":"script","base":n,"sub":n|null,"sup":n|null}
  {"k":"frac","num":n,"den":n}
  {"k":"root","rad":n,"index":n|null}
  {"k":"op","sym":str,"lower":n|null,"upper":n|null,"placement":"limits"|"scripts"}
  {"k":"matrix","rows":[[n,...],...],"delim":["(",")"]}
  {"k":"row","items":[n,...]}

质量标记：`detection_confidence`（是不是公式）/ `reconstruction_confidence`（还原是否可靠）
/ `status` ∈ accepted | uncertain | failed。低置信度**保留原文**，不产出"看着可信"的公式。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import fitz

# Unicode 数学符号 → LaTeX 命令
MATH_CMD = {
    "∑": r"\sum", "∏": r"\prod", "∫": r"\int", "∮": r"\oint", "√": r"\sqrt",
    "≈": r"\approx", "≠": r"\neq", "≤": r"\leq", "≥": r"\geq", "≡": r"\equiv",
    "×": r"\times", "÷": r"\div", "·": r"\cdot", "⋅": r"\cdot", "±": r"\pm",
    "∈": r"\in", "∉": r"\notin", "⊂": r"\subset", "⊆": r"\subseteq",
    "∪": r"\cup", "∩": r"\cap", "∀": r"\forall", "∃": r"\exists",
    "∞": r"\infty", "→": r"\to", "←": r"\leftarrow", "↔": r"\leftrightarrow",
    "⇒": r"\Rightarrow", "⇔": r"\Leftrightarrow", "∂": r"\partial",
    "∇": r"\nabla", "∝": r"\propto", "∼": r"\sim", "≪": r"\ll", "≫": r"\gg",
    "α": r"\alpha", "β": r"\beta", "γ": r"\gamma", "δ": r"\delta", "ε": r"\epsilon",
    "ζ": r"\zeta", "η": r"\eta", "θ": r"\theta", "κ": r"\kappa", "λ": r"\lambda",
    "μ": r"\mu", "ν": r"\nu", "ξ": r"\xi", "π": r"\pi", "ρ": r"\rho", "σ": r"\sigma",
    "τ": r"\tau", "φ": r"\phi", "χ": r"\chi", "ψ": r"\psi", "ω": r"\omega",
    "Γ": r"\Gamma", "Δ": r"\Delta", "Θ": r"\Theta", "Λ": r"\Lambda", "Ξ": r"\Xi",
    "Π": r"\Pi", "Σ": r"\Sigma", "Φ": r"\Phi", "Ψ": r"\Psi", "Ω": r"\Omega",
}
LATEX_ESCAPE = {"&": r"\&", "%": r"\%", "#": r"\#", "{": r"\{", "}": r"\}",
                "_": r"\_", "$": r"\$", "~": r"\sim"}
# 大型运算符（上下限可置于正上/正下 → \limits）
BIG_OPS = set("∑∏∫∮⋃⋂⋁⋀∐")
# 括号族（矩阵分隔符）
DELIMS = {"(": "(", ")": ")", "[": "[", "]": "]", "{": r"\{", "}": r"\}",
          "（": "(", "）": ")", "【": "[", "】": "]", "⟨": r"\langle", "⟩": r"\rangle"}
OPEN_DELIMS = set("([{（【⟨")
CLOSE_DELIMS = set(")]}）】⟩")
# 乱码/异常字符
_BAD_CHARS = re.compile(r"[\ufffd\ue000-\uf8ff\u0000-\u0008\u000b-\u001f]")
_MATHY_RE = re.compile(r"\\[a-zA-Z]+|\^|_|=|\\frac|\\sum|\\int")
_OP_RE = re.compile(r"[=+\-*/^_<>]")
PROSE_WORD_RE = re.compile(r"[A-Za-z]{4,}")
EXTRACTOR_VERSION = "formula-tree-2"

# 阈值
MIN_RULE_LEN = 6.0        # 分数线最短长度（pt）
RULE_PAD = 1.5            # 分数线上下收集 token 的容差
DETECT_ACCEPT = 0.7
RECON_ACCEPT = 0.6
DETECT_FLOOR = 0.4


@dataclass
class Tok:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    baseline: float
    size: float
    font: str = ""

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclass
class Rule:
    x0: float
    x1: float
    y: float

    @property
    def length(self) -> float:
        return self.x1 - self.x0


# --------------------------------------------------------------------------- #
# token / 横线
# --------------------------------------------------------------------------- #
def tokens_from_lines(lines: list[dict]) -> list[Tok]:
    out: list[Tok] = []
    for ln in lines or []:
        for s in ln.get("spans") or []:
            t = s.get("text") or ""
            if not t.strip():
                continue
            r = ln.get("rect")
            y = float(s.get("y") or 0.0)
            size = float(s.get("size") or 0.0)
            x = float(s.get("x") or 0.0)
            # span 只有起点；宽度按字号与字符数估算，用于水平范围判断
            w = max(1.0, size * 0.55 * len(t))
            top = y - size * 0.8
            bot = y + size * 0.25
            out.append(
                Tok(
                    text=t,
                    x0=x,
                    y0=top,
                    x1=x + w,
                    y1=bot,
                    baseline=y,
                    size=size,
                    font=str(s.get("font") or ""),
                )
            )
    # 阅读顺序：先左→右（脚本 token 紧跟其基座），再按基线分行（build_tree 内分组）
    out.sort(key=lambda k: (k.x0, k.baseline))
    return out


def rules_from_draws(draws: list, page_h: float, rect: list[float]) -> list[Rule]:
    """区域内**短横线**候选（分数线/根号横线）。排除贯穿整区的表格线。"""
    if not draws or page_h <= 0 or not rect:
        return []
    try:
        r = fitz.Rect(rect[0], page_h - rect[3], rect[2], page_h - rect[1])
    except Exception:  # noqa: BLE001
        return []
    span = max(1.0, r.x1 - r.x0)
    out: list[Rule] = []
    for d in draws:
        for it in d.get("items") or []:
            seg = None
            if it[0] == "re":
                rr = fitz.Rect(it[1])
                seg = (rr.x0, rr.y0, rr.x1)
            elif it[0] == "l":
                p1, p2 = it[1], it[2]
                if abs(p1.y - p2.y) <= 1.0:
                    seg = (min(p1.x, p2.x), p1.y, max(p1.x, p2.x))
            if not seg:
                continue
            x0, y, x1 = seg
            if x1 - x0 < MIN_RULE_LEN:
                continue
            if y < r.y0 - 4 or y > r.y1 + 4:
                continue
            if x0 < r.x0 - 8 or x1 > r.x1 + 8:
                continue
            # 贯穿整个区域且区域很宽 → 更像表格线
            if (x1 - x0) >= 0.94 * span and span > 120:
                continue
            out.append(Rule(x0=x0, x1=x1, y=y))
    out.sort(key=lambda k: -k.length)
    return out


# --------------------------------------------------------------------------- #
# 结构树
# --------------------------------------------------------------------------- #
def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _text_node(toks: list[Tok]) -> dict:
    return {"k": "text", "t": "".join(t.text for t in toks)}


def _attach_scripts(toks: list[Tok], body: float) -> list[tuple[float, dict]]:
    """把「更小 + 基线偏移」的 token 挂到前一个基座上（sub/sup）。返回 [(x0, node)]。

    基座是**大型运算符**时产出 `op` 节点并标 `placement='side'`（右侧上下标，**不加** `\\limits`），
    与"正上/正下"（`above_below`）区分开。
    """
    out: list[tuple[float, dict]] = []
    prev: Tok | None = None
    for t in toks:
        small = t.size < body * 0.86
        adjacent = prev is not None and (t.x0 - prev.x1) <= body * 1.6
        if small and prev is not None and out and adjacent:
            node = out[-1][1]
            up = t.baseline < prev.baseline - body * 0.12
            down = t.baseline > prev.baseline + body * 0.12
            if node["k"] == "script" or node["k"] == "op":
                if up and node.get("sup") is None:
                    node["sup"] = _text_node([t])
                    continue
                if down and node.get("sub") is None:
                    node["sub"] = _text_node([t])
                    continue
            elif up or down:
                base_txt = (prev.text or "").strip()
                if base_txt in BIG_OPS:
                    out[-1] = (
                        out[-1][0],
                        {
                            "k": "op",
                            "sym": base_txt,
                            "sub": _text_node([t]) if down else None,
                            "sup": _text_node([t]) if up else None,
                            "lower": _text_node([t]) if down else None,
                            "upper": _text_node([t]) if up else None,
                            "placement": "side",
                        },
                    )
                    continue
                out[-1] = (
                    out[-1][0],
                    {
                        "k": "script",
                        "base": node,
                        "sub": _text_node([t]) if down else None,
                        "sup": _text_node([t]) if up else None,
                    },
                )
                continue
        out.append((t.x0, _text_node([t])))
        prev = t
    return out


def _detect_op_limits(toks: list[Tok], body: float) -> tuple[dict[int, dict], set[int]]:
    """大型运算符的**正上/正下**上下限（placement=limits）。返回 ({id(tok): node}, 被消费的 id)。"""
    nodes: dict[int, dict] = {}
    consumed: set[int] = set()
    for i, t in enumerate(toks):
        sym = t.text.strip()
        if sym not in BIG_OPS:
            continue
        upper: dict | None = None
        lower: dict | None = None
        up_id = dn_id = -1
        for j, o in enumerate(toks):
            if j == i or o.size >= body * 0.9:
                continue
            if abs(o.cx - t.cx) > max(t.size * 1.0, t.x1 - t.x0):
                continue
            if o.baseline < t.baseline - body * 0.12 and o.y1 <= t.y0 + body * 0.5:
                upper, up_id = _text_node([o]), j
            elif o.baseline > t.baseline + body * 0.12 and o.y0 >= t.y1 - body * 0.5:
                lower, dn_id = _text_node([o]), j
        if upper or lower:
            nodes[id(t)] = {
                "k": "op",
                "sym": sym,
                "upper": upper,
                "lower": lower,
                "sub": lower,
                "sup": upper,
                "placement": "above_below",
            }
            consumed.add(id(t))
            if up_id >= 0:
                consumed.add(id(toks[up_id]))
            if dn_id >= 0:
                consumed.add(id(toks[dn_id]))
    return nodes, consumed


def _delim_matches(open_ch: str, close_ch: str) -> bool:
    return (open_ch, close_ch) in {
        ("(", ")"), ("[", "]"), ("{", "}"), ("（", "）"), ("【", "】"),
        ("⟨", "⟩"), ("{", r"\}"),
    } or DELIMS.get(open_ch) == DELIMS.get(close_ch)


def _nested_matrix_items(
    order: list[Tok], body: float, rules: list[Rule], depth: int
) -> list[tuple[float, float, float, float, list[Tok], dict | None]]:
    """把**内层分隔符对**整体合成为一个 item（内层优先）→ 支持嵌套矩阵。

    返回 [(x0, x1, y0, y1, tokens, node_or_None)]，按 x 升序。
    """
    opens = [t for t in order if t.text.strip() in OPEN_DELIMS]
    closes = [t for t in order if t.text.strip() in CLOSE_DELIMS]
    cands: list[tuple[float, Tok, Tok, list[Tok]]] = []
    for o in opens:
        for c in closes:
            if c.x0 <= o.x1 or not _delim_matches(o.text.strip(), c.text.strip()):
                continue
            mid = (o.y0 + o.y1) / 2
            # 内层内容必须落在该对括号的**纵向范围内**（约 ±2 行），否则会把下方行的内容吞进来
            inside = [
                t
                for t in order
                if t.x0 > o.x1 - 1
                and t.x1 < c.x0 + 1
                and abs((t.y0 + t.y1) / 2 - mid) <= body * 2.2
            ]
            if len(inside) >= 3:
                cands.append((c.x0 - o.x0, o, c, inside))
            break
    cands.sort(key=lambda p: p[0])  # 跨度升序 = 内层优先
    consumed: set[int] = set()
    items: list[tuple[float, float, float, float, list[Tok], dict | None]] = []
    for _span, o, c, inside in cands:
        if id(o) in consumed or id(c) in consumed or depth > 6:
            continue
        grp = [o] + inside + [c]
        node = _build_matrix(grp, body, rules, depth + 1)
        if node is None:
            continue
        for t in grp:
            consumed.add(id(t))
        items.append(
            (
                o.x0,
                c.x1,
                min(t.y0 for t in grp),
                max(t.y1 for t in grp),
                grp,
                node,
            )
        )
    for t in order:
        if id(t) in consumed:
            continue
        items.append((t.x0, t.x1, t.y0, t.y1, [t], None))
    items.sort(key=lambda it: it[0])
    return items


def _build_matrix(toks: list[Tok], body: float, rules: list[Rule], depth: int = 0) -> dict | None:
    """括号包围 + 坐标聚类成行列（含**空单元格**、**嵌套矩阵**）；每个单元格递归解析。

    行/列坐标只用「单元格内容」的基座 item（**排除分隔符**，避免嵌套括号多出行列）。
    """
    if len(toks) < 4 or depth > 6:
        return None
    opens = [t for t in toks if t.text.strip() in OPEN_DELIMS]
    closes = [t for t in toks if t.text.strip() in CLOSE_DELIMS]
    if not opens or not closes:
        return None
    lo = min(opens, key=lambda t: t.x0)
    hi = max(closes, key=lambda t: t.x1)
    if lo.x1 > hi.x0:
        return None
    inner = [t for t in toks if t.x0 >= lo.x1 - 1 and t.x1 <= hi.x0 + 1]
    if len(inner) < 3:
        return None
    order = sorted(inner, key=lambda t: t.x0)
    items = _nested_matrix_items(order, body, rules, depth)
    # 单元格内容 item：排除「单独的分隔符」item
    content_items = [
        it for it in items if it[5] is not None or it[4][0].text.strip() not in DELIMS
    ]
    if len(content_items) < 3:
        return None
    sizes = [
        t.size
        for it in content_items
        for t in it[4]
        if t.text.strip() not in DELIMS  # 分隔符字号偏大，不能用来定基座阈值
    ]
    cbody = max(sizes) if sizes else body
    base = [it for it in content_items if max(t.size for t in it[4]) >= cbody * 0.86] or content_items
    rows_y: list[float] = []
    for it in sorted(base, key=lambda k: (k[2] + k[3]) / 2):
        cy = (it[2] + it[3]) / 2
        if not rows_y or abs(cy - rows_y[-1]) > body * 0.6:
            rows_y.append(cy)
    if len(rows_y) < 2:
        return None
    cols_x: list[float] = []
    for it in sorted(base, key=lambda k: k[0]):
        if not cols_x or it[0] - cols_x[-1] > body * 1.2:
            cols_x.append(it[0])
    if len(cols_x) < 2:
        return None
    cells: list[list[list[tuple]]] = [[[] for _ in cols_x] for _ in rows_y]
    for it in content_items:
        cy = (it[2] + it[3]) / 2
        ri = min(range(len(rows_y)), key=lambda i: abs(rows_y[i] - cy))
        ci = min(range(len(cols_x)), key=lambda i: abs(cols_x[i] - it[0]))
        cells[ri][ci].append(it)
    rows: list[list[dict]] = []
    for row in cells:
        out_row: list[dict] = []
        for cell in row:
            if not cell:
                out_row.append(_text_node([]))  # 空单元格：保留位置
                continue
            if len(cell) == 1 and cell[0][5] is not None:
                out_row.append(cell[0][5])  # 嵌套矩阵：直接用已构建的节点
                continue
            cell_toks: list[Tok] = []
            for it in sorted(cell, key=lambda k: k[0]):
                cell_toks.extend(it[4])
            out_row.append(build_tree(cell_toks, rules, body, depth + 1))
        rows.append(out_row)
    return {
        "k": "matrix",
        "rows": rows,
        "delim": [DELIMS.get(lo.text.strip(), "("), DELIMS.get(hi.text.strip(), ")")],
        # PDF 坐标只能推断可见对齐；无法可靠判断作者用了 array 还是等价写法 → 保留未知
        "alignment": "unknown",
    }


def _row_items(toks: list[Tok], body: float, rules: list[Rule]) -> list[tuple[float, dict]]:
    """无横线（或已扣掉分式后）：矩阵 / 上下标 / 大型运算符上下限。"""
    if not toks:
        return []
    whole = _build_matrix(toks, body, rules)
    if whole is not None:
        return [(min(t.x0 for t in toks), whole)]
    lines_y: list[float] = []
    for t in sorted(toks, key=lambda k: k.baseline):
        if not lines_y or abs(t.baseline - lines_y[-1]) > body * 0.6:
            lines_y.append(t.baseline)
    groups: list[list[Tok]] = [[] for _ in lines_y]
    for t in toks:
        gi = min(range(len(lines_y)), key=lambda i: abs(lines_y[i] - t.baseline))
        groups[gi].append(t)
    pairs: list[tuple[float, dict]] = []
    used_ids: set[int] = set()
    for g in groups:
        g.sort(key=lambda k: k.x0)
        m = _build_matrix(g, body, rules)
        if m is not None:
            pairs.append((min(t.x0 for t in g), m))
            used_ids.update(id(t) for t in g)
    flat = [t for t in sorted(toks, key=lambda k: k.x0) if id(t) not in used_ids]
    op_nodes, consumed = _detect_op_limits(flat, body)
    remaining = [t for t in flat if id(t) not in consumed]
    pairs.extend(_attach_scripts(remaining, body))
    # 大型运算符但没有可判定的上下限/右侧脚本 → placement='unknown'（保留位置语义，不猜）
    pairs = [
        (x, {"k": "op", "sym": n["t"].strip(), "placement": "unknown"} if n.get("k") == "text" and n.get("t", "").strip() in BIG_OPS else n)
        for x, n in pairs
    ]
    for t in flat:
        if id(t) in op_nodes:
            pairs.append((t.x0, op_nodes[id(t)]))
    return pairs


def _compose_subset(items: list, idxs: list[int], rules: list[Rule], body: float, depth: int) -> dict:
    """由若干 item 组成一个子表达式：若都是纯文本 token，则走完整解析（保留上下标）；否则按序成 Row。"""
    picked = [items[i] for i in sorted(idxs)]
    simple = all(it[4]["k"] == "text" and len(it[5]) == 1 for it in picked)
    if simple and depth < 8:
        toks: list[Tok] = []
        for it in picked:
            toks.extend(it[5])
        return build_tree(toks, rules, body, depth + 1)
    return {"k": "row", "items": [it[4] for it in picked]}


def build_tree(toks: list[Tok], rules: list[Rule], body: float, depth: int = 0) -> dict:
    """递归：横线 → **内层优先**的 Fraction/Root（局部作用域）；否则 矩阵/上下标/上下限。

    做法：把 token 变成可被「替换」的 item 序列；按横线**长度升序**处理（内层横线通常更短），
    命中后把上/下 item 合成一个节点再放回序列 —— 于是内层分式成为节点参与外层解析，
    `a + \\frac{b}{c} = d` 这类局部作用域也自然成立。
    """
    if not toks:
        return {"k": "text", "t": ""}
    if depth > 8:
        return {"k": "row", "items": [n for _, n in _row_items(toks, body, [])]}
    # item = (x0, x1, y0, y1, node, source_tokens)
    items: list[tuple[float, float, float, float, dict, list[Tok]]] = [
        (t.x0, t.x1, t.y0, t.y1, _text_node([t]), [t]) for t in sorted(toks, key=lambda k: k.x0)
    ]
    for rule in sorted(rules, key=lambda r: r.length):
        above: list[int] = []
        below: list[int] = []
        for i, (x0, x1, y0, y1, _n, _src) in enumerate(items):
            if _overlap(x0, x1, rule.x0, rule.x1) < 0.3 * max(1.0, min(x1 - x0, rule.length)):
                continue
            if y1 <= rule.y + RULE_PAD and (rule.y - y1) <= body * 2.2:
                above.append(i)
            elif y0 >= rule.y - RULE_PAD and (y0 - rule.y) <= body * 2.2:
                below.append(i)
        # 多行分子/分母：按「行距」继续向上/向下吸收水平对齐的相邻行
        def extend(idxs: list[int], upward: bool) -> None:
            changed = True
            while changed:
                changed = False
                cur = [items[i] for i in idxs]
                if not cur:
                    break
                edge = min(it[2] for it in cur) if upward else max(it[3] for it in cur)
                for i, it in enumerate(items):
                    if i in idxs:
                        continue
                    if _overlap(it[0], it[1], rule.x0, rule.x1) < 0.3 * max(
                        1.0, min(it[1] - it[0], rule.length)
                    ):
                        continue
                    if upward and it[3] <= edge + RULE_PAD and (edge - it[3]) <= body * 1.4:
                        idxs.append(i)
                        changed = True
                    elif not upward and it[2] >= edge - RULE_PAD and (it[2] - edge) <= body * 1.4:
                        idxs.append(i)
                        changed = True

        if above:
            extend(above, True)
        if below:
            extend(below, False)
        inner_rules = [r for r in rules if r is not rule]
        if above and below:
            node = {
                "k": "frac",
                "num": _compose_subset(items, above, inner_rules, body, depth),
                "den": _compose_subset(items, below, inner_rules, body, depth),
            }
        elif below and not above:
            w = max((items[i][1] - items[i][0] for i in below), default=1.0)
            if rule.length > 1.8 * max(1.0, w):
                continue  # 更像表格线，不当根号
            node = {
                "k": "root",
                "rad": _compose_subset(items, below, inner_rules, body, depth),
                "index": None,
            }
        else:
            continue
        idxs = sorted(above + below)
        x0 = min(items[i][0] for i in idxs)
        x1 = max(items[i][1] for i in idxs)
        y0 = min(items[i][2] for i in idxs)
        y1 = max(items[i][3] for i in idxs)
        src: list[Tok] = []
        for i in idxs:
            src.extend(items[i][5])
        items = [it for j, it in enumerate(items) if j not in set(idxs)]
        items.append((x0, x1, y0, y1, node, src))
        items.sort(key=lambda it: it[0])
    # 收尾：剩余 item 组成行 —— 连续「简单」item 交给常规解析（上下标/矩阵），已合成的 item 直接作为节点
    result: list[tuple[float, dict]] = []
    buf: list[tuple[float, Tok]] = []

    def flush() -> None:
        if not buf:
            return
        for x, n in _row_items([t for _, t in buf], body, []):
            result.append((x, n))
        buf.clear()

    for x0, _x1, _y0, _y1, node, src in items:
        if node.get("k") == "text" and len(src) == 1:
            buf.append((x0, src[0]))
        else:
            flush()
            result.append((x0, node))
    flush()
    result.sort(key=lambda p: p[0])
    return {"k": "row", "items": [n for _, n in result]}


# --------------------------------------------------------------------------- #
# 渲染
# --------------------------------------------------------------------------- #
def _needs_space(a: str, b: str) -> bool:
    """只在两个「词」之间补空格，避免 T = \\{ \\tau_{1} 这类被空格撑散。"""
    return bool(a) and bool(b) and a[-1].isalnum() and b[0].isalnum()


def render(node: dict) -> str:
    k = node.get("k")
    if k == "text":
        return "".join(MATH_CMD.get(ch, LATEX_ESCAPE.get(ch, ch)) for ch in node.get("t", ""))
    if k == "row":
        out = ""
        for x in node.get("items", []):
            s = render(x)
            if not s:
                continue
            if _needs_space(out, s):
                out += " "
            out += s
        return out.strip()
    if k == "script":
        base = render(node.get("base") or {"k": "text", "t": ""})
        sub = node.get("sub")
        sup = node.get("sup")
        out = base
        if sub:
            out += "_{" + render(sub) + "}"
        if sup:
            out += "^{" + render(sup) + "}"
        return out
    if k == "frac":
        return "\\frac{" + render(node["num"]) + "}{" + render(node["den"]) + "}"
    if k == "root":
        idx = node.get("index")
        pre = "\\sqrt[" + render(idx) + "]" if idx else "\\sqrt"
        return pre + "{" + render(node["rad"]) + "}"
    if k == "op":
        sym = MATH_CMD.get(node.get("sym", ""), node.get("sym", ""))
        out = sym
        placement = node.get("placement")
        if placement == "above_below":
            if node.get("lower"):
                out += "\\limits_{" + render(node["lower"]) + "}"
            if node.get("upper"):
                out += "^{" + render(node["upper"]) + "}"
            return out
        # side / unknown：普通右侧上下标（**不加** \limits，避免改变原排版）
        if node.get("lower") or node.get("sub"):
            out += "_{" + render(node.get("lower") or node.get("sub")) + "}"
        if node.get("upper") or node.get("sup"):
            out += "^{" + render(node.get("upper") or node.get("sup")) + "}"
        return out
    if k == "matrix":
        d0, d1 = node.get("delim", ["(", ")"])
        env = "pmatrix" if (d0, d1) == ("(", ")") else "bmatrix" if (d0, d1) == ("[", "]") else "matrix"
        rows = " \\\\ ".join(" & ".join(render(c) for c in row) for row in node.get("rows", []))
        return "\\begin{" + env + "}" + rows + "\\end{" + env + "}"
    return ""


# --------------------------------------------------------------------------- #
# 质量标记 + 入口
# --------------------------------------------------------------------------- #
def _garble_ratio(s: str) -> float:
    if not s:
        return 1.0
    return len(_BAD_CHARS.findall(s)) / max(1, len(s))


def _tree_kinds(tree: dict) -> set[str]:
    kinds: set[str] = set()

    def walk(n: object) -> None:
        if isinstance(n, dict):
            kinds.add(str(n.get("k")))
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for x in n:
                walk(x)

    walk(tree)
    return kinds


def _detection_confidence(text: str, tree: dict, used_rule: bool) -> float:
    """这段内容「像不像公式」（与还原质量分开评分）。"""
    s = text.strip()
    if not s:
        return 0.0
    kinds = _tree_kinds(tree)
    score = 0.0
    if _OP_RE.search(s):
        score += 0.2
    if any(ch in s for ch in "=≈≤≥≠"):
        score += 0.2
    if kinds & {"frac", "root", "matrix", "op", "script"}:
        score += 0.25
    # 二维结构（分式/根号/矩阵）几乎必然是公式，即使原文里没有运算符
    if kinds & {"frac", "root", "matrix"}:
        score += 0.2
    if used_rule:
        score += 0.1
    if any(ch in s for ch in "∑∏∫∮√∂∇"):
        score += 0.35
    density = sum(1 for ch in s if ch in MATH_CMD)
    score += min(0.2, density * 0.08)
    if len(s) <= 30 and _OP_RE.search(s):
        score += 0.15
    if len(PROSE_WORD_RE.findall(s)) >= 2:
        score -= 0.3
    score -= _garble_ratio(s) * 0.8
    return max(0.0, min(1.0, score))


def _reconstruction_confidence(tree: dict, text: str, latex: str, rules: list[Rule], used_rules: int) -> float:
    kinds = _tree_kinds(tree)
    score = 0.5
    if kinds & {"frac", "root", "matrix", "op", "script"}:
        score += 0.3
    if "matrix" in kinds:
        score += 0.1
    if rules and used_rules < len(rules):
        score -= 0.2  # 有没用上的横线 → 可能漏了结构
    score -= _garble_ratio(text) * 0.8
    if not _MATHY_RE.search(latex or text):
        score -= 0.3
    return max(0.0, min(1.0, score))


def build_formula(lines: list[dict], draws: list | None, page_h: float, rect: list[float] | None) -> dict:
    """入口：返回 {latex, structure, rawText, detectionConfidence, reconstructionConfidence, status, extractorVersion}"""
    toks = tokens_from_lines(lines)
    raw = "".join(t.text for t in toks).strip()
    if not toks or not raw:
        return {
            "latex": None,
            "structure": None,
            "rawText": raw,
            "detectionConfidence": 0.0,
            "reconstructionConfidence": 0.0,
            "status": "failed",
            "extractorVersion": EXTRACTOR_VERSION,
        }
    body = max((t.size for t in toks), default=0.0) or 12.0
    rules = rules_from_draws(draws or [], page_h, rect)
    tree = build_tree(toks, rules, body)
    latex = render(tree).strip()
    latex = re.sub(r"\s*[（(]\s*\d+(?:\.\d+)*\s*[)）]\s*$", "", latex).strip()
    # \sqrt 后接单个字母/数字或括号组 → 补花括号（\sqrt 由 √ 映射而来）
    latex = re.sub(r"\\sqrt\s*([A-Za-z0-9])", r"\\sqrt{\1}", latex)
    latex = re.sub(r"\\sqrt\s*\(([^()]{1,40})\)", r"\\sqrt{\1}", latex)
    used = 1 if (_tree_kinds(tree) & {"frac", "root"}) else 0
    det = _detection_confidence(raw, tree, used_rule=bool(used))
    rec = _reconstruction_confidence(tree, raw, latex, rules, used)
    if det < DETECT_FLOOR or rec < 0.35:
        status = "failed"
    elif det >= DETECT_ACCEPT and rec >= RECON_ACCEPT:
        status = "accepted"
    else:
        status = "needs_review"
    if status == "failed" or not latex or not _MATHY_RE.search(latex):
        latex_out = None
    else:
        latex_out = latex
    return {
        "latex": latex_out,
        "structure": tree,
        "rawText": raw,
        "detectionConfidence": round(det, 3),
        "reconstructionConfidence": round(rec, 3),
        "status": status,
        "extractorVersion": EXTRACTOR_VERSION,
    }
