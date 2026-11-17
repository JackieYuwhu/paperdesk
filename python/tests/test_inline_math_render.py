"""行内公式写回 + 字号增量自测（离线、确定性）。

验证的是真实排版路径：_draw_inline_math_box 用 insert_htmlbox 生成 <sup>/<sub>，
_fit_text 的 size_delta 会真正改变落版字号。
运行：python tests/test_inline_math_render.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.translate import MIN_FONT_SIZE, _draw_inline_math_box, _fit_text  # noqa: E402

FAILED = []


def check(name, cond):
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}")
        FAILED.append(name)


def spans(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        for line in b.get("lines", []):
            for sp in line.get("spans", []):
                out.append(sp)
    return out


tmp = tempfile.mkdtemp(prefix="pd-inline-math-")
pdf = os.path.join(tmp, "page.pdf")

doc = fitz.open()
page = doc.new_page(width=420, height=240)
box = fitz.Rect(24, 24, 396, 140)

eff, bottom, overflow, unrep = _draw_inline_math_box(
    page, box, "learning rate alpha = 0.1 with x^{2} and y_{i} ≤ 0.05", 10.0, (0, 0, 0)
)
doc.save(pdf)
doc.close()

check("行内公式写入后返回有效字号", isinstance(eff, float) and eff >= MIN_FONT_SIZE)
check("行内公式不报告不可还原命令", unrep == [])

doc = fitz.open(pdf)
pg = doc[0]
text = pg.get_text("text")
check("正文写入", "learning" in text.lower() and "0.1" in text)
check("数学符号写入", "≤" in text)
check("上标基字符写入", "x" in text and "y" in text)

ss = spans(pg)
main = [s for s in ss if "learning" in s["text"] or "rate" in s["text"]]
sup = [s for s in ss if s["text"].strip() in ("2", "i")]
check("上标字号小于正文", bool(sup) and bool(main) and sup[0]["size"] < main[0]["size"] * 0.95)
if sup and main:
    # 上标基线应高于正文基线（PDF y 轴向下）
    check("上标基线抬升", sup[0]["origin"][1] < main[0]["origin"][1] - 0.5)
doc.close()

# 字号增量：同一段落，+1.5pt 后的落版字号必须更大（且不超过上限）
r = fitz.Rect(24, 24, 396, 200)
long_text = "The optimizer is trained with reinforcement learning " * 6
# 每次插入新页会让旧页对象失效，因此两份样本分别用独立文档
doc_a = fitz.open()
p1 = doc_a.new_page(width=420, height=240)
# 签名：_fit_text(page, rect, text, n_lines, max_h, orig_size, max_w, color, stats, min_size, angle, size_delta)
f0 = _fit_text(p1, r, long_text, 3, None, 10.0, None, (0, 0, 0), None, 4.0, 0.0, 0.0)
doc_a.close()
doc_b = fitz.open()
p2 = doc_b.new_page(width=420, height=240)
f1 = _fit_text(p2, r, long_text, 3, None, 10.0, None, (0, 0, 0), None, 4.0, 0.0, 1.5)
doc_b.close()
size0, size1 = float(f0[0]), float(f1[0])
check("字号增量使落版字号变大", float(size1) > float(size0))
check("字号增量后不低于最小字号", float(size1) >= MIN_FONT_SIZE - 0.01)

if FAILED:
    print(f"INLINE_MATH_RENDER_FAIL ({len(FAILED)})")
    sys.exit(1)
print("INLINE_MATH_RENDER_OK")
