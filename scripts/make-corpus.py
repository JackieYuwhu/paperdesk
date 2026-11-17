"""生成一套用于评估/回归的样例论文语料。

覆盖：单栏 / 双栏 / 扫描件（无文本层）/ 公式 / 中文。
用法：python scripts/make-corpus.py [输出目录]   （默认 samples/corpus）
"""

from __future__ import annotations

import os
import sys

import fitz  # PyMuPDF

TITLE_EN = "Layout Preserving Translation of Scientific Papers"
BODY_EN = [
    "We study layout preserving translation for scientific documents, where the",
    "position of every text block must be kept stable after translation. The system",
    "classifies blocks into body, headings, captions, formulas, references and",
    "margins, then translates only the blocks that carry natural language.",
    "Evaluation covers single column, two column, scanned and formula heavy papers.",
]
FORMULA_LINES = [
    "Attention(Q, K, V ) = softmax(QK^T / sqrt(d_k)) V",
    "L = 1/N * sum_i log p(y_i | x_i; theta)",
    "E = m c^2",
]
ZH_TITLE = "面向学术论文的保版式翻译"
ZH_BODY = [
    "本文研究科学文档的保版式翻译，要求译后每个文本块的位置保持稳定。",
    "系统会把文本块分类为正文、标题、图注、公式、参考文献与页边距，",
    "只对承载自然语言的块进行翻译，公式与参考文献默认保持原样。",
]


def _en_para(page: "fitz.Page", x: float, y0: float, width: float, lines: list[str]) -> float:
    y = y0
    for t in lines:
        page.insert_text((x, y), t, fontsize=10.5)
        y -= 15
    return y


def single(path: str) -> None:
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 760), TITLE_EN, fontsize=17)
    p.insert_text((72, 736), "A. Vaswani, N. Shazeer", fontsize=10)
    p.insert_text((72, 706), "Abstract", fontsize=13)
    _en_para(p, 72, 688, 460, BODY_EN)
    p.insert_text((72, 560), "1  Introduction", fontsize=13)
    _en_para(p, 72, 542, 460, BODY_EN)
    doc.set_metadata({"title": TITLE_EN, "author": "A. Vaswani; N. Shazeer"})
    doc.save(path)
    doc.close()


def two_column(path: str) -> None:
    doc = fitz.open()
    for pg in range(2):
        p = doc.new_page()
        if pg == 0:
            p.insert_text((72, 760), TITLE_EN, fontsize=16)
        else:
            p.insert_text((72, 760), "2  Method", fontsize=13)
        # 左栏 / 右栏
        _en_para(p, 72, 730, 230, BODY_EN)
        _en_para(p, 320, 730, 230, BODY_EN)
    doc.save(path)
    doc.close()


def scanned(path: str) -> None:
    """先渲染成位图，再放进新 PDF —— 结果没有文本层（模拟扫描件）。"""
    src = fitz.open()
    p = src.new_page()
    p.insert_text((72, 760), TITLE_EN, fontsize=17)
    _en_para(p, 72, 730, 460, BODY_EN)
    pix = p.get_pixmap(dpi=150)

    out = fitz.open()
    page = out.new_page(width=pix.width * 72 / 150, height=pix.height * 72 / 150)
    page.insert_image(page.rect, pixmap=pix)
    out.save(path)
    out.close()
    src.close()


def formula(path: str) -> None:
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 760), "3  Formulas", fontsize=13)
    y = 730
    for f in FORMULA_LINES:
        p.insert_text((120, y), f, fontsize=11)
        y -= 26
    _en_para(p, 72, y - 6, 460, BODY_EN)
    doc.save(path)
    doc.close()


def chinese(path: str) -> None:
    doc = fitz.open()
    p = doc.new_page()
    # PyMuPDF 内置 CJK 字体（有文本层）
    p.insert_text((72, 760), ZH_TITLE, fontsize=17, fontname="china-s")
    p.insert_text((72, 730), "摘要", fontsize=13, fontname="china-s")
    y = 710
    for t in ZH_BODY:
        p.insert_text((72, y), t, fontsize=11, fontname="china-s")
        y -= 18
    doc.set_metadata({"title": ZH_TITLE, "author": "测试作者"})
    doc.save(path)
    doc.close()


def long_paper(path: str, pages: int = 30) -> None:
    doc = fitz.open()
    for i in range(pages):
        p = doc.new_page()
        p.insert_text((72, 760), f"{i + 1}  Section {i + 1}", fontsize=13)
        _en_para(p, 72, 730, 460, BODY_EN)
    doc.save(path)
    doc.close()


BUILDERS = {
    "single": single,
    "two-column": two_column,
    "scanned": scanned,
    "formula": formula,
    "chinese": chinese,
}


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join("samples", "corpus")
    os.makedirs(out_dir, exist_ok=True)
    for name, fn in BUILDERS.items():
        p = os.path.join(out_dir, f"{name}.pdf")
        fn(p)
        print(f"生成 {name}: {p}")
    lp = os.path.join(out_dir, "long-30p.pdf")
    long_paper(lp, 30)
    print(f"生成 long-30p: {lp}")
    print("语料目录：", os.path.abspath(out_dir))


if __name__ == "__main__":
    main()
