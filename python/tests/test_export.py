"""export.export_document 自测（md / html / pdf）。运行：python tests/test_export.py"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.export import export_document  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {extra}")


def make_pdf(path):
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 720), "Attention Is All You Need", fontsize=20)
    p.insert_text((72, 690), "Ashish Vaswani, Noam Shazeer", fontsize=11)
    p.insert_text((72, 640), "The dominant sequence transduction models are based on", fontsize=11)
    p.insert_text((72, 624), "complex recurrent or convolutional neural networks.", fontsize=11)
    p.insert_text((72, 580), "3  Model Architecture", fontsize=14)
    p.insert_text((72, 550), "Attention(Q, K, V ) = softmax(QK T / sqrt(d k ))V", fontsize=11)
    doc.save(path)
    doc.close()


print("export_document 测试")
with tempfile.TemporaryDirectory() as d:
    src = os.path.join(d, "src.pdf")
    make_pdf(src)

    md_path = os.path.join(d, "out.md")
    r_md = export_document(src, md_path, "md")
    md = open(md_path, encoding="utf-8").read()
    check("md 文件生成", os.path.exists(md_path))
    check("md 识别出标题(# )", "# Attention Is All You Need" in md, repr(md[:80]))
    check("md 识别出二级标题(## )", "## 3  Model Architecture" in md or "## 3 Model Architecture" in md, repr(md[:200]))
    check("md 保留公式块(```math)", "```math" in md and "softmax" in md, repr(md[-220:]))
    check("md 页数正确", r_md["pages"] == 1, str(r_md))

    html_path = os.path.join(d, "out.html")
    export_document(src, html_path, "html")
    html = open(html_path, encoding="utf-8").read()
    check("html 文件生成", os.path.exists(html_path))
    check("html 含公式容器且不重排", 'class="formula"' in html, repr(html[-300:]))
    check("html 含标题标签", "<h1>" in html, repr(html[:200]))

    pdf_path = os.path.join(d, "out.pdf")
    export_document(src, pdf_path, "pdf")
    ok_pdf = os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 500
    if ok_pdf:
        doc = fitz.open(pdf_path)
        pages = doc.page_count
        txt = doc[0].get_text()
        doc.close()
        check("pdf 文件生成且可打开", pages >= 1, f"pages={pages}")
        check("pdf 含正文文本", "Attention" in txt, repr(txt[:60]))
    else:
        check("pdf 文件生成且可打开", False, "文件缺失或过小")

    # MinerU 引擎：装了就走真实引擎，没装必须优雅回退（不能失败）
    fb_path = os.path.join(d, "out-mineru.md")
    r_fb = export_document(src, fb_path, "md", engine="mineru")
    if (r_fb.get("engine") or "") == "mineru":
        check("MinerU 引擎可用", os.path.exists(fb_path), str(r_fb))
    else:
        ok = os.path.exists(fb_path) and any("MinerU" in w for w in r_fb.get("warnings", []))
        check("MinerU 不可用时回退内置引擎并有提示", ok, str(r_fb))

print("EXPORT_OK" if failed == 0 else f"EXPORT_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
