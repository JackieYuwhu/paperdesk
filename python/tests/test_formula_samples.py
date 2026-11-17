"""公式结构重建的**人工核对样例集 + 准确率统计**。

覆盖：多行分式、嵌套、跨 span 括号、空矩阵单元格、乱码、运算符上下限、表格行（非公式）。
分别统计：
  * 检测准确率  detection：`是/不是公式` 判对的比例（用 status != failed 作为"判为公式"）
  * 结构还原准确率 reconstruction：期望 LaTeX 与实际输出一致的比例（仅对"是公式"的样例）
运行会打印准确率，并对关键指标设下限，防止悄悄退化。
"""

from __future__ import annotations

import os
import sys

import fitz

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.formula import build_formula  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {extra}")


def sp(text, size, x, y):
    return {"text": text, "size": size, "x": x, "y": y}


def line(*spans, rect=None):
    return {"spans": list(spans), "rect": rect}


def hline(x0, x1, y):
    return {"items": [("l", fitz.Point(x0, y), fitz.Point(x1, y))]}


# ---- 样例：name, lines, draws, page_h, rect, 是公式?, 期望 LaTeX（None=不产出）----
PAGE_H = 800.0


def R(y_top, y_bot, x0=50.0, x1=130.0):
    """底边原点的模块矩形（fitz 顶边原点 y_top..y_bot）"""
    return [x0, PAGE_H - y_bot, x1, PAGE_H - y_top]


SAMPLES = [
    (
        "多行分式",
        [line(sp("a+b", 12, 60, 100), rect=fitz.Rect(50, 90, 130, 104)),
         line(sp("c", 12, 70, 118), rect=fitz.Rect(50, 108, 130, 122))],
        [hline(52, 128, 106)],
        R(90, 122),
        True,
        "\\frac{a+b}{c}",
    ),
    (
        "上下标",
        [line(sp("x", 12, 50, 100), sp("2", 8, 58, 96), sp("+y", 12, 70, 100), sp("i", 8, 92, 104))],
        [],
        R(90, 110),
        True,
        "x^{2}+y_{i}",
    ),
    (
        "根号（单操作数）",
        [line(sp("√x", 12, 10, 50))],
        [],
        R(40, 60, 5, 60),
        True,
        "\\sqrt{x}",
    ),
    (
        "根号 + 跨 span 括号",
        [line(sp("√", 12, 10, 50), sp("(", 12, 20, 50), sp("a+b", 12, 26, 50), sp(")", 12, 56, 50))],
        [],
        R(40, 60, 5, 80),
        True,
        "\\sqrt{a+b}",
    ),
    (
        "运算符上下限（∑ 正上正下）",
        [line(sp("∑", 14, 60, 100), sp("n", 8, 62, 90), sp("i=1", 8, 58, 112))],
        [],
        R(80, 120),
        True,
        "\\sum\\limits_{i=1}^{n}",
    ),
    (
        "运算符右侧上下标（∑ 的 side 形式，不加 \\limits）",
        [line(sp("∑", 14, 60, 100), sp("i=1", 8, 78, 106), sp("n", 8, 78, 94))],
        [],
        R(80, 120, 55, 110),
        True,
        "\\sum_{i=1}^{n}",
    ),
    (
        "裸大型运算符（placement=unknown，不加 \\limits）",
        [line(sp("∑", 14, 60, 100), sp("x", 12, 80, 100))],
        [],
        R(80, 120, 55, 110),
        True,
        "\\sum x",
    ),
    (
        "积分右侧上下限（\\int_a^b）",
        [line(sp("∫", 14, 60, 100), sp("a", 8, 76, 106), sp("b", 8, 76, 94))],
        [],
        R(80, 120, 55, 105),
        True,
        "\\int_{a}^{b}",
    ),
    (
        "三行：分子占两行（多行分子）",
        [line(sp("x+y", 12, 60, 155)), line(sp("z", 12, 60, 172)),
         line(sp("c", 12, 65, 225))],
        [hline(45, 150, 200)],
        R(145, 240, 40, 160),
        True,
        "\\frac{x+y z}{c}",
    ),
    (
        "矩阵（含空单元格）",
        [line(
            sp("(", 14, 40, 100), sp("a", 12, 50, 96), sp("b", 12, 80, 96),
            sp("c", 12, 50, 116), sp(")", 14, 110, 100),
        )],
        [],
        R(85, 125, 35, 120),
        True,
        "\\begin{pmatrix}a & b \\\\ c & \\end{pmatrix}",
    ),
    (
        "简单等式",
        [line(sp("E=mc^2", 12, 50, 100))],
        [],
        R(90, 110),
        True,
        "E=mc^2",
    ),
    (
        "表格行（非公式）",
        [line(sp("Problem category Scheduling problems (n = 7)", 11, 50, 100))],
        [],
        R(90, 112),
        False,
        None,
    ),
    (
        "纯散文（非公式）",
        [line(sp("This is a normal sentence about the method.", 11, 50, 100))],
        [],
        R(90, 112),
        False,
        None,
    ),
    (
        "乱码（应保留原文、不产出）",
        [line(sp("\ufffd\ufffd\ufffd = \ufffd", 12, 50, 100))],
        [],
        R(90, 110),
        False,
        None,
    ),
    # ---- 嵌套分式 / 局部作用域（评审要求）----
    (
        "分子嵌套",
        [line(sp("a", 12, 65, 160)), line(sp("b", 12, 65, 188)), line(sp("c", 12, 70, 225))],
        [hline(45, 150, 200), hline(60, 120, 175)],
        R(145, 240, 40, 160),
        True,
        "\\frac{\\frac{a}{b}}{c}",
    ),
    (
        "分母嵌套",
        [line(sp("a", 12, 65, 180)), line(sp("b", 12, 65, 220)), line(sp("c", 12, 65, 250))],
        [hline(45, 150, 200), hline(60, 120, 235)],
        R(165, 265, 40, 160),
        True,
        "\\frac{a}{\\frac{b}{c}}",
    ),
    (
        "两侧同时嵌套",
        [line(sp("a", 12, 60, 160)), line(sp("b", 12, 60, 195)),
         line(sp("c", 12, 60, 225)), line(sp("d", 12, 60, 260))],
        [hline(45, 130, 210), hline(50, 110, 180), hline(50, 110, 245)],
        R(145, 275, 40, 140),
        True,
        "\\frac{\\frac{a}{b}}{\\frac{c}{d}}",
    ),
    (
        "局部作用域 a + 分式 = d",
        [line(sp("a+", 12, 20, 200)), line(sp("b", 12, 65, 180)),
         line(sp("c", 12, 65, 222)), line(sp("=d", 12, 120, 200))],
        [hline(60, 110, 200)],
        R(165, 235, 10, 150),
        True,
        "a+\\frac{b}{c}=d",
    ),
    (
        "减号/等号不误判为分式",
        [line(sp("a-b=c", 12, 50, 200))],
        [],
        R(190, 210),
        True,
        "a-b=c",
    ),
    (
        "宽横线（表格线）不误判为根号",
        [line(sp("row one", 11, 50, 300)), line(sp("row two", 11, 50, 320))],
        [hline(40, 500, 310)],
        R(290, 330, 35, 520),
        False,
        None,
    ),
    (
        "矩阵单元格复用表达式解析器（含上标）",
        [line(
            sp("(", 14, 40, 100), sp("x", 12, 50, 96), sp("2", 8, 58, 92),
            sp("c", 12, 80, 96), sp("d", 12, 50, 116), sp(")", 14, 110, 100),
        )],
        [],
        R(85, 125, 35, 120),
        True,
        "\\begin{pmatrix}x^{2} & c \\\\ d & \\end{pmatrix}",
    ),
    (
        "矩阵三行（多行稳健性）",
        [line(
            sp("(", 14, 40, 100), sp("a", 12, 50, 96), sp("b", 12, 90, 96),
            sp("c", 12, 50, 120), sp("d", 12, 90, 120),
            sp("e", 12, 50, 144), sp("f", 12, 90, 144), sp(")", 14, 130, 100),
        )],
        [],
        R(85, 155, 35, 140),
        True,
        "\\begin{pmatrix}a & b \\\\ c & d \\\\ e & f\\end{pmatrix}",
    ),
    (
        "嵌套矩阵（单元格里再放一个矩阵）",
        [line(
            sp("(", 16, 30, 100), sp("(", 14, 45, 100),
            sp("a", 12, 55, 90), sp("b", 12, 95, 90),
            sp("c", 12, 55, 110), sp("d", 12, 95, 110),
            sp(")", 14, 120, 100), sp("e", 12, 160, 100),
            sp(")", 16, 200, 100), sp("f", 12, 55, 170),
        )],
        [],
        R(80, 180, 25, 210),
        True,
        "\\begin{pmatrix}\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix} & e \\\\ f & \\end{pmatrix}",
    ),
]


