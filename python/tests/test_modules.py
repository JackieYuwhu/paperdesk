"""结构化模块层测试：跨行断裂 / 双栏排版 / 编号与内容分离 / 图注绑定 / 参考文献映射。

构造一份合成 PDF（双栏 + 多行图注 + 表格 + 参考文献），断言模块化结果。
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.modules import _latex_from_lines, extract_modules  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {extra}")


def _build_pdf(path: str) -> None:
    doc = fitz.open()
    page = doc.new_page(width=600, height=800)
    # ---- 左栏：标题 + 三行正文 ----
    page.insert_text((50, 90), "1 Introduction", fontsize=14)
    page.insert_text((50, 120), "This is the first body line.", fontsize=11)
    page.insert_text((50, 136), "This is the second body line.", fontsize=11)
    page.insert_text((50, 152), "This is the third body line.", fontsize=11)
    # ---- 右栏：图形 + 跨两块的图注（跨行断裂）----
    page.draw_rect(fitz.Rect(330, 100, 540, 200), color=(0, 0, 0), fill=(0.9, 0.9, 0.95))
    page.draw_curve(
        fitz.Point(360, 180), fitz.Point(420, 110), fitz.Point(500, 180), color=(0, 0, 0)
    )
    page.insert_text((330, 235), "Fig. 1. A caption that spans", fontsize=9)
    page.insert_text((330, 249), "multiple lines here.", fontsize=9)
    # ---- 右栏：表格（3×2 网格）+ 上方表注 ----
    page.insert_text((330, 300), "Table 1. Results summary", fontsize=9)
    for y in (315, 345, 375, 405):
        page.draw_line(fitz.Point(330, y), fitz.Point(540, y), color=(0, 0, 0))
    for x in (330, 435, 540):
        page.draw_line(fitz.Point(x, 315), fitz.Point(x, 405), color=(0, 0, 0))
    # ---- 参考文献（编号与内容分离：[2] 的续行）----
    page.insert_text((50, 500), "References", fontsize=12)
    page.insert_text((50, 530), "[1] Author A. Title one.", fontsize=11)
    page.insert_text((50, 546), "[2] Author B. Title two", fontsize=11)
    page.insert_text((50, 560), "continued line of two.", fontsize=11)
    doc.save(path)
    doc.close()


def _build_pdf2(path: str) -> None:
    """位图插图（无矢量绘图）+ 无图形区域的题注 + 公式行。"""
    doc = fitz.open()
    page = doc.new_page(width=600, height=800)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 120, 90))
    pix.set_rect(pix.irect, (200, 220, 250))
    page.insert_image(fitz.Rect(100, 100, 400, 320), pixmap=pix)
    page.insert_text((100, 340), "Fig. 2. A raster figure caption.", fontsize=9)
    page.insert_text((100, 500), "Table 3. No drawing nearby.", fontsize=9)
    page.insert_text((100, 540), "Body text after the caption.", fontsize=11)
    page.insert_text((100, 620), "E = m c^2", fontsize=11)
    doc.save(path)
    doc.close()


_tmp = tempfile.mkdtemp(prefix="pd-modules-")
_pdf = os.path.join(_tmp, "sample.pdf")
_build_pdf(_pdf)

res = extract_modules(_pdf)
mods = res["modules"]
caps = res["captions"]
refs = res["refs"]

# ---- 双栏 ----
check("检测到双栏排版", res["columns"][0]["columns"] == 2, str(res["columns"]))

# ---- 图注：类型 + 编号 + 跨行合并 ----
fig_caps = [c for c in caps if c["kind"] == "figure" and c["n"] == 1]
check("识别到图注 Fig. 1", len(fig_caps) == 1, str(caps))
if fig_caps:
    fc = fig_caps[0]
    fig_mod = next((m for m in mods if m["id"] == fc["captionId"]), None)
    check(
        "图注跨行断裂已合并（含 multiple lines here）",
        bool(fig_mod) and "multiple lines here" in fig_mod["text"],
        str(fig_mod and fig_mod["text"]),
    )
    check("图注已绑定到图模块", fc["figureId"] is not None and fc["figureRect"] is not None, str(fc))

# ---- 表注：与图注区分（kind=table，编号 1）----
tbl_caps = [c for c in caps if c["kind"] == "table" and c["n"] == 1]
check("识别到表注 Table 1（与图注区分）", len(tbl_caps) == 1, str(caps))
if tbl_caps:
    tc = tbl_caps[0]
    check("表注绑定到 table 类型模块", tc["figureId"] is not None, str(tc))
    bound = next((m for m in mods if m["id"] == tc["figureId"]), None)
    check("绑定目标类型为 table", bool(bound) and bound["type"] == "table", str(bound))
check("存在 table 模块", any(m["type"] == "table" for m in mods), "")
check("存在 figure 模块", any(m["type"] == "figure" for m in mods), "")

# ---- 编号与内容分离：正文引用编号 ↔ 文末条目 ----
check("参考文献条目数为 2", len(refs) == 2, str(refs))
by_n = {r["n"]: r for r in refs}
check("[1] 条目正文正确", "Title one" in by_n.get(1, {}).get("text", ""), str(by_n.get(1)))
check(
    "[2] 续行已合并（continued line of two）",
    "continued line of two" in by_n.get(2, {}).get("text", ""),
    str(by_n.get(2)),
)
check("参考文献有页码定位", all(r["page"] == 1 for r in refs), str(refs))

# ---- 段落未被误判为标题（正文字号加权后应识别为 paragraph）----
body_mods = [m for m in mods if m["type"] == "paragraph"]
check(
    "正文识别为段落（非标题）",
    len(body_mods) >= 1 and any("first body line" in m["text"] for m in body_mods),
    str([m["text"] for m in body_mods]),
)
check(
    "段落与标题分开（标题不吞正文）",
    not any(m["type"] == "section" and "first body line" in m["text"] for m in mods),
    str([m["text"] for m in mods if m["type"] == "section"]),
)

# ---- 章节识别 ----
check("识别到章节标题", any(m["type"] == "section" for m in mods), "")

# ---- 警告可读 ----
check("返回 warnings 列表", isinstance(res["warnings"], list), str(res["warnings"]))

# ---- 位图插图 / 合成兜底绑定 / 公式模块 ----
_pdf2 = os.path.join(_tmp, "sample2.pdf")
_build_pdf2(_pdf2)
res2 = extract_modules(_pdf2)
caps2 = {c["n"]: c for c in res2["captions"]}
check("位图插图的题注 Fig. 2 已识别", 2 in caps2, str(list(caps2)))
check("位图插图题注已绑定（靠 image block）", bool(caps2.get(2, {}).get("figureId")), str(caps2.get(2)))
check(
    "无图形区域时题注仍绑定（合成兜底，可回退查看）",
    bool(caps2.get(3, {}).get("figureId")),
    str(caps2.get(3)),
)
check("存在 formula 模块", len(res2["formulas"]) >= 1, str(res2["formulas"][:3]))
check(
    "formula 带页码/坐标（供按需识别）",
    all(isinstance(f["page"], int) and len(f["rect"]) == 4 for f in res2["formulas"]),
    str(res2["formulas"][:2]),
)
check(
    "公式 LaTeX：源文件可直接提取时标记 extracted（无需模型）",
    any(f["latexSource"] == "extracted" and f["latex"] for f in res2["formulas"]),
    str(res2["formulas"][:3]),
)

# ---- LaTeX 直接提取：上标/下标 + Unicode 数学符号 → LaTeX ----
_latex_lines = [
    {
        "spans": [
            {"text": "x", "size": 12.0, "x": 50.0, "y": 100.0},
            {"text": "2", "size": 8.0, "x": 58.0, "y": 96.0},  # 上标（更小 + 更高）
            {"text": " + y", "size": 12.0, "x": 64.0, "y": 100.0},
            {"text": "i", "size": 8.0, "x": 92.0, "y": 104.0},  # 下标（更小 + 更低）
        ]
    }
]
_extracted = _latex_from_lines(_latex_lines)
check("LaTeX 提取：上标 → ^{...}", bool(_extracted) and "^{2}" in _extracted, str(_extracted))
check("LaTeX 提取：下标 → _{...}", bool(_extracted) and "_{i}" in _extracted, str(_extracted))
_sym = _latex_from_lines(
    [{"spans": [{"text": "∑", "size": 12.0, "x": 10.0, "y": 50.0}, {"text": " α = 1", "size": 12.0, "x": 20.0, "y": 50.0}]}]
)
check(
    "LaTeX 提取：Unicode 符号映射为命令",
    bool(_sym) and r"\sum" in _sym and r"\alpha" in _sym,
    str(_sym),
)
check("LaTeX 提取：非数学文本返回 None", _latex_from_lines([{"spans": [{"text": "hello world", "size": 12.0, "x": 1.0, "y": 1.0}]}]) is None)

# ---- 分式还原：两行 + 中间分数线 → \frac ----
_frac_lines = [
    {"spans": [{"text": "a+b", "size": 12.0, "x": 60.0, "y": 100.0}], "rect": fitz.Rect(50, 90, 130, 104)},
    {"spans": [{"text": "c", "size": 12.0, "x": 70.0, "y": 118.0}], "rect": fitz.Rect(50, 108, 130, 122)},
]
_frac_draws = [{"items": [("l", fitz.Point(52, 106), fitz.Point(128, 106))]}]
_frac = _latex_from_lines(_frac_lines, _frac_draws, 800.0, [50, 800 - 122, 130, 800 - 90])
check("LaTeX 提取：两行 + 分数线 → \\frac{上}{下}", _frac == "\\frac{a+b}{c}", str(_frac))
_no_bar = _latex_from_lines(_frac_lines, [], 800.0, [50, 800 - 122, 130, 800 - 90])
check(
    "LaTeX 提取：无分数线则不还原为 \\frac",
    not (_no_bar or "").startswith("\\frac"),
    str(_no_bar),
)

# ---- \sqrt 补花括号 ----
_sq = _latex_from_lines(
    [{"spans": [{"text": "√x", "size": 12.0, "x": 10.0, "y": 50.0}]}]
)
check("LaTeX 提取：√x → \\sqrt{x}", bool(_sq) and "\\sqrt{x}" in _sq, str(_sq))

# ---- 公式判定更严：含等号的表格行/正文行不再误判 ----
from app.modules import _is_equation_like  # noqa: E402

check(
    "_is_equation_like：表格行（含两个 = 的英文短语）不再误判",
    _is_equation_like("Problem category Scheduling problems (n = 7) Routing and graphs (n = 6)") is False,
)
check("_is_equation_like：'Gurobi 30 min' 不再误判", _is_equation_like("Gurobi 30 min") is False)
check("_is_equation_like：真公式仍通过", _is_equation_like("E = m c^2") is True)
check("_is_equation_like：希腊字母公式通过", _is_equation_like("T = {τ1, τ2,..., τK}") is True)
for _p in (_pdf2,):
    try:
        os.remove(_p)
    except OSError:
        pass

# ---- 跨页参考文献续行 + 页眉不并入 ----
_pdf3 = os.path.join(_tmp, "sample3.pdf")
_d3 = fitz.open()
_p1 = _d3.new_page(width=600, height=800)
_p1.insert_text((50, 100), "References", fontsize=12)
_p1.insert_text((50, 130), "[1] Author A. Title one.", fontsize=11)
_p1.insert_text((50, 146), "[2] Author B. A long title that", fontsize=11)
_p2 = _d3.new_page(width=600, height=800)
_p2.insert_text((50, 30), "Journal of Testing 12 (2020) 1-20", fontsize=9)  # 页眉
_p2.insert_text((50, 120), "continues onto the next page.", fontsize=11)  # [2] 的续行
_p2.insert_text((50, 150), "[3] Author C. Title three.", fontsize=11)
_d3.save(_pdf3)
_d3.close()
res3 = extract_modules(_pdf3)
refs3 = {r["n"]: r for r in res3["refs"]}
check("跨页：参考文献条目仍在（1/2/3）", sorted(refs3) == [1, 2, 3], str(sorted(refs3)))
check(
    "跨页：上一页末尾条目吸收下一页续行",
    "continues onto the next page" in refs3.get(2, {}).get("text", ""),
    str(refs3.get(2)),
)
check(
    "页眉不被并入参考文献条目",
    all("Journal of Testing" not in r.get("text", "") for r in res3["refs"]),
    str([r["text"][:40] for r in res3["refs"]]),
)
try:
    os.remove(_pdf3)
except OSError:
    pass

try:
    os.remove(_pdf)
    os.rmdir(_tmp)
except OSError:
    pass

print("MODULES_OK" if failed == 0 else f"MODULES_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
