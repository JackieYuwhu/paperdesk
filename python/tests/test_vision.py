"""视觉翻译 / 视觉元数据抽取的自测（用假的 chat_vision，完全离线）。

运行：python tests/test_vision.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app import vision  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {extra}")


# 用假的模型调用替换网络请求
def fake_chat(base_url, api_key, model, headers, prompt, images_b64, timeout=180.0):
    if "JSON" in prompt:
        return (
            '{"title":"Vision Title","authors":["Alice Zhang","Bob Li"],'
            '"abstract":"This is a vision abstract.","year":2020,'
            '"venue":"Vision Venue","doi":"10.1234/vision"}'
        )
    return "[ZH] 视觉译文内容"


vision.chat_vision = fake_chat


def make_pdf(path):
    doc = fitz.open()
    for i in range(2):
        p = doc.new_page()
        p.insert_text((72, 720), f"Scanned Page {i + 1}", fontsize=14)
    doc.save(path)
    doc.close()


print("vision 测试")
with tempfile.TemporaryDirectory() as d:
    pdf = os.path.join(d, "s.pdf")
    out = os.path.join(d, "s.zh.pdf")
    make_pdf(pdf)

    meta = vision.extract_metadata_vision(pdf, "http://x", "k", "m")
    check("视觉元数据：标题", meta["title"] == "Vision Title", str(meta))
    check("视觉元数据：作者", meta["authors"] == ["Alice Zhang", "Bob Li"], str(meta["authors"]))
    check("视觉元数据：摘要", bool(meta["abstract"]), str(meta))
    check("视觉元数据：年份", meta["year"] == 2020, str(meta))

    r = vision.translate_pdf_vision(pdf, out, "zh", "http://x", "k", "m")
    check("视觉翻译：页数", r["pages"] == 2, str(r))
    check("视觉翻译：引擎标注", r["engine"] == "vision", str(r))
    check("视觉翻译：输出文件存在", os.path.exists(out), out)
    if os.path.exists(out):
        doc = fitz.open(out)
        text = "".join(pg.get_text() for pg in doc)
        doc.close()
        check("视觉翻译：输出含译文", "译文" in text, text[:60])

    # ---- /vision/formula：只在含公式时才产出 LaTeX ----
    from app.main import FormulaImageRequest, vision_formula  # noqa: E402

    orig = vision.chat_vision
    try:
        vision.chat_vision = lambda *a, **k: '{"latex": "", "kind": "none", "note": "该图片不包含公式"}'
        r1 = vision_formula(FormulaImageRequest(imageB64="x"))
        check("公式识别：无公式图片 → kind=none 且 latex 为空", r1["kind"] == "none" and r1["latex"] == "", str(r1))

        vision.chat_vision = lambda *a, **k: '{"latex": "E = mc^2", "kind": "display", "note": null}'
        r2 = vision_formula(FormulaImageRequest(imageB64="x"))
        check("公式识别：含公式图片 → 返回 LaTeX", r2["latex"] == "E = mc^2" and r2["kind"] == "display", str(r2))
    finally:
        vision.chat_vision = orig

# ---- F01: 超长页不得静默空白；完整译文进 overflow ----
with tempfile.TemporaryDirectory() as d2:
    pdf2 = os.path.join(d2, "long.pdf")
    out2 = os.path.join(d2, "long.zh.pdf")
    doc = fitz.open()
    for _ in range(2):
        doc.new_page()
    doc.save(pdf2)
    doc.close()

    calls = {"n": 0}

    def fake_long(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return "长" * 50000
        return "[ZH] 正常页"

    orig = vision.chat_vision
    try:
        vision.chat_vision = fake_long
        r2 = vision.translate_pdf_vision(pdf2, out2, "zh", "http://x", "k", "m")
    finally:
        vision.chat_vision = orig

    check("F01: 只统计真正落版的页", r2["blocks"] == 1, str(r2.get("coverage")))
    check("F01: overflow 记账", r2["coverage"]["overflowPages"] == 1, str(r2.get("coverage")))
    check("F01: overflow 文件存在", bool(r2.get("overflowPath")) and os.path.exists(r2["overflowPath"]), str(r2.get("overflowPath")))
    check("F01: 有明确告警", any("过长" in w for w in r2.get("warnings", [])), str(r2.get("warnings")))
    doc = fitz.open(out2)
    p1 = doc[0].get_text()
    p2 = doc[1].get_text()
    doc.close()
    check("F01: 超长页不是空白（有提示）", "译文过长" in p1, repr(p1[:80]))
    check("F01: 普通页仍正常", "正常页" in p2, repr(p2[:80]))
    check("F01: 页数保持 1:1", fitz.open(out2).page_count == 2)

# ---- F03: 取消后不再调用模型，且不等待整批 ----
with tempfile.TemporaryDirectory() as d3:
    import threading

    pdf3 = os.path.join(d3, "cancel.pdf")
    out3 = os.path.join(d3, "cancel.zh.pdf")
    doc = fitz.open()
    for _ in range(3):
        doc.new_page()
    doc.save(pdf3)
    doc.close()

    started = threading.Event()
    release = threading.Event()
    state = {"cancel": False, "calls": 0, "err": ""}

    def fake_block(*a, **k):
        state["calls"] += 1
        if state["calls"] == 1:
            started.set()
            release.wait(8)
        return "[ZH] 不应继续调用"

    def run():
        try:
            vision.translate_pdf_vision(
                pdf3,
                out3,
                "zh",
                "http://x",
                "k",
                "m",
                is_cancelled=lambda: state["cancel"],
                max_workers=1,
            )
        except Exception as exc:  # noqa: BLE001
            state["err"] = str(exc)

    orig = vision.chat_vision
    try:
        vision.chat_vision = fake_block
        th = threading.Thread(target=run)
        th.start()
        check("F03: 首个请求已开始", started.wait(5))
        state["cancel"] = True
        release.set()
        th.join(10)
    finally:
        vision.chat_vision = orig

    check("F03: 取消后不再发起新请求", state["calls"] == 1, str(state))
    check("F03: 取消被明确报告", "取消" in state["err"], state["err"])
    check("F03: 取消后不产出成功 PDF", not os.path.exists(out3), out3)

print("VISION_OK" if failed == 0 else f"VISION_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