def main() -> int:
    det_ok = 0
    det_total = 0
    rec_ok = 0
    rec_total = 0
    for name, lines, draws, rect, is_formula, want_latex in SAMPLES:
        out = build_formula(lines, draws, PAGE_H, rect)
        got_formula = out["status"] != "failed"
        det_total += 1
        if got_formula == is_formula:
            det_ok += 1
        else:
            print(f"  · 检测不符：{name} → status={out['status']} latex={out['latex']}")
        if is_formula:
            rec_total += 1
            ok = (out["latex"] or None) == want_latex
            if ok:
                rec_ok += 1
            else:
                print(f"  · 还原不符：{name}\n      期望 {want_latex!r}\n      实际 {out['latex']!r}")
            # 低置信度必须保留原文
            if out["status"] != "accepted":
                check(f"{name}：非 accepted 时保留原文", bool(out["rawText"]), str(out))
    det_acc = det_ok / max(1, det_total)
    rec_acc = rec_ok / max(1, rec_total)
    print(f"\n检测准确率 {det_ok}/{det_total} = {det_acc:.0%}")
    print(f"结构还原准确率 {rec_ok}/{rec_total} = {rec_acc:.0%}\n")
    check("检测准确率 ≥ 90%", det_acc >= 0.9, f"{det_acc:.0%}")
    check("结构还原准确率 ≥ 80%", rec_acc >= 0.8, f"{rec_acc:.0%}")
    print("FORMULA_SAMPLES_OK" if failed == 0 else f"FORMULA_SAMPLES_FAIL ({failed})")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
