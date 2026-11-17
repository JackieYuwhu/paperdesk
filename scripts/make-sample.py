"""生成一篇样例论文 PDF，方便本地试用/测试。

用法：python scripts/make-sample.py [输出路径]
默认输出：samples/sample-paper.pdf
"""

from __future__ import annotations

import os
import sys

import fitz  # PyMuPDF

TITLE = "Attention Is All You Need"
AUTHORS = "Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit"

ABSTRACT = [
    "The dominant sequence transduction models are based on complex recurrent or",
    "convolutional neural networks that include an encoder and a decoder. The best",
    "performing models also connect the encoder and decoder through an attention",
    "mechanism. We propose a new simple network architecture, the Transformer, based",
    "solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
]

INTRO = [
    "Recurrent neural networks, long short-term memory and gated recurrent neural",
    "networks in particular, have been firmly established as state of the art approaches",
    "in sequence modeling and transduction problems such as language modeling and",
    "machine translation. Numerous efforts have since continued to push the boundaries",
    "of recurrent language models and encoder-decoder architectures.",
]

METHOD = [
    "The Transformer follows an encoder-decoder architecture using stacked self-attention",
    "and point-wise, fully connected layers. Scaled dot-product attention is used to compute",
    "the compatibility of a query with keys and to produce a weighted sum of values.",
]

FORMULA = "Attention(Q, K, V ) = softmax(QK^T / sqrt(d_k))V"

EXPERIMENTS = [
    "We trained the model on the WMT 2014 English-to-German translation task. Our model",
    "achieves 28.4 BLEU, improving over the best previously reported results by more than",
    "2 BLEU, establishing a new state of the art while training significantly faster.",
]

REFS = [
    "[1] Vaswani A, Shazeer N, Parmar N. Attention Is All You Need. NeurIPS, 2017. doi:10.48550/arXiv.1706.03762",
    "[2] He K, Zhang X, Ren S. Deep Residual Learning for Image Recognition. CVPR, 2016.",
]


def line(page, y, text, size=10.5, x=72):
    page.insert_text((x, y), text, fontsize=size)


def build(path: str) -> None:
    doc = fitz.open()

    p1 = doc.new_page()
    line(p1, 760, TITLE, 18)
    line(p1, 738, AUTHORS, 10.5)
    line(p1, 706, "Abstract", 13)
    y = 688
    for t in ABSTRACT:
        line(p1, y, t)
        y -= 15
    y -= 10
    line(p1, y, "1  Introduction", 13)
    y -= 18
    for t in INTRO:
        line(p1, y, t)
        y -= 15

    p2 = doc.new_page()
    line(p2, 760, "2  Model Architecture", 13)
    y = 738
    for t in METHOD:
        line(p2, y, t)
        y -= 15
    y -= 6
    line(p2, y, FORMULA, 11, x=140)  # 居中一点的公式行
    y -= 26
    line(p2, y, "3  Experiments", 13)
    y -= 18
    for t in EXPERIMENTS:
        line(p2, y, t)
        y -= 15
    y -= 10
    line(p2, y, "References", 13)
    y -= 18
    for t in REFS:
        line(p2, y, t)
        y -= 14

    doc.set_metadata({"title": TITLE, "author": "Ashish Vaswani; Noam Shazeer"})
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    doc.save(path)
    doc.close()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("samples", "sample-paper.pdf")
    build(out)
    print(f"已生成样例论文：{os.path.abspath(out)}")
