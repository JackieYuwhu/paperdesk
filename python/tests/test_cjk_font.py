"""CJK 译文必须「嵌入字体」的回归测试。

背景：PyMuPDF 内置的 china-s 是**不嵌入**的 CID 字体，pdf.js 等查看器渲染为空白
（文字可抽取但看不见），导致「译文 PDF 全部文本丢失」。这里验证我们改用系统 CJK
字体并嵌入（+子集化）。

运行：python tests/test_cjk_font.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.translate import _fit_text, cjk_fontfile  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {extra}")


print("CJK 字体嵌入测试")
path = cjk_fontfile()
if not path:
    print("  SKIP  未找到系统 CJK 字体（如微软雅黑/Noto），跳过嵌入检查")
else:
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "cjk.pdf")
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        _fit_text(page, fitz.Rect(50, 50, 545, 300), "这是一段中文译文测试 ABC 123", 6)
        try:
            doc.subset_fonts()
        except Exception:  # noqa: BLE001
            pass
        doc.save(out, garbage=3, deflate=True, clean=True)
        doc.close()

        doc2 = fitz.open(out)
        fonts = doc2.get_page_fonts(0)
        pix = doc2[0].get_pixmap(dpi=72)
        samples = pix.samples
        nonwhite = sum(1 for i in range(0, len(samples), pix.n) if samples[i] < 240)
        doc2.close()

        check("检测到系统 CJK 字体", bool(path), str(path))
        check("页面上有字体", len(fonts) >= 1, str(fonts))
        embedded = any((f[1] not in ("n/a", "", None)) for f in fonts)
        check("CJK 字体已嵌入（ext 非 n/a）", embedded, str(fonts))
        check("页面渲染出文字（非空白）", nonwhite > 200, f"nonwhite={nonwhite}")

print("CJKFONT_OK" if failed == 0 else f"CJKFONT_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
