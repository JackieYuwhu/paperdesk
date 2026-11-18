"""simple_translate 自测（离线、确定性）。运行：python tests/test_translate.py"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.translate import (  # noqa: E402
    MIN_FONT_SIZE,
    _align_segments,
    _classify_block,
    _fit_text,
    _formula_text_only,
    _line_is_formula_only,
    _split_formula_lines,
    _figure_regions,
    _latex_to_plain,
    _link_for_rect,
    _linkify_html,
    _looks_like_icon,
    _is_appendix_heading,
    _looks_like_reference_page,
    _mask_math,
    _merge_flat_paragraphs,
    _page_roles_from_texts,
    _page_verdict,
    _pick_text_color,
    _restore_math,
    _role_hint,
    _sanitize_text,
    _segments,
    build_chunk_plan,
    group_translation_items,
    has_cjk,
    pick_batch_size,
    plan_chunks,
    simple_translate,
    translate_text,
)

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
    p1 = doc.new_page()
    p1.insert_text((72, 40), "Journal of Tests - Vol 1", fontsize=9)  # 页眉（应不翻译）
    p1.insert_text((72, 720), "Layout Preserving Translation", fontsize=18)
    p1.insert_text((72, 690), "Second paragraph on page one.", fontsize=11)
    p1.insert_text((72, 660), "Inline math $x_i^2$ and \\(y_j\\) in the body.", fontsize=11)
    p1.insert_text((72, 630), "a_i = b^2", fontsize=11)  # 独立公式块（应逐字保留、独立成块）
    # 内嵌小图 + 图题注（用于「可重排阅读区」图表原图内嵌与题注标记）
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 48, 48))
    pix.clear_with(200)
    p1.insert_image(fitz.Rect(300, 480, 360, 540), pixmap=pix)
    p1.insert_text((72, 580), "Figure 1. Test figure caption.", fontsize=10)
    p2 = doc.new_page()
    p2.insert_text((72, 40), "Journal of Tests - Vol 1", fontsize=9)
    p2.insert_text((72, 720), "Page two body text.", fontsize=11)
    p2.insert_text((72, 600), "References", fontsize=14)
    p2.insert_text((72, 576), "1. Smith J. Deep Residual Learning. 2016.", fontsize=11)
    doc.save(path)
    doc.close()


# ---------------------------------------------------------------------------
# 视觉质量回归：两栏正文 / 公式 / 图（矢量与位图）/ 网页公式结构
# ---------------------------------------------------------------------------

W, H = 595.0, 842.0
LX0, LX1 = 60.0, 288.0
RX0, RX1 = 307.0, 535.0


def _span_list(pdf):
    """返回 [(pno, rect, size, text)]，只含文本 span。"""
    doc = fitz.open(pdf)
    out = []
    for pno, page in enumerate(doc):
        for b in page.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue
            for ln in b.get("lines", []):
                for s in ln.get("spans", []):
                    out.append((pno, fitz.Rect(s["bbox"]), float(s["size"]), s["text"]))
    doc.close()
    return out


def _real_overlaps(spans):
    """真实重叠计数：并集面积 > 较窄者 25%（排除相邻行的正常轻微交叠）。"""
    import itertools

    n = 0
    by_page = {}
    for pno, r, _sz, _t in spans:
        by_page.setdefault(pno, []).append(r)
    for rects in by_page.values():
        for a, b in itertools.combinations(rects, 2):
            inter = a & b
            if inter.is_valid and inter.get_area() > 0.25 * min(a.get_area(), b.get_area()):
                n += 1
    return n


def _para(page, x0, x1, y0, text, size=10.5, lh=1.2):
    """用足够高的盒子插入一段（不裁切），返回结束 y。"""
    page.insert_textbox(fitz.Rect(x0, y0 - size, x1, y0 + size * 40), text, fontsize=size, lineheight=lh)
    # 估算用于排版后续块
    est_lines = max(1, int(len(text) / max(1.0, (x1 - x0) / (size * 0.5))) + 1)
    return y0 + est_lines * size * lh


def make_two_col_pdf(path):
    """两栏正文 + 公式 + 位图图 + 图题注；第 2 页参考文献。"""
    doc = fitz.open()
    p = doc.new_page(width=W, height=H)
    p.insert_text((LX0, 40), "Journal of Layout Tests, Vol. 7 (2026)", fontsize=8)
    p.insert_text((LX0, 70), "Two-Column Typesetting and Translation", fontsize=16)
    p.insert_text((LX0, 90), "Alice Z. Author, Bob Y. Writer", fontsize=10)
    _para(
        p, LX0, RX1, 128,
        "We evaluate typographic fidelity after machine translation of academic PDFs, "
        "with two columns of body text and careful measurement of glyph placement.",
        size=9.5,
    )
    _para(
        p, LX0, LX1, 185,
        "Introduction. Layout preserving translation keeps the original coordinates of "
        "every text block and overwrites the source glyphs with the target glyphs in the "
        "same rectangle, which is convenient but often leads to over-shrunk type when the "
        "target string becomes longer than the source string in a narrow column.",
        size=10.5,
    )
    _para(
        p, RX0, RX1, 185,
        "Related work. Earlier systems repaginate the whole document, which makes the "
        "source and target correspondence hard to maintain and breaks page level sync.",
        size=10.5,
    )
    # 独立公式块（应逐字保留、不翻译）
    p.insert_text((RX0 + 10, 330), "E = m c^2 + \\sum_i x_i", fontsize=10.5)
    # 位图图 + 图题注
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 60))
    pix.clear_with(180)
    fig_rect = fitz.Rect(RX0, 350, RX0 + 120, 350 + 120)
    p.insert_image(fig_rect, pixmap=pix)
    p.insert_text((RX0, 484), "Figure 1. A schematic of the proposed pipeline.", fontsize=9)
    # 第 2 页
    p2 = doc.new_page(width=W, height=H)
    p2.insert_text((LX0, 40), "Journal of Layout Tests, Vol. 7 (2026)", fontsize=8)
    p2.insert_text((LX0, 70), "References", fontsize=13)
    p2.insert_text((LX0, 95), "1. Smith J. Deep Residual Learning. 2016.", fontsize=10)
    p2.insert_text((LX0, 115), "2. Doe A. Reflow and Typesetting. 2020.", fontsize=10)
    doc.save(path)
    doc.close()
    return fig_rect


def make_cramped_pdf(path):
    """两栏「拥挤」案例：窄栏 + 上下夹紧的固定图，迫使字号下调。"""
    doc = fitz.open()
    p = doc.new_page(width=W, height=H)
    p.insert_text((60, 40), "Cramped Journal", fontsize=8)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 40))
    pix.clear_with(150)
    text = (
        "In machine translation the target language often needs more characters than "
        "the source and a narrow two column layout leaves very little room so the engine "
        "may reduce the point size below a comfortable reading threshold."
    )
    for x0, x1 in ((LX0, LX1), (RX0, RX1)):
        p.insert_image(fitz.Rect(x0, 55, x0 + 60, 90), pixmap=pix)
        p.insert_textbox(fitz.Rect(x0, 96, x1, 196), text, fontsize=9, lineheight=1.2)
        p.insert_image(fitz.Rect(x0, 199, x0 + 60, 234), pixmap=pix)
        p.insert_text((x0, 252), "Figure 1. Cramped figure.", fontsize=8)
    doc.save(path)
    doc.close()


def make_vector_fig_pdf(path):
    """含「矢量图形（形状+文字）」：图形内文字不得翻译/覆盖。"""
    doc = fitz.open()
    p = doc.new_page(width=W, height=H)
    p.insert_text((60, 60), "A Paper With a Vector Diagram", fontsize=16)
    p.draw_rect(fitz.Rect(120, 140, 220, 180))
    p.draw_rect(fitz.Rect(120, 240, 220, 280))
    p.draw_circle((300, 210), 26)
    p.draw_line((170, 180), (170, 240))
    p.draw_line((220, 210), (274, 210))
    p.insert_text((138, 165), "Input", fontsize=10)          # 图形内标签
    p.insert_text((132, 265), "Process", fontsize=10)         # 图形内标签
    p.insert_text((288, 214), "Out", fontsize=10)             # 图形内标签
    p.insert_text((120, 320), "Figure 1. Pipeline of the proposed method.", fontsize=9)  # 图形外题注
    p.insert_text((60, 370), "This is regular body text that should be translated.", fontsize=11)
    doc.save(path)
    doc.close()
    return fitz.Rect(115, 135, 330, 285)  # 图形包围区域


def make_display_math_pdf(path):
    """整块 LaTeX（$...$）公式 + 含 HTML 特殊字符的正文。"""
    doc = fitz.open()
    p = doc.new_page(width=W, height=H)
    p.insert_text((60, 80), "Display Math Paper", fontsize=16)
    p.insert_text((60, 130), "$E = mc^2 + \\sum_i x_i$", fontsize=12)  # 整块公式
    p.insert_text((60, 180), "Angles use < and > symbols & ampersands.", fontsize=11)
    doc.save(path)
    doc.close()


print("simple_translate 测试")
with tempfile.TemporaryDirectory() as d:
    src = os.path.join(d, "src.pdf")
    out = os.path.join(d, "out.zh.pdf")
    make_pdf(src)
    r = simple_translate(src, out, target_lang="zh", backend="mock")

    check("输出文件存在", os.path.exists(out))
    check("引擎=simple", r["engine"] == "simple", str(r))
    check("页数保持", r["pages"] == 2, f"pages={r['pages']}")
    check("有翻译块", r["blocks"] >= 3, f"blocks={r['blocks']}")
    check("布局/图片保留（文件可再打开）", True)

    qa = r.get("qa") or {}
    check("质量自检存在", isinstance(qa, dict) and qa.get("total", 0) >= 3, str(qa))
    check(
        "质量自检含已译/跳过/明细字段",
        "translated" in qa and "skipped" in qa and isinstance(qa.get("items"), list),
        str(qa),
    )
    check("质量自检含引用一致性字段", "citationMismatch" in qa, str(qa))

    doc = fitz.open(out)
    txt = "\n".join(pg.get_text() for pg in doc)
    page_count = doc.page_count
    doc.close()
    check("译文页数一致", page_count == 2, f"pages={page_count}")
    check("译文含标记 [ZH]", "[ZH]" in txt, repr(txt[:80]))
    check(
        "覆盖而非叠加（原句只出现一次且带译文标记）",
        txt.count("Layout Preserving Translation") == 1
        and "[ZH] Layout Preserving Translation" in txt,
        repr(txt[:160]),
    )
    check(
        "页眉区域不翻译（保持原样）",
        "Journal of Tests - Vol 1" in txt and "[ZH] Journal of Tests" not in txt,
        repr(txt[:200]),
    )
    check(
        "参考文献条目（1. … 年份）不翻译",
        "Deep Residual Learning" in txt and "[ZH] 1. Smith" not in txt,
        repr(txt[-200:]),
    )

    # 中文插入能力（真实 CJK 路径）
    cjk_out = os.path.join(d, "cjk.pdf")
    r2 = simple_translate(src, cjk_out, target_lang="zh-cjk", backend="mock")
    doc = fitz.open(cjk_out)
    cjk_txt = "\n".join(pg.get_text() for pg in doc)
    doc.close()
    check("CJK 字体路径可用（has_cjk 判定）", has_cjk("[ZH] 测试"), "has_cjk")
    check(
        "HTML 译文已移除：不再返回 htmlPath/bilingualPath",
        r2.get("htmlPath") is None and r2.get("bilingualPath") is None,
        str({k: r2.get(k) for k in ("htmlPath", "bilingualPath")}),
    )

    # Markdown 导出
    md = os.path.join(d, "out.zh.md")
    bimd = os.path.join(d, "out.bi.md")
    simple_translate(src, os.path.join(d, "md.zh.pdf"), target_lang="zh", backend="mock", md_out=md, bilingual_md_out=bimd)
    md_text = open(md, encoding="utf-8").read() if os.path.exists(md) else ""
    bimd_text = open(bimd, encoding="utf-8").read() if os.path.exists(bimd) else ""
    check("生成译文 Markdown", "[ZH]" in md_text, md_text[:60])
    check("生成对照 Markdown", "> Layout Preserving Translation" in bimd_text, bimd_text[:60])

    # ---- 分块计划纯函数（全局并行提速的核心） ----
    check(
        "plan_chunks 按 batch 切块",
        plan_chunks([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]],
        str(plan_chunks([1, 2, 3, 4, 5], 2)),
    )
    check("plan_chunks 空列表 -> 空", plan_chunks([], 2) == [], str(plan_chunks([], 2)))
    check(
        "plan_chunks batch<=0 视为不切（整段一块）",
        plan_chunks([1, 2, 3], 0) == [[1, 2, 3]],
        str(plan_chunks([1, 2, 3], 0)),
    )

    p = build_chunk_plan([("body", "S1", [1, 2, 3]), ("heading", "S2", [4])], 2)
    check(
        "build_chunk_plan 展开所有组的所有块",
        [it["indices"] for it in p] == [[1, 2], [3], [4]],
        str(p),
    )
    check(
        "build_chunk_plan 保持原顺序并附带 key/system",
        [it["key"] for it in p] == ["body", "body", "heading"]
        and [it["system"] for it in p] == ["S1", "S1", "S2"],
        str(p),
    )

    # ---- 调度优化：按类型分组（不按章节拆组）+ 一波发完的批大小 ----
    _g = group_translation_items(
        ["body", "body", "heading"], ["sec-1", "sec-2", "sec-2"], [False] * 3, False
    )
    check(
        "默认按类型分组（不按章节拆组，否则请求数被章节数放大）",
        _g == [(("body", ""), [0, 1]), (("heading", ""), [2])],
        str(_g),
    )
    _g2 = group_translation_items(["body", "body"], ["sec-1", "sec-2"], [False] * 2, True)
    check("自定义 prompt 用到 {section} 时仍按章节拆组", len(_g2) == 2, str(_g2))
    _g3 = group_translation_items(["body"] * 3, ["", "", ""], [False, True, False], False)
    check("保护块不进翻译分组", _g3 == [(("body", ""), [0, 2])], str(_g3))

    check(
        "pick_batch_size：一波发完且批尽量小",
        pick_batch_size([81, 16, 12, 8], 24) == 6,
        str(pick_batch_size([81, 16, 12, 8], 24)),
    )
    check("pick_batch_size：小文档可退到单段批", pick_batch_size([5], 24) == 1, "")
    check("pick_batch_size：超大批量有上限", pick_batch_size([1000], 24) == 16, "")
    check("pick_batch_size：空分组返回 1", pick_batch_size([], 24) == 1, "")

    # ---- 翻译请求：默认关闭思考；服务端拒绝该参数时自动降级 ----
    import json as _json

    import app._http as _hu
    import app.translate as _TRX

    class _Resp:
        def __init__(self, status, payload):
            self.status_code = status
            self.text = payload if isinstance(payload, str) else _json.dumps(payload)

        def json(self):
            return _json.loads(self.text)

    _orig_post = _hu.post
    _orig_unsupported = _TRX._NO_THINK_UNSUPPORTED
    try:
        _seen = []

        def _post_ok(url, json=None, headers=None, timeout=None):
            _seen.append(json)
            return _Resp(200, {"choices": [{"message": {"content": '["译1","译2"]'}}]})

        _hu.post = _post_ok
        _TRX._NO_THINK_UNSUPPORTED = False
        _out = _TRX._openai_translate_many(
            ["a", "b"], "zh", "http://x/v1", "k", "m", ids=["p1", "p2"]
        )
        check("批量翻译返回等长结果", _out == ["译1", "译2"], str(_out))
        check(
            "翻译请求默认关闭思考",
            bool(_seen) and _seen[0].get("thinking") == {"type": "disabled"},
            str(_seen[0].get("thinking") if _seen else None),
        )

        _seen.clear()
        _TRX._NO_THINK_UNSUPPORTED = False
        _TRX._openai_translate_many(["a"], "zh", "http://x/v1", "k", "m", no_think=False)
        check("no_think=False 时不发送 thinking", "thinking" not in _seen[0], str(_seen[0].keys()))

        _seen.clear()
        _queue = [
            _Resp(400, {"error": {"message": "Unsupported parameter: thinking"}}),
            _Resp(200, {"choices": [{"message": {"content": '["ok"]'}}]}),
        ]

        def _post_fallback(url, json=None, headers=None, timeout=None):
            _seen.append(json)
            return _queue.pop(0) if _queue else _post_ok(url, json, headers, timeout)

        _hu.post = _post_fallback
        _TRX._NO_THINK_UNSUPPORTED = False
        _out2 = _TRX._openai_translate_many(["a"], "zh", "http://x/v1", "k", "m")
        check(
            "服务端拒绝 thinking 时自动去掉并重试",
            _out2 == ["ok"] and len(_seen) == 2 and "thinking" in _seen[0]
            and "thinking" not in _seen[1],
            f"{_out2} calls={len(_seen)}",
        )
        check("降级后进程内记住不再发送 thinking", _TRX._NO_THINK_UNSUPPORTED is True, "")
    finally:
        _hu.post = _orig_post
        _TRX._NO_THINK_UNSUPPORTED = _orig_unsupported

    # 无关的 400（例如 max_tokens 不支持）不能被误判成「thinking 参数被拒」
    _seen_bad = []
    _orig_post_bad = _hu.post
    _orig_unsup_bad = _TRX._NO_THINK_UNSUPPORTED
    try:
        def _post_bad(url, json=None, headers=None, timeout=None):
            _seen_bad.append(json)
            return _Resp(400, {"error": {"message": "Unsupported parameter: max_tokens"}})

        _hu.post = _post_bad
        _TRX._NO_THINK_UNSUPPORTED = False
        _raised = False
        try:
            _TRX._openai_translate_many(["a"], "zh", "http://x/v1", "k", "m")
        except Exception:  # noqa: BLE001
            _raised = True
        check(
            "无关 400 不误判为 thinking 参数被拒",
            _raised
            and _TRX._NO_THINK_UNSUPPORTED is False
            and bool(_seen_bad)
            and all("thinking" in b for b in _seen_bad),
            f"raised={_raised} unsupported={_TRX._NO_THINK_UNSUPPORTED} calls={len(_seen_bad)}",
        )
    finally:
        _hu.post = _orig_post_bad
        _TRX._NO_THINK_UNSUPPORTED = _orig_unsup_bad

    # 术语抽取也走同一条降级路径（否则 strict 服务端会让术语表永远为空）
    _seen_gl = []
    _orig_post_gl = _hu.post
    _orig_unsup_gl = _TRX._NO_THINK_UNSUPPORTED
    try:
        _queue_gl = [
            _Resp(400, {"error": {"message": "Unsupported parameter: thinking"}}),
            _Resp(
                200,
                {"choices": [{"message": {"content": '[{"en":"layout","zh":"版式"}]'}}]},
            ),
        ]

        def _post_gl(url, json=None, headers=None, timeout=None):
            _seen_gl.append(json)
            return _queue_gl.pop(0)

        _hu.post = _post_gl
        _TRX._NO_THINK_UNSUPPORTED = False
        _terms_gl = _TRX.extract_glossary(
            "layout preserving translation of scientific documents",
            "zh",
            "http://x/v1",
            "k",
            "m",
            cache_dir=os.path.join(d, "gloss-cache"),
        )
        check(
            "术语抽取拒绝 thinking 时自动去掉并重试",
            _terms_gl == [("layout", "版式")]
            and len(_seen_gl) == 2
            and "thinking" in _seen_gl[0]
            and "thinking" not in _seen_gl[1],
            f"{_terms_gl} calls={len(_seen_gl)}",
        )
    finally:
        _hu.post = _orig_post_gl
        _TRX._NO_THINK_UNSUPPORTED = _orig_unsup_gl

    # ---- 术语表：自动抽取的术语进入 system prompt，且不阻塞翻译 ----
    _orig_gloss = _TRX.extract_glossary
    _orig_many_g = _TRX._openai_translate_many
    _systems = []
    try:
        def _gloss_fake(sample, lang, base, key, model, headers=None, cache_dir=None, limit=24):
            return [("layout", "版式"), ("translation", "翻译")]

        def _many_fake(texts, *a, **k):
            _systems.append(k.get("system") or "")
            return list(texts)

        _TRX.extract_glossary = _gloss_fake
        _TRX._openai_translate_many = _many_fake
        _res_g = _TRX.simple_translate(
            src,
            os.path.join(d, "glossary.zh.pdf"),
            "zh",
            "openai",
            base_url="http://x/v1",
            api_key="k",
            model="m",
        )
        check(
            "术语表进入翻译 system prompt",
            bool(_systems) and any("layout=版式" in s for s in _systems),
            str(_systems[:1]),
        )
        check(
            "术语表写入返回结果 qa.glossary",
            (_res_g.get("qa") or {}).get("glossary") == [["layout", "版式"], ["translation", "翻译"]],
            str((_res_g.get("qa") or {}).get("glossary")),
        )
        _systems.clear()

        def _boom(*a, **k):
            raise AssertionError("auto_glossary=False 时不应抽取术语")

        _TRX.extract_glossary = _boom
        _res_ng = _TRX.simple_translate(
            src,
            os.path.join(d, "glossary-off.zh.pdf"),
            "zh",
            "openai",
            base_url="http://x/v1",
            api_key="k",
            model="m",
            auto_glossary=False,
        )
        check(
            "auto_glossary=False 时不抽术语但照常翻译",
            bool(_systems) and (_res_ng.get("qa") or {}).get("glossary") == [],
            str((_res_ng.get("qa") or {}).get("glossary")),
        )
    finally:
        _TRX.extract_glossary = _orig_gloss
        _TRX._openai_translate_many = _orig_many_g

    # ================= 视觉质量回归（两栏 / 公式 / 图 / 网页） =================
    import re as _re

    # ---- A. 两栏正文：不过缩、不重叠、位图图原样、公式逐字保留 ----
    tcol_src = os.path.join(d, "twocol.pdf")
    tcol_out = os.path.join(d, "twocol.out.pdf")
    tcol_md = os.path.join(d, "twocol.md")
    fig_rect = make_two_col_pdf(tcol_src)
    tr = simple_translate(
        tcol_src, tcol_out, target_lang="zh", backend="mock",
        md_out=tcol_md,
    )
    check("两栏：输出存在且无告警", os.path.exists(tcol_out) and not tr["warnings"], str(tr["warnings"]))

    src_spans = _span_list(tcol_src)
    out_spans = _span_list(tcol_out)
    src_sizes = [s[2] for s in src_spans]
    src_body = max(set(src_sizes), key=src_sizes.count)
    zh_spans = [s for s in out_spans if s[3].lstrip().startswith("[ZH]")]
    zh_sizes = [s[2] for s in zh_spans]
    check("两栏：存在译文 span", len(zh_spans) >= 3, f"n={len(zh_spans)}")
    check(
        f"两栏：译文最小字号不低于 floor({MIN_FONT_SIZE})",
        bool(zh_sizes) and min(zh_sizes) >= MIN_FONT_SIZE - 1e-6,
        f"min={min(zh_sizes) if zh_sizes else None}",
    )
    body_like = [s for s in zh_sizes if s >= MIN_FONT_SIZE]
    common_zh = max(set(body_like), key=body_like.count) if body_like else 0
    check(
        "两栏：正文字号未被系统性过缩（>= 原文正文 90%）",
        common_zh >= src_body * 0.9,
        f"zh_common={common_zh} src_body={src_body}",
    )
    ov = _real_overlaps(out_spans)
    check("两栏：译文无真实重叠", ov == 0, f"overlaps={ov}")

    out_doc = fitz.open(tcol_out)
    out_txt = "\n".join(pg.get_text() for pg in out_doc)
    out_doc.close()
    check("公式逐字保留（PDF 文本层）", "E = m c^2 + \\sum_i x_i" in out_txt, repr(out_txt[-200:]))

    src_doc = fitz.open(tcol_src)
    out_doc = fitz.open(tcol_out)
    _m = fitz.Matrix(2, 2)
    same_pix = (
        src_doc[0].get_pixmap(clip=fig_rect, matrix=_m).tobytes()
        == out_doc[0].get_pixmap(clip=fig_rect, matrix=_m).tobytes()
    )
    src_doc.close()
    out_doc.close()
    check("位图图区域像素不变（未覆盖/未重绘）", same_pix)
    check("图题注被翻译（图形外）", "[ZH] Figure 1." in out_txt)

    # ---- B. 矢量图形（形状+文字）内部文字不得翻译/覆盖 ----
    v_src = os.path.join(d, "vec.pdf")
    v_out = os.path.join(d, "vec.out.pdf")
    v_rect = make_vector_fig_pdf(v_src)
    simple_translate(v_src, v_out, target_lang="zh", backend="mock")
    vdoc = fitz.open(v_out)
    vtxt = "\n".join(pg.get_text() for pg in vdoc)
    vdoc.close()
    check(
        "矢量图形内文字保持原样（未翻译/未覆盖）",
        "Input" in vtxt and "Process" in vtxt and "Out" in vtxt
        and "[ZH] Input" not in vtxt and "[ZH] Process" not in vtxt and "[ZH] Out" not in vtxt,
        repr(vtxt[:200]),
    )
    check("矢量图形外题注正常翻译", "[ZH] Figure 1. Pipeline" in vtxt, repr(vtxt[:260]))
    check("矢量图形外正文正常翻译", "[ZH] This is regular body" in vtxt)
    vs = fitz.open(v_src)
    vo = fitz.open(v_out)
    same_vec = (
        vs[0].get_pixmap(clip=v_rect, matrix=_m).tobytes()
        == vo[0].get_pixmap(clip=v_rect, matrix=_m).tobytes()
    )
    vs.close()
    vo.close()
    check("矢量图形区域像素不变（形状与标签保持原样）", same_vec)

    # 纯线条表格不应被误判为图形（表格文字照常翻译）
    tdoc = fitz.open()
    tp = tdoc.new_page(width=W, height=H)
    for i in range(5):
        tp.draw_line((60, 60 + i * 20), (300, 60 + i * 20))
    for j in range(3):
        tp.draw_line((60 + j * 120, 60), (60 + j * 120, 140))
    tp.insert_text((68, 74), "cell alpha data", fontsize=10)
    tregs = _figure_regions(tp)
    tdoc.close()
    check("纯线条表格不被误判为矢量图形", tregs == [], str(tregs))

    # ---- B2. 小图标（<24pt 的填充矢量）内部文字不得翻译 ----
    ic_src = os.path.join(d, "icon.pdf")
    ic_out = os.path.join(d, "icon.out.pdf")
    idoc = fitz.open()
    ip = idoc.new_page(width=W, height=H)
    ip.insert_text((60, 60), "A Paper With Small Icons", fontsize=16)
    ip.draw_rect(fitz.Rect(100, 100, 116, 116), fill=(0.2, 0.4, 0.8))  # 16x16 小图标
    ip.insert_text((104, 112), "OK", fontsize=8)  # 小图标内的标签
    ip.insert_text((60, 160), "Body text near the icon should be translated.", fontsize=11)
    idoc.save(ic_src)
    idoc.close()
    _idoc = fitz.open(ic_src)
    iregs = _figure_regions(_idoc[0])
    _idoc.close()
    check("小图标（16x16 填充矢量）被识别为图形区域", len(iregs) >= 1, str(iregs))
    simple_translate(ic_src, ic_out, target_lang="zh", backend="mock")
    iout = fitz.open(ic_out)
    itxt = "\n".join(pg.get_text() for pg in iout)
    iout.close()
    check(
        "小图标内文字保持原样（未翻译/未覆盖）",
        "OK" in itxt and "[ZH] OK" not in itxt,
        repr(itxt[:200]),
    )
    check("小图标附近正文正常翻译", "[ZH] Body text near the icon" in itxt, repr(itxt[:260]))

    # ---- B3. 图标字体/符号文本：不翻译（避免把图标「翻译」坏） ----
    check(
        "图标字形/符号判定（不误伤自然语言）",
        _looks_like_icon("\ue800") and _looks_like_icon("★") and
        not _looks_like_icon("Hello") and not _looks_like_icon("图 1") and
        not _looks_like_icon("α"),
    )

    # ---- B4. 译文颜色可读（不再「与背景同色 → 看不见」） ----
    check("_pick_text_color：白字深底 → 仍为浅色", _pick_text_color(0xFFFFFF, (0.1, 0.1, 0.12))[0] > 0.6)
    check("_pick_text_color：黑字浅底 → 仍为深色", _pick_text_color(0x000000, (1.0, 1.0, 1.0))[0] < 0.4)
    check(
        "_pick_text_color：字色与底色相同 → 自动取对比色",
        _pick_text_color(0xFFFFFF, (1.0, 1.0, 1.0))[0] < 0.4,
    )
    # 深色底（近整页，故不算图形区域）+ 白字：译文应保留深底且用浅色字
    dk_src = os.path.join(d, "dark.pdf")
    dk_out = os.path.join(d, "dark.out.pdf")
    kdoc = fitz.open()
    kp = kdoc.new_page(width=W, height=H)
    kp.draw_rect(fitz.Rect(0, 0, W, H), fill=(0.08, 0.09, 0.11))
    kp.insert_text((60, 78), "Title On Dark Background", fontsize=16, color=(1, 1, 1))
    kdoc.save(dk_src)
    kdoc.close()
    simple_translate(dk_src, dk_out, target_lang="zh", backend="mock")
    kod = fitz.open(dk_out)
    kpm = kod[0].get_pixmap(clip=fitz.Rect(55, 58, 420, 86), dpi=72)
    klight = kdark = 0
    for yy in range(0, kpm.height, 2):
        for xx in range(0, kpm.width, 2):
            pp = kpm.pixel(xx, yy)
            ll = (pp[0] + pp[1] + pp[2]) / 3
            if ll > 140:
                klight += 1
            elif ll < 100:
                kdark += 1
    kod.close()
    check(
        "深色底标题：译文保留深底且字色可读（有浅色文字）",
        klight > 5 and kdark > 20,
        f"light={klight} dark={kdark}",
    )

    # ---- B5. 图形区域内的「正文段落」仍要翻译（不被误判为图形内部） ----
    bp_src = os.path.join(d, "bodyinfig.pdf")
    bp_out = os.path.join(d, "bodyinfig.out.pdf")
    bdoc = fitz.open()
    bpage = bdoc.new_page(width=W, height=H)
    bpage.draw_rect(fitz.Rect(40, 50, 560, 300), fill=(0.95, 0.95, 0.98))  # 大填充块（图形区域）
    bpage.insert_text(
        (60, 100),
        "A long prose sentence inside a shaded box that must still be translated even though it sits in a graphic region.",
        fontsize=9,
    )
    bpage.insert_text((60, 140), "Label", fontsize=9)  # 短标签：可保持原样
    bdoc.save(bp_src)
    bdoc.close()
    simple_translate(bp_src, bp_out, target_lang="zh", backend="mock")
    bod = fitz.open(bp_out)
    btxt = "\n".join(pg.get_text() for pg in bod)
    bod.close()
    check(
        "图形区域内正文段落仍被翻译（不丢失正文）",
        "[ZH] A long prose sentence" in btxt,
        repr(btxt[:200]),
    )

    # ---- B6. 字体缺字形 → 符号映射/剔除，避免「口」字形（tofu） ----
    check(
        "_sanitize_text：常见符号映射为 ASCII",
        _sanitize_text("a→b ≤ c ×2", None) == "a->b <= c x2",
        _sanitize_text("a→b ≤ c ×2", None),
    )
    check("_sanitize_text：剔除私用区/emoji", _sanitize_text("x\ue800y", None) == "xy")

    # ---- E. 拥挤两栏：字号不低于 floor、无重叠 ----
    cram_src = os.path.join(d, "cram.pdf")
    cram_out = os.path.join(d, "cram.out.pdf")
    make_cramped_pdf(cram_src)
    simple_translate(cram_src, cram_out, target_lang="zh", backend="mock")
    c_spans = _span_list(cram_out)
    c_zh = [s[2] for s in c_spans if s[3].lstrip().startswith("[ZH]")]
    cram_doc = fitz.open(cram_out)
    cram_txt = "\n".join(pg.get_text() for pg in cram_doc)
    cram_doc.close()
    check("拥挤两栏：存在译文", bool(c_zh), f"n={len(c_zh)}")
    check(
        "拥挤两栏：译文最小字号 >= floor",
        bool(c_zh) and min(c_zh) >= MIN_FONT_SIZE - 1e-6,
        f"min={min(c_zh) if c_zh else None}",
    )
    cov = _real_overlaps(c_spans)
    check("拥挤两栏：无真实重叠", cov == 0, f"overlaps={cov}")
    check("拥挤两栏：图题注已翻译", "[ZH] Figure 1." in cram_txt)

    # ---- F. floor 单元测试：极小盒子放不下时也不低于 floor ----
    _doc = fitz.open()
    _pg = _doc.new_page(width=W, height=H)
    _s, _ = _fit_text(
        _pg,
        fitz.Rect(50, 50, 140, 66),
        ("A long sentence that cannot fit into this tiny box at all. " * 8),
        1,
        max_h=68,
        orig_size=12,
    )
    _doc.close()
    check(
        "_fit_text 放不下时优先缩小字号（可低于 floor，但不小于 4pt）",
        4.0 - 1e-6 <= _s <= MIN_FONT_SIZE + 1e-6,
        f"size={_s}",
    )

# ---- 链接保留：URL/DOI 链接化 + PDF 链接注解绑定 ----
_lk = _linkify_html("see https://www.data.gov.in and doi:10.1000/xyz123 .")
check("_linkify_html：http(s) URL 变成链接", '<a href="https://www.data.gov.in"' in _lk, _lk)
check("_linkify_html：doi: 前缀转为 doi.org", 'href="https://doi.org/10.1000/xyz123"' in _lk, _lk)
check("_linkify_html：句号留在链接外", _lk.rstrip().endswith("</a> ."), _lk)
_lk2 = _linkify_html("plain text without any link")
check("_linkify_html：普通文本不加链接", "<a " not in _lk2, _lk2)
_lk3 = _linkify_html("www.example.org/a?b=1")
check("_linkify_html：www. 补 http://", 'href="http://www.example.org/a?b=1"' in _lk3, _lk3)

_lr = fitz.Rect(10, 10, 100, 30)
_lr2 = fitz.Rect(10, 40, 100, 60)
_pl = [(_lr, "https://a.example"), (_lr2, "https://b.example")]
check(
    "_link_for_rect：命中重叠最大的链接注解",
    _link_for_rect(fitz.Rect(20, 12, 90, 28), _pl) == "https://a.example",
    str(_link_for_rect(fitz.Rect(20, 12, 90, 28), _pl)),
)
check("_link_for_rect：不重叠返回 None", _link_for_rect(fitz.Rect(200, 200, 260, 220), _pl) is None)

# ---- 模块化过滤：只翻译正文，跳过「图/表/公式/参考文献」区域 ----
if True:
    from app.translate import _marker, simple_translate  # noqa: E402
    import tempfile  # noqa: E402

    d = fitz.open()
    pg = d.new_page(width=400, height=600)
    pg.insert_text((40, 100), "Body paragraph that should be translated.", fontsize=11)
    pg.insert_text((40, 400), "Table label inside figure", fontsize=9)
    src = os.path.join(tempfile.mkdtemp(), "src.pdf")
    out = os.path.join(tempfile.mkdtemp(), "out.pdf")
    d.save(src)
    d.close()
    # 跳过区域：**底边原点**（标签在 fitz y≈392..400 → 600-400=200 .. 600-392=208）
    res = simple_translate(
        src,
        out,
        "zh",
        "mock",
        skip_rects={"0": [[35.0, 200.0, 260.0, 208.0]]},
    )
    txt = fitz.open(out)[0].get_text("text")
    marker = _marker("zh")
    check(
        "模块过滤：正文被翻译",
        f"{marker}Body paragraph" in txt.replace("\n", " "),
        txt[:120],
    )
    check(
        "模块过滤：跳过区域（图表内标签）保持原文",
        "Table label inside figure" in txt and f"{marker}Table label" not in txt.replace("\n", " "),
        txt[:160],
    )
    check("模块过滤：返回结果含警告字段", isinstance(res.get("warnings"), list), str(res.keys()))


# ---- 译文为空时不丢原文 + 覆盖自检（coverage）----
if True:
    import tempfile  # noqa: E402

    from app import translate as TR  # noqa: E402

    _d = fitz.open()
    _pg = _d.new_page(width=400, height=600)
    _pg.insert_text((40, 100), "Body that must survive when translation is empty.", fontsize=11)
    _src = os.path.join(tempfile.mkdtemp(), "empty-src.pdf")
    _out = os.path.join(tempfile.mkdtemp(), "empty-out.pdf")
    _d.save(_src)
    _d.close()
    _orig_tt = TR.translate_text
    TR.translate_text = lambda *a, **k: ""  # 模拟模型返回空
    try:
        _res = TR.simple_translate(_src, _out, "zh", "mock")
    finally:
        TR.translate_text = _orig_tt
    _txt = fitz.open(_out)[0].get_text("text")
    check(
        "空译文：原文未被擦掉（不丢失）",
        "must survive when translation is empty" in _txt,
        _txt[:100],
    )
    check(
        "空译文：覆盖自检报告 emptyTranslations",
        _res.get("coverage", {}).get("emptyTranslations", 0) >= 1,
        str(_res.get("coverage")),
    )
    check(
        "空译文：给出明确警告",
        any("保留原文" in w for w in _res.get("warnings", [])),
        str(_res.get("warnings")),
    )
    check(
        "覆盖自检：written 与 expected 一致",
        _res.get("coverage", {}).get("written") == _res.get("coverage", {}).get("expected"),
        str(_res.get("coverage")),
    )


# ---- 页眉/页脚区域里的「正文」必须被翻译（正文校验）----
if True:
    import tempfile  # noqa: E402

    from app import translate as TR2  # noqa: E402

    _d2 = fitz.open()
    _p2 = _d2.new_page(width=400, height=600)
    # y=20 → 在顶部 6%（36pt）以内；句子型正文 + 正文字号
    _p2.insert_text(
        (40, 20),
        "We propose a deep learning approach for temporal network dismantling.",
        fontsize=11,
    )
    # 同一区域里的短页眉（无句末标点、词少）→ 仍应跳过
    _p2.insert_text((40, 34), "Journal of Testing 12 (2020)", fontsize=9)
    _src2 = os.path.join(tempfile.mkdtemp(), "hdr-src.pdf")
    _out2 = os.path.join(tempfile.mkdtemp(), "hdr-out.pdf")
    _d2.save(_src2)
    _d2.close()
    _res2 = TR2.simple_translate(_src2, _out2, "zh", "mock")
    _txt2 = fitz.open(_out2)[0].get_text("text").replace("\n", " ")
    _mk = TR2._marker("zh")
    check(
        "页边区域里的句子型正文被翻译（不再漏译）",
        f"{_mk}We propose a deep learning approach" in _txt2,
        _txt2[:140],
    )
    check(
        "页边区域里的短页眉仍保持原文",
        "Journal of Testing 12 (2020)" in _txt2 and f"{_mk}Journal of Testing" not in _txt2,
        _txt2[:160],
    )


# ---- 特殊字符：数学花体/双线体 -> 基础字母，不能变成 ? / 空 ----
if True:
    from app.translate import _glyph_fallback, _sanitize_text  # noqa: E402

    class _NoFont:
        def has_glyph(self, ch):  # noqa: ANN001
            return False

    _san = _sanitize_text("\U0001D4AF \U0001D4AA \u210B \U0001D4D5 \u2102", _NoFont())
    check("特殊字符：花体/双线体映射为基础字母", _san == "T O H F C", _san)
    check("特殊字符：不再出现 ? 占位", "?" not in _san, _san)
    check("特殊字符：花体 T 回退为 T", _glyph_fallback("\U0001D4AF") == "T")
    _keep = _sanitize_text("a ≤ b ∈ S", _NoFont())
    check(
        "特殊字符：常见数学符号有可读回退（不吞掉）",
        ("<=" in _keep) and ("in" in _keep) and ("a" in _keep),
        _keep,
    )


# ---- 版面放不下时：不追加文末补注页，内容按源页进 sidecar（页数保持 1:1）----
if True:
    import json as _json  # noqa: E402
    import tempfile  # noqa: E402

    from app import translate as TR3  # noqa: E402

    _d3 = fitz.open()
    _p3 = _d3.new_page(width=200, height=120)
    _p3.insert_text((12, 80), "A deliberately long source line for the overflow test.", fontsize=9)
    _src3 = os.path.join(tempfile.mkdtemp(), "of-src.pdf")
    _out3 = os.path.join(tempfile.mkdtemp(), "of-out.pdf")
    _d3.save(_src3)
    _d3.close()
    # 让「译文」远长于原文 -> 4pt 也放不进可用高度
    _orig_tt3 = TR3.translate_text
    TR3.translate_text = lambda t, *a, **k: (str(t) * 40)[:4000]
    try:
        _res3 = TR3.simple_translate(_src3, _out3, "zh", "mock")
    finally:
        TR3.translate_text = _orig_tt3
    _doc3 = fitz.open(_out3)
    _txt3 = "".join(pg.get_text("text") for pg in _doc3)
    check(
        "版面溢出：不再追加文末补注页（页数 1:1）",
        _doc3.page_count == 1 and "译文补注" not in _txt3,
        f"pages={_doc3.page_count}",
    )
    check(
        "版面溢出：coverage 记账 truncatedBlocks",
        _res3.get("coverage", {}).get("truncatedBlocks", 0) >= 1,
        str(_res3.get("coverage")),
    )
    _ovf3 = _res3.get("overflowPath")
    _ovf_ok = False
    if _ovf3 and os.path.exists(_ovf3):
        _data3 = _json.load(open(_ovf3, encoding="utf-8"))
        _ovf_ok = "1" in _data3.get("pages", {}) and bool(_data3["pages"]["1"])
    check("版面溢出：完整内容按源页写入 sidecar（不丢失）", _ovf_ok, str(_ovf3))
    check(
        "版面溢出：译文放不下时回填原文（PDF 不留空白）",
        "deliberately" in _txt3.lower(),
        repr(_txt3[:200]),
    )
    check(
        "版面溢出：coverage 记账 fellBackToOriginal",
        _res3.get("coverage", {}).get("fellBackToOriginal", 0) >= 1,
        str(_res3.get("coverage")),
    )
    check(
        "版面溢出：给出明确警告（不静默）",
        any("源页" in w for w in _res3.get("warnings", [])),
        str(_res3.get("warnings"))[:200],
    )
    _doc3.close()


# ---- 排版：逐行块 → 段落（同栏、紧邻、同字号合并）----
if True:
    _r = lambda y, x0=20.0, x1=280.0: fitz.Rect(x0, y, x1, y + 10)
    _flat = [
        {"pno": 0, "rect": _r(50), "raw": "First line of the paragraph goes on", "nlines": 1, "size": 9.0},
        {"pno": 0, "rect": _r(60), "raw": "second line continues the same one", "nlines": 1, "size": 9.0},
        {"pno": 0, "rect": _r(70), "raw": "third line finishes the paragraph here.", "nlines": 1, "size": 9.0},
        # 段后大间距 + 新段
        {"pno": 0, "rect": _r(120), "raw": "A separate second paragraph starts here.", "nlines": 1, "size": 9.0},
    ]
    _out = _merge_flat_paragraphs(_flat, {0: []}, 9.0)
    check(
        "排版：相邻行合并成一个段落",
        len(_out) == 2 and _out[0]["raw"].startswith("First line") and "third line" in _out[0]["raw"],
        str([x["raw"][:20] for x in _out]),
    )
    check("排版：段间距过大不会被误并", _out[1]["raw"].startswith("A separate"), str(_out[1]["raw"][:20]))

    _flat2 = [
        {"pno": 0, "rect": _r(50), "raw": "Goal: keep pseudo code", "nlines": 1, "size": 9.0},
        {"pno": 0, "rect": _r(60), "raw": "1: x = y + 1", "nlines": 1, "size": 9.0},
    ]
    check("排版：算法行不参与合并", len(_merge_flat_paragraphs(_flat2, {0: []}, 9.0)) == 2)

# ---- 公式：抽坏的符号先占位、再还原成可读字母 ----
if True:
    _raw = "Problem \U0001D4AB\U0001D4AB, instances \U0001D49F\U0001D49F\U0001D4AF\U0001D4AFi1, \ufffd?, i m}"
    _masked, _items = _mask_math(_raw)
    check("公式：乱码/花体被换成占位符", "\u27e6" in _masked and "\ufffd" not in _masked, _masked)
    _back = _restore_math(_masked, _items)
    check(
        "公式：保留数学类别（花体不变成普通字母）",
        "\u27e6" not in _back and "\U0001D4AB" in _back and "\U0001D49F" in _back,
        _back,
    )

# ---- 公式：模型漏出来的 LaTeX 必须转成可读文本 ----
if True:
    _tex = r"其中 \(r_{h(i)} \in \{1,\dots,n\}\) 表示启法式 \mathcal{H} 的排名，$\theta \leq \infty$"
    _plain = _latex_to_plain(_tex)
    check(
        "公式：LaTeX 转可读（无反斜杠/$/花括号）",
        "\\" not in _plain and "$" not in _plain and "∈" in _plain and "≤" in _plain,
        _plain,
    )

# ---- 分类：算法块 / 图内小标签保持原样，正文不受影响 ----
if True:
    _base = {"raw": "1: x = y", "size": 9.0, "nlines": 1, "rect": fitz.Rect(10, 300, 100, 310), "ph": 800,
             "cap": False, "fig_internal": False, "in_fig": False, "in_fig_loose": False, "algo": True}
    check("分类：伪代码块判为 figure（保持原样）", _classify_block(_base, 9.0) == "figure")
    _lbl = dict(_base, algo=False, raw="DeepSeek V4 Pro", size=6.5, in_fig_loose=True)
    check("分类：图内小标签判为 figure", _classify_block(_lbl, 9.0) == "figure")
    _body = dict(_base, algo=False, raw="这是一段正常正文，包含标点符号，应当被翻译。", size=9.0)
    check("分类：正文仍是 body", _classify_block(_body, 9.0) == "body")

# ---- 端到端：花体符号不再变豆腐块，模型输入里没有乱码 ----
if True:
    import tempfile  # noqa: E402

    from app import translate as TR5  # noqa: E402

    _d5 = fitz.open()
    _p5 = _d5.new_page(width=400, height=300)
    _p5.insert_textbox(
        fitz.Rect(20, 60, 380, 140),
        "Problem \U0001D4AB\U0001D4AB with instances \U0001D49F\U0001D49F\U0001D4AF\U0001D4AF and \ufffd more text here.",
        fontsize=9,
    )
    _src5 = os.path.join(tempfile.mkdtemp(), "gl-src.pdf")
    _out5 = os.path.join(tempfile.mkdtemp(), "gl-out.pdf")
    _d5.save(_src5)
    _d5.close()
    _seen5 = []
    _orig5 = TR5.translate_text

    def _tt5(t, *a, **k):
        _seen5.append(t)
        return "公式 \U0001D4AB\U0001D4AB 保留，其余翻译。"

    TR5.translate_text = _tt5
    try:
        TR5.simple_translate(_src5, _out5, "zh", "mock")
    finally:
        TR5.translate_text = _orig5
    _doc5 = fitz.open(_out5)
    _txt5 = "".join(pg.get_text("text") for pg in _doc5)
    check("端到端：送给模型的文本里没有 U+FFFD", bool(_seen5) and all("\ufffd" not in t for t in _seen5), str(_seen5)[:120])
    _fonts5 = {
        sp.get("font", "")
        for bb in _doc5[0].get_text("dict").get("blocks", [])
        if bb.get("type") == 0
        for ln in bb.get("lines", [])
        for sp in ln.get("spans", [])
    }
    check(
        "端到端：数学变体用数学字体绘制（不再无差别变成普通字母）",
        any(("cambria" in f.lower() or "math" in f.lower() or "symbol" in f.lower()) for f in _fonts5),
        str(sorted(_fonts5)),
    )
    check("端到端：输出无替换符/豆腐块字符", "\ufffd" not in _txt5, _txt5[:160])


# ---- 统一保护：没有模块层数据时，图内/表内文字也不会被翻译 ----
if True:
    import tempfile  # noqa: E402

    from app import translate as TR6  # noqa: E402

    _d6 = fitz.open()
    _p6 = _d6.new_page(width=400, height=300)
    _p6.insert_textbox(
        fitz.Rect(20, 40, 380, 170),
        "This is a long body paragraph that must be translated by the model. " * 2,
        fontsize=10,
        fontname="tiro",
    )
    _p6.insert_text((20, 230), "LACE 0.95 Mean", fontsize=7, fontname="helv")
    _src6 = os.path.join(tempfile.mkdtemp(), "prot-src.pdf")
    _out6 = os.path.join(tempfile.mkdtemp(), "prot-out.pdf")
    _d6.save(_src6)
    _d6.close()

    _seen6 = []
    _orig6 = TR6.translate_text

    def _tt6(t, *a, **k):
        _seen6.append(t)
        return "译文"

    TR6.translate_text = _tt6
    try:
        # 关键：不传 skip_rects（模拟「调用方没给模块数据」）
        _res6 = TR6.simple_translate(_src6, _out6, "zh", "mock")
    finally:
        TR6.translate_text = _orig6
    check(
        "保护：无模块数据时图内标签仍不送模型",
        bool(_seen6) and all("LACE" not in t for t in _seen6),
        str(_seen6)[:160],
    )
    check(
        "保护：同一页的正文照常翻译",
        any("long body paragraph" in t for t in _seen6),
        str(_seen6)[:160],
    )

# ---- 公式：抽不出的公式整块原样保留（不做静默近似）----
if True:
    _base7 = {'raw': 'min x', 'size': 9.0, 'nlines': 1, 'rect': fitz.Rect(10, 300, 100, 310),
              'ph': 800, 'cap': False, 'fig_internal': False, 'in_fig': False,
              'in_fig_loose': False, 'algo': False, 'font': 'tiro'}
    check(
        '公式：乱码占比高的块判为 formula（原样保留）',
        _classify_block(dict(_base7, math_ratio=0.4), 9.0, 'tiro') == 'formula',
    )
    check(
        '公式：少量行内符号仍是正文（可翻译）',
        _classify_block(dict(_base7, math_ratio=0.02), 9.0, 'tiro') == 'body',
    )
    check(
        '公式：符号占比高但有成句正文时仍按正文翻译',
        _classify_block(
            dict(
                _base7,
                raw='1. Adaptive Weights Update: To guide the search direction during the episode, '
                'the weights of the selected operators are updated by lambda.',
                math_ratio=0.4,
                nlines=3,
            ),
            9.0,
            'tiro',
        )
        == 'body',
    )

    import tempfile  # noqa: E402

    from app import translate as TR7  # noqa: E402

    _d7 = fitz.open()
    _p7 = _d7.new_page(width=400, height=300)
    _p7.insert_textbox(
        fitz.Rect(20, 60, 380, 120),
        'A normal body paragraph with a small symbol x here.',
        fontsize=9,
    )
    _src7 = os.path.join(tempfile.mkdtemp(), 'fx-src.pdf')
    _out7 = os.path.join(tempfile.mkdtemp(), 'fx-out.pdf')
    _d7.save(_src7)
    _d7.close()
    _cov7 = TR7.simple_translate(_src7, _out7, 'zh', 'mock').get('coverage', {})
    check(
        '公式：coverage 上报 formulaPreserved / formulaApproximated（不静默）',
        'formulaPreserved' in _cov7 and 'formulaApproximated' in _cov7,
        str(_cov7),
    )

# ---- 数学：合法括号必须保留；重复变量不误合并；部分占位符丢失要记账 ----
if True:
    from app import translate as TR8  # noqa: E402

    _masked8, _items8 = TR8._mask_math("The value is ⌈x⌉ and ⌊y⌋, inner ⟨u, v⟩.")
    _back8 = TR8._restore_math(_masked8, _items8)
    check(
        "math: ceil/floor/angle brackets preserved",
        "⌈x⌉" in _back8 and "⌊y⌋" in _back8 and "⟨u, v⟩" in _back8,
        ascii(_back8),
    )
    check("math: repeated variables preserved", TR8._math_run_to_text("𝑥𝑥") == "𝑥𝑥",
          ascii(TR8._math_run_to_text("𝑥𝑥")))
    check("math: long repeated variables preserved", TR8._math_run_to_text("𝒟𝒟𝒯𝒯") == "𝒟𝒟𝒯𝒯",
          ascii(TR8._math_run_to_text("𝒟𝒟𝒯𝒯")))

    _flat8 = [{"raw": "a 𝒫 b ℙ c", "math": ["𝒫", "ℙ"]}]
    _tr8 = ["译文 ⟦0⟧ 只有第一个符号"]
    _d8, _m8, _u8 = TR8._restore_formula_placeholders(_flat8, _tr8)
    check("math: partial placeholder loss counted", _d8 == 1 and _m8 == 1 and _u8 == 0, f"dropped={_d8} missing={_m8} unreliable={_u8}")
    check("math: missing placeholder preserves original paragraph", _tr8[0] == _flat8[0]["raw"], ascii(_tr8[0]))

# ---- 版面：译文向下扩展不得压到图片（图片没有文字，不在 hard_obstacles 里）----
if True:
    import tempfile  # noqa: E402

    from app import translate as TR9  # noqa: E402

    _d9 = fitz.open()
    _p9 = _d9.new_page(width=400, height=600)
    _p9.insert_textbox(
        fitz.Rect(40, 80, 360, 130), "Short body above a figure for the image test.", fontsize=10
    )
    _pix9 = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8))
    _pix9.clear_with(180)
    _p9.insert_image(fitz.Rect(60, 220, 340, 420), stream=_pix9.tobytes("png"))
    _src9 = os.path.join(tempfile.mkdtemp(), "img-src.pdf")
    _out9 = os.path.join(tempfile.mkdtemp(), "img-out.pdf")
    _d9.save(_src9)
    _d9.close()

    _orig9 = TR9.translate_text
    _long9 = (
        "本文提出一种用于验证版面边界的方法，译文在图片上方自动换行并保持可读，"
        "不能覆盖图像区域。"
    ) * 6
    TR9.translate_text = lambda t, *a, **k: _long9
    try:
        _res9 = TR9.simple_translate(_src9, _out9, "zh", "mock")
    finally:
        TR9.translate_text = _orig9

    _d9o = fitz.open(_out9)
    _img9 = fitz.Rect(60, 220, 340, 420)
    _bad9 = []
    for _b9 in _d9o[0].get_text("dict")["blocks"]:
        for _l9 in _b9.get("lines", []):
            for _s9 in _l9.get("spans", []):
                if fitz.Rect(_s9["bbox"]).intersects(_img9):
                    _bad9.append(_s9["bbox"])
    check("layout: translation must not overlap image", not _bad9, str(_bad9[:3]))
    check(
        "layout: image page still translated",
        _res9.get("coverage", {}).get("failedBlocks", 0) == 0
        and _res9.get("coverage", {}).get("written", 0) >= 1,
        str(_res9.get("coverage")),
    )
    _d9o.close()

# ---- 版面：整栏 block 按行距/缩进切段；句级片段按“字符落在哪些行”计算 ----
if True:
    from app import translate as TR10  # noqa: E402

    _r1 = fitz.Rect(40, 40, 300, 52)
    _r2 = fitz.Rect(40, 54, 300, 66)
    _r3 = fitz.Rect(40, 80, 300, 92)  # 行距突增 -> 新段
    _f10 = {
        "id": "p0-o0",
        "raw": "First sentence. Second one.",
        "text": "First sentence. Second one.",
        "size": 10.0,
        "rect": _r1 | _r3,
        "lines": ["First sentence.", "Second one.", "New paragraph."],
        "lineRects": [
            [_r1.x0, _r1.y0, _r1.x1, _r1.y1],
            [_r2.x0, _r2.y0, _r2.x1, _r2.y1],
            [_r3.x0, _r3.y0, _r3.x1, _r3.y1],
        ],
        "spans": [],
    }
    _pieces10 = TR10._split_coarse_paragraph(_f10, 10.0)
    check("layout: coarse block split by line gap", len(_pieces10) == 2, str(len(_pieces10)))
    check(
        "layout: split keeps per-piece lines/ids",
        _pieces10[0]["id"] != _pieces10[1]["id"]
        and len(_pieces10[0]["lines"]) == 2
        and len(_pieces10[1]["lines"]) == 1,
        str([x["id"] for x in _pieces10]),
    )

    _segs10 = TR10._segment_rects(
        "Alpha. Beta.",
        [("Alpha.", fitz.Rect(40, 40, 120, 52)), ("Beta.", fitz.Rect(40, 52, 120, 64))],
    )
    check("highlight: sentence segments computed (2)", len(_segs10) == 2, str(_segs10))

    _segs_cn = TR10._segment_rects(
        "第一句。第二句。",
        [("第一句。", fitz.Rect(40, 40, 160, 52)), ("第二句。", fitz.Rect(40, 52, 160, 64))],
    )
    check("highlight: CJK sentence segments computed (2)", len(_segs_cn) == 2, str(_segs_cn))

# ---- refs: unnumbered continuation must stay reference (not translated over English) ----
if True:
    _base11 = {
        "raw": "Shen, Z.-S. et al. Free-energy machine for combinatorial optimization.",
        "size": 8.2, "nlines": 2, "rect": fitz.Rect(300, 600, 560, 640), "ph": 800,
        "cap": False, "fig_internal": False, "in_fig": False, "in_fig_loose": False,
        "algo": False, "font": "tiro", "refsec": True, "roleHint": "",
    }
    check(
        "refs: continuation without number is reference",
        _classify_block(_base11, 8.2, "tiro") == "reference",
        _classify_block(_base11, 8.2, "tiro"),
    )
    check(
        "refs: back-matter heading is not reference",
        _classify_block(dict(_base11, raw="Author contributions", refsec=False, roleHint="heading"), 8.2, "tiro") != "reference",
    )

# ---- citations: superscript detection (local baseline), math kept ----
if True:
    from app import translate as TR12  # noqa: E402

    def _sp(t, size, oy, italic=False, font="Times"):
        return {
            "text": t, "size": size, "origin": [0, oy],
            "bbox": [0, oy - size, size * max(1, len(t)) * 0.5, oy + 2],
            "italic": italic, "font": font,
        }

    _f12 = {
        "raw": "We follow prior work20 and more.",
        "lines": ["We follow prior work20 and more."],
        "lineSpans": [[
            _sp("We follow prior work", 9.0, 100),
            _sp("20", 7.0, 96),
            _sp(" and more.", 9.0, 100),
        ]],
        "pno": 0,
    }
    _m12 = {
        "raw": "The value is x2 plus 102.",
        "lines": ["The value is x2 plus 102."],
        "lineSpans": [[
            _sp("The value is x", 9.0, 100),
            _sp("2", 7.0, 96),
            _sp(" plus 10", 9.0, 100),
            _sp("2", 7.0, 96),
            _sp(".", 9.0, 100),
        ]],
        "pno": 0,
    }
    _c12 = {
        "raw": "See prior work20,21 for details.",
        "lines": ["See prior work20,21 for details."],
        "lineSpans": [[
            _sp("See prior work", 9.0, 100),
            _sp("20", 7.0, 96),
            _sp(",", 7.0, 96),
            _sp("21", 7.0, 96),
            _sp(" for details.", 9.0, 100),
        ]],
        "pno": 0,
    }
    _n12 = TR12._apply_citation_filter([_f12, _m12, _c12], ["body", "body", "body"], [False] * 3)
    check("citations: superscript removed from translation input", _n12 == 2, str(_n12))
    check(
        "citations: raw kept, clean text has no marker",
        _f12.get("raw") == "We follow prior work20 and more."
        and _f12.get("rawClean") == "We follow prior work and more.",
        repr(_f12.get("rawClean")),
    )
    _c0 = (_f12.get("citations") or [{}])[0]
    check(
        "citations: offsets map clean->original",
        _c0.get("origStart") == 20 and _c0.get("origEnd") == 22 and _c0.get("cleanPos") == 20,
        str(_c0),
    )
    check("citations: math exponent x^2 kept", not _m12.get("rawClean"), repr(_m12.get("rawClean")))
    check(
        "citations: multi-span 20,21 merged",
        _c12.get("rawClean") == "See prior work for details."
        and (_c12.get("citations") or [{}])[0].get("text") == "20,21",
        repr(_c12.get("rawClean")),
    )

    _q12 = dict(_f12)
    _q12.pop("rawClean", None)
    _q12.pop("citations", None)
    _q12["raw"] = "Only formula20 here."
    _q12["lines"] = ["Only formula20 here."]
    TR12._apply_citation_filter([_q12], ["formula"], [False])
    check("citations: formula blocks are not filtered", not _q12.get("rawClean"), repr(_q12.get("rawClean")))

# ---- citations: author/affiliation superscripts are NOT citations ----
if True:
    from app import translate as TR13  # noqa: E402

    def _sp13(t, size, oy):
        return {
            "text": t, "size": size, "origin": [0, oy],
            "bbox": [0, oy - size, size * max(1, len(t)) * 0.5, oy + 2],
            "italic": False, "font": "Times",
        }

    _auth = {
        "raw": "Juraj Gottweis1,8, Wei-Hung Weng2,8, Alexander Daryin1,8",
        "lines": ["Juraj Gottweis1,8, Wei-Hung Weng2,8, Alexander Daryin1,8"],
        "lineSpans": [[
            _sp13("Juraj Gottweis", 8.0, 100), _sp13("1,8", 6.0, 97),
            _sp13(", Wei-Hung Weng", 8.0, 100), _sp13("2,8", 6.0, 97),
            _sp13(", Alexander Daryin", 8.0, 100), _sp13("1,8", 6.0, 97),
        ]],
        "pno": 0,
    }
    _n13 = TR13._apply_citation_filter([_auth], ["body"], [False])
    check(
        "citations: author-list markers kept",
        _n13 == 0 and not _auth.get("rawClean"),
        repr(_auth.get("rawClean")),
    )

    _clf13 = {
        "raw": "Juraj Gottweis, Wei-Hung Weng, Alexander Daryin, Tao Tu",
        "size": 8.0, "nlines": 2, "rect": fitz.Rect(40, 100, 560, 130), "ph": 800,
        "cap": False, "fig_internal": False, "in_fig": False, "in_fig_loose": False,
        "algo": False, "font": "tiro", "pno": 0, "roleHint": "",
    }
    check(
        "authors: first-page name list is preserved",
        _classify_block(_clf13, 8.0, "tiro") == "authors",
        _classify_block(_clf13, 8.0, "tiro"),
    )

with tempfile.TemporaryDirectory() as _td:
    from unittest.mock import patch
    from types import SimpleNamespace
    from app import translate as _tr
    import json

    _last_try_page = SimpleNamespace(insert_textbox=lambda *a, **kw: 0 if kw['lineheight'] == 1.1 else -1)
    check('overflow: final fallback attempt reports its actual success',
          _tr._write_original_back(_last_try_page, fitz.Rect(0, 0, 100, 20), 'original text', 9))

    _src = os.path.join(_td, 'source.pdf')
    _out = os.path.join(_td, 'output.pdf')
    _doc = fitz.open()
    _page = _doc.new_page(width=300, height=200)
    _original = 'This paragraph explains our experimental method.'
    _page.insert_text((20, 100), _original, fontsize=10)
    _doc.save(_src)
    _doc.close()
    # Force the same failure signal used for HTML overflow, missing CJK fonts and exceptions.
    for _restore_fails in (False, True):
        with patch.object(_tr, 'translate_text', return_value='The set ℙ ' * 1000), \
             patch.object(_tr, 'math_fontfile', return_value='test-font'), \
             patch.object(_tr, '_draw_math_box', side_effect=lambda p, box, *a: (10, box.y1, True)):
            if _restore_fails:
                with patch.object(_tr, '_write_original_back', return_value=False):
                    _result = _tr.simple_translate(_src, _out)
            else:
                _result = _tr.simple_translate(_src, _out)
        _coverage = _result['coverage']
        check('overflow: failed math draw never counts as written', _coverage['written'] == 0)
        check('overflow: fallback accounting follows actual result',
              _coverage['fellBackToOriginal'] == int(not _restore_fails)
              and _coverage['fallbackFailed'] == int(_restore_fails))
        check('overflow: complete translation retained', bool(_result['overflowPath']))
        if not _restore_fails:
            with fitz.open(_out) as _doc:
                check('overflow: original remains readable, page count unchanged',
                      len(_doc) == 1 and _original in _doc[0].get_text())
        else:
            check('overflow: failed fallback is explicitly reported',
                  any('原文回填失败' in w for w in _result['warnings']))
        with open(_result['mapPath'], encoding='utf-8') as _map_file:
            _map = json.load(_map_file)
        check('overflow: no successful mapping for unwritten text', not _map.get('blocks'))

# Repeated ordinary numbers must not steal the offset of a citation span.
from app.translate import _apply_citation_filter
for _prefix, _suffix, _expected in [
    ('In 12 trials results agree', ' with prior work.', 'In 12 trials results agree with prior work.'),
    ('Results support this.', ' Next experiment follows.', 'Results support this. Next experiment follows.'),
]:
    def _citation_span(t, size=10, y=100):
        return {'text': t, 'size': size, 'origin': [0, y], 'bbox': [0, y-size, 100, y+2], 'font': 'Times', 'italic': False}
    _spans = [_citation_span(_prefix), _citation_span('12', 6, 97), _citation_span(_suffix)]
    _raw = _prefix + '12' + _suffix
    _f = {'raw': _raw, 'lines': [_raw], 'lineSpans': [_spans], 'pno': 0}
    _apply_citation_filter([_f], ['body'], [False])
    check('citation: exact span removed before uppercase or repeated number', _f.get('rawClean') == _expected, repr(_f))

# ---- F06: long first paragraph must not push the next block into 1pt ----
if True:
    import tempfile

    from app import translate as TR14

    _d14 = fitz.open()
    _p14 = _d14.new_page(width=400, height=500)
    _p14.insert_textbox(fitz.Rect(40, 60, 360, 90), "First paragraph long translation.", fontsize=9)
    _p14.insert_textbox(fitz.Rect(40, 94, 360, 120), "Second paragraph near the figure.", fontsize=9)
    _pix14 = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8))
    _pix14.clear_with(180)
    _p14.insert_image(fitz.Rect(60, 125, 340, 260), stream=_pix14.tobytes("png"))
    _src14 = os.path.join(tempfile.mkdtemp(), "f06.pdf")
    _out14 = os.path.join(tempfile.mkdtemp(), "f06.zh.pdf")
    _d14.save(_src14)
    _d14.close()

    _long14 = (
        "这是一段被故意写得非常长的译文，用于把后面的段落向下推挤，直到紧邻图片区域没有足够空间。"
    ) * 8
    _orig14 = TR14.translate_text
    TR14.translate_text = lambda t, *a, **k: _long14
    try:
        _r14 = TR14.simple_translate(_src14, _out14, "zh", "mock", mode="coarse")
    finally:
        TR14.translate_text = _orig14

    _c14 = _r14.get("coverage", {})
    check("F06: no failed backfill (no missing body text)", _c14.get("fallbackFailed", 0) == 0, str(_c14))
    check("F06: both paragraphs accounted for", _c14.get("written", 0) + _c14.get("fellBackToOriginal", 0) >= 2, str(_c14))
    _doc14 = fitz.open(_out14)
    _spans14 = []
    for _b in _doc14[0].get_text("dict")["blocks"]:
        if _b.get("type") != 0:
            continue
        for _ln in _b.get("lines", []):
            for _sp in _ln.get("spans", []):
                _spans14.append((_sp.get("text", ""), fitz.Rect(_sp["bbox"])))
    _doc14.close()
    # 第二段槽位（y≈94–120）里必须有文字，不能是空白
    _in_slot = [t for t, r in _spans14 if r.intersects(fitz.Rect(40, 90, 360, 124)) and t.strip()]
    check("F06: second paragraph slot still has text", bool(_in_slot), str([t[:20] for t in _in_slot[:3]]))

# ---- L02: strict layout keeps paragraph tops and column bounds ----
if True:
    import json as _json
    import tempfile

    from app import translate as TR15

    _d15 = fitz.open()
    _p15 = _d15.new_page(width=600, height=400)
    _p15.insert_textbox(
        fitz.Rect(40, 60, 280, 112),
        "First column first paragraph with enough words to wrap across the whole column width.",
        fontsize=9,
    )
    _p15.insert_textbox(
        fitz.Rect(40, 118, 280, 142),
        "Second paragraph starts here and is short.",
        fontsize=9,
    )
    _p15.insert_textbox(
        fitz.Rect(320, 60, 560, 180),
        "Second column body that defines the gutter and must never be crossed.",
        fontsize=9,
    )
    _src15 = os.path.join(tempfile.mkdtemp(), "l02.pdf")
    _d15.save(_src15)
    _d15.close()

    _long15 = (
        "这是一段非常长的译文，用来验证严格保版式在放不下时会保留原文，"
        "而不是压成很小的字或覆盖后面的段落。"
    ) * 6

    def _fake15(t, *a, **k):
        return _long15 if "First column" in str(t) else "第二段译文。"

    _orig15 = TR15.translate_text
    TR15.translate_text = _fake15
    try:
        _out15 = os.path.join(tempfile.mkdtemp(), "l02.zh.pdf")
        _r15 = TR15.simple_translate(_src15, _out15, "zh", "mock", mode="coarse", layout="strict")
    finally:
        TR15.translate_text = _orig15

    _blocks15 = _json.load(open(_r15["mapPath"], encoding="utf-8"))["blocks"]
    _col15 = [b for b in _blocks15 if b["page"] == 1 and b["src"][0] < 300]
    check("L02: strict has paragraph mappings", len(_col15) >= 1, str(len(_col15)))
    _tops_ok = all(abs(b["dst"][3] - b["src"][3]) <= 1.5 for b in _col15)
    check("L02: strict keeps paragraph top (<=1.5pt)", _tops_ok, str([(b["src"][3], b["dst"][3]) for b in _col15]))
    _width_ok = all(b["dst"][2] <= b["src"][2] + 8.0 for b in _col15)
    check("L02: strict never crosses the column/gutter", _width_ok, str([(b["src"][2], b["dst"][2]) for b in _col15]))
    check("L02: no failed backfill", _r15.get("coverage", {}).get("fallbackFailed", 0) == 0, str(_r15.get("coverage")))
    _doc15 = fitz.open(_out15)
    _txt15 = _doc15[0].get_text()
    _doc15.close()
    check("L02: unplaceable paragraph keeps original text", "First column first paragraph" in _txt15, repr(_txt15[:80]))
    _ovf15 = _r15.get("overflowPath")
    _odata15 = _json.load(open(_ovf15, encoding="utf-8")) if _ovf15 else {}
    check(
        "L02: unplaceable translation is in overflow",
        bool((_odata15.get("pages") or {}).get("1")),
        str(_ovf15),
    )
    check("L02: short paragraph still translated", "第二段译文" in _txt15, repr(_txt15[:120]))

# ---- 旋转文本：译文保持原文角度（不再强行水平） ----
if True:
    import tempfile  # noqa: E402

    from app import translate as TRR  # noqa: E402

    _d = fitz.open()
    _p = _d.new_page(width=500, height=600)
    _p.insert_text(
        (60, 100),
        "A normal horizontal paragraph for comparison and body size detection.",
        fontsize=11,
    )
    _p.insert_text(
        (350, 480),
        "This rotated paragraph is deliberately long enough to be treated as body text "
        "and translated in place.",
        fontsize=11,
        rotate=90,
    )
    _src = os.path.join(tempfile.mkdtemp(), "rot-src.pdf")
    _out = os.path.join(tempfile.mkdtemp(), "rot-out.pdf")
    _d.save(_src)
    _d.close()
    _r_rot = TRR.simple_translate(_src, _out, "zh", "mock")
    _doc = fitz.open(_out)
    _dirs = []
    for _b in _doc[0].get_text("dict")["blocks"]:
        for _l in _b.get("lines", []):
            _t = "".join(sp["text"] for sp in _l["spans"])
            if "[ZH]" in _t and "rotated paragraph" in _t:
                _dirs.append(tuple(round(v, 3) for v in _l["dir"]))
    _doc.close()
    check(
        "旋转文本：译文保留竖直方向（dir≈(0,-1)）",
        bool(_dirs) and all(abs(dx) <= 0.02 and dy < -0.98 for dx, dy in _dirs),
        str(_dirs),
    )
    # PD26：旋转块行序不可靠，绝不写「源句 → 整段译文」的 segs（那正是整段高亮）；
    # 客户端拿不到 segs 时宁可不亮，也不整块兜底。
    import json as _json_rot  # noqa: E402

    _rot_blocks = _json_rot.load(open(_r_rot["mapPath"], encoding="utf-8"))["blocks"]
    _rot_angles = [float(b.get("angle") or 0.0) for b in _rot_blocks]
    check(
        "PD26：旋转块不写 segs（宁可不亮，不整段兜底）",
        any(abs(a) >= 1.0 for a in _rot_angles)
        and all(not b.get("segs") for b in _rot_blocks if abs(float(b.get("angle") or 0.0)) >= 1.0),
        str([(b.get("angle"), b.get("segs")) for b in _rot_blocks])[:300],
    )

# ---- 句级映射：句数不一致也要给出多对多 segs，且选中第一句不会映射整段 ----
if True:
    from app import translate as TRS  # noqa: E402

    _line = [("Alpha first. Beta second is longer. Gamma third.", fitz.Rect(40, 40, 300, 52))]
    _segs = TRS._segments("Alpha first. Beta second is longer. Gamma third.", _line)
    _mapped = TRS._align_segments(_segs, _segs[:2])
    check("句级映射：3 源句/2 译句也能对齐", bool(_mapped), str(_mapped))
    _first_targets = [p[1] for p in _mapped if p[0] == _segs[0][0]]
    check(
        "句级映射：第一句只映射到第一段译文",
        len(_first_targets) == 1 and _first_targets[0] == _segs[0][0],
        str(_first_targets),
    )
    _rects = TRS._segment_rects(
        "Alpha first. Beta second is longer.",
        [("Alpha first. Beta second is longer.", fitz.Rect(40, 40, 300, 52))],
    )
    check(
        "句级映射：同一行内按字符比例切分（不再整行重复）",
        len(_rects) == 2 and _rects[0][2] < _rects[1][2] and _rects[0][0] == 40.0,
        str(_rects),
    )
    # 端到端：模型把 2 句并成 1 句时，map 里仍应有 segs（供跨窗句级高亮）
    _d2 = fitz.open()
    _p2 = _d2.new_page(width=400, height=300)
    _p2.insert_textbox(
        fitz.Rect(30, 60, 370, 120),
        "First sentence here. Second sentence is a bit longer.",
        fontsize=11,
    )
    _src2 = os.path.join(tempfile.mkdtemp(), "seg-src.pdf")
    _out2 = os.path.join(tempfile.mkdtemp(), "seg-out.pdf")
    _d2.save(_src2)
    _d2.close()
    _orig2 = TRS.translate_text
    TRS.translate_text = lambda t, *a, **k: "[ZH] 第一句和第二句被合并成了一句译文。"
    try:
        _res2 = TRS.simple_translate(_src2, _out2, "zh", "mock")
    finally:
        TRS.translate_text = _orig2
    import json as _json2  # noqa: E402

    _blocks2 = _json2.load(open(_res2["mapPath"], encoding="utf-8"))["blocks"]
    check(
        "句级映射：译文句数不同也写入 segs",
        bool(_blocks2) and all(bool(b.get("segs")) for b in _blocks2 if b.get("dst")),
        str([(b.get("srcSegs"), b.get("segs")) for b in _blocks2])[:400],
    )

# ---- PD26：句级片段（同句跨行按行拆片）+ 按真实交叠映射，不再整段兜底 ----
if True:
    from app import translate as TRP  # noqa: E402

    _src_lines = [
        ("Alpha first sentence", fitz.Rect(40, 40, 300, 52)),
        ("tail. Beta second.", fitz.Rect(40, 52, 300, 64)),
    ]
    _det = TRP._segment_pieces("Alpha first sentence tail. Beta second.", _src_lines)
    check(
        "PD26 片段：第一句跨两行 → 两个行片段，第二句只占第二行后半",
        len(_det) == 2
        and len(_det[0][2]) == 2
        and len(_det[1][2]) == 1
        and round(_det[0][2][1][0][2], 2) == 121.25
        and round(_det[1][2][0][0][0], 2) == 121.25,
        str(_det),
    )
    _segs_compat = TRP._segments("Alpha first sentence tail. Beta second.", _src_lines)
    check(
        "PD26 片段：_segments 仍返回句级并集框（srcSegs 旧字段兼容）",
        [r for r, _w in _segs_compat] == [d[0] for d in _det],
        str(_segs_compat),
    )
    _pp = TRP._sentence_piece_pairs(
        [([0, 0, 100, 10], 10), ([0, 10, 100, 20], 30)],
        [([0, 0, 100, 20], 20)],
    )
    check(
        "PD26 片段：对侧单片段跨整句 → 与本侧两个行片段都配对",
        len(_pp) == 2 and _pp[0][0] == [0, 0, 100, 10] and _pp[1][0] == [0, 10, 100, 20],
        str(_pp),
    )
    _dst_lines = [
        ("第一句从这里开始", fitz.Rect(40, 40, 300, 52)),
        ("继续。第二句。", fitz.Rect(40, 52, 300, 64)),
    ]
    _det_dst = TRP._segment_pieces("第一句从这里开始继续。第二句。", _dst_lines)
    _pairs26 = TRP._align_segments(_det, _det_dst)
    check(
        "PD26 片段：对齐结果按行片段给出（不再一句一个跨行并集框）",
        len(_pairs26) >= 3
        and all(round(p[0][3] - p[0][1], 2) == 12.0 for p in _pairs26)
        and all(round(p[1][3] - p[1][1], 2) == 12.0 for p in _pairs26),
        str(_pairs26),
    )
    check(
        "PD26 片段：不输出整句并集框，且无重复配对",
        all(p[0] != [40.0, 40.0, 300.0, 64.0] for p in _pairs26)
        and len({(tuple(p[0]), tuple(p[1])) for p in _pairs26}) == len(_pairs26),
        str(_pairs26),
    )
    _b2 = [b for b in _blocks2 if b.get("dst")][0]
    check(
        "PD26 片段：端到端 segs 每个源片段都比整块窄（不再整行/整段）",
        bool(_b2.get("segs"))
        and all(
            round(seg[0][2] - seg[0][0], 2) < round(_b2["src"][2] - _b2["src"][0], 2)
            for seg in _b2.get("segs") or []
        ),
        str(_b2.get("segs")),
    )

# ---- 按页验收（qa.verification）+ 正文没正常翻译的页自动重译 ----
if True:
    import json as _json_v  # noqa: E402
    import shutil as _shutil_v  # noqa: E402

    from app import translate as TRV  # noqa: E402

    _vdir = tempfile.mkdtemp(prefix="pd-verify-test-")
    _vsrc = os.path.join(_vdir, "verify-src.pdf")
    _vout = os.path.join(_vdir, "verify-out.zh.pdf")

    def _make_verify_pdf(path):
        _d = fitz.open()
        _p1 = _d.new_page(width=595, height=842)
        _p1.insert_textbox(
            fitz.Rect(60, 72, 535, 120),
            "Page one body paragraph that must be translated normally in the first pass.",
            fontsize=11,
            lineheight=1.2,
        )
        # 第 2、3 页：贴近页底的正文，长译文本「当前版面」必然放不下（4pt 也溢出）
        # → 第一遍保留原文；两页同时未通过，用来覆盖「重译并发 + 串行替换」。
        for _label in ("two", "three"):
            _p = _d.new_page(width=595, height=842)
            _p.insert_textbox(
                fitz.Rect(60, 660, 535, 740),
                f"Page {_label} body paragraph that fails to fit in the first pass and must be retried.",
                fontsize=11,
                lineheight=1.2,
            )
        _d.save(path)
        _d.close()

    _make_verify_pdf(_vsrc)
    _long_v = "[ZH] " + (
        "这一段译文被故意写得很长，用来验证第一遍放不下时会按页验收并自动重译。" * 600
    )
    _short_v = {
        "two": "[ZH] 第二页重译后的短译文。",
        "three": "[ZH] 第三页重译后的短译文。",
    }
    _calls_v = {}

    def _flaky_v(text, *a, **k):
        """首轮给超长译文（放不下），重译时给短译文（放得下）。"""
        _n = _calls_v.get(text, 0)
        _calls_v[text] = _n + 1
        if "Page one" in text:
            return "[ZH] 第一页正文译文。"
        for _label, _short in _short_v.items():
            if f"Page {_label}" in text:
                return _long_v if _n == 0 else _short
        return _long_v

    _orig_v = TRV.translate_text
    TRV.translate_text = _flaky_v
    try:
        _rv = TRV.simple_translate(_vsrc, _vout, "zh", "mock")
    finally:
        TRV.translate_text = _orig_v

    _ver = (_rv.get("qa") or {}).get("verification") or {}
    check("验收：qa.verification 含逐页结果", bool(_ver.get("pages")), str(_ver)[:300])
    check(
        "验收：第一遍识别出未通过的页",
        _ver.get("preRetryFailedPages") == [2, 3],
        str(_ver.get("preRetryFailedPages")),
    )
    check(
        "验收：未通过页已自动重译（并发后串行替换）",
        _ver.get("retriedPages") == [2, 3],
        str(_ver.get("retriedPages")),
    )
    check(
        "验收：重译后整体通过（failedPages 清空）",
        _ver.get("passed") is True and not _ver.get("failedPages"),
        str(_ver.get("failedPages")),
    )
    _pg_bad_v = [
        p for p in _ver.get("pages") or [] if p.get("page") in (2, 3) and not p.get("ok")
    ]
    _pg2_v = next((p for p in _ver.get("pages") or [] if p.get("page") == 2), {})
    check(
        "验收：重译页状态/比例已更新",
        not _pg_bad_v
        and _pg2_v.get("status") == "retried"
        and bool(_pg2_v.get("ok"))
        and float(_pg2_v.get("ratio") or 0.0) >= 0.6,
        str(_pg2_v),
    )
    with fitz.open(_vout) as _vo_v:
        _txt1_v = _vo_v[0].get_text()
        _txt2_v = _vo_v[1].get_text()
        _txt3_v = _vo_v[2].get_text()
        _pages_v = _vo_v.page_count
    check("验收：重译后页数保持 1:1", _pages_v == 3, str(_pages_v))
    check(
        "验收：重译页正文出现译文（第 2 页）",
        _short_v["two"].replace("[ZH] ", "") in _txt2_v,
        repr(_txt2_v[:120]),
    )
    check(
        "验收：重译页正文出现译文（第 3 页，顺序不串页）",
        _short_v["three"].replace("[ZH] ", "") in _txt3_v
        and _short_v["three"].replace("[ZH] ", "") not in _txt2_v,
        repr(_txt3_v[:120]),
    )
    check("验收：第一页译文未被串改", "第一页正文译文" in _txt1_v, repr(_txt1_v[:120]))
    check(
        "验收：重译成功的页不再留在溢出清单",
        not _rv.get("overflowPath"),
        str(_rv.get("overflowPath")),
    )
    _map_v = _json_v.load(open(_rv["mapPath"], encoding="utf-8"))
    check(
        "验收：块级映射合并了重译页",
        sorted({b["page"] for b in _map_v.get("blocks") or []}) == [1, 2, 3],
        str(sorted({b["page"] for b in _map_v.get("blocks") or []})),
    )
    _v2_calls = sorted(n for t, n in _calls_v.items() if "Page two" in t)
    _v3_calls = sorted(n for t, n in _calls_v.items() if "Page three" in t)
    check(
        "验收：重译只跑一次（不递归）",
        _v2_calls == [2] and _v3_calls == [2],
        str(_calls_v),
    )

    # verify=False：只验收、不重译（重译时的递归调用靠它防无限递归）
    _calls_v.clear()
    _noretry_out = os.path.join(_vdir, "verify-noretry.zh.pdf")
    TRV.translate_text = _flaky_v
    try:
        _rv2 = TRV.simple_translate(_vsrc, _noretry_out, "zh", "mock", verify=False)
    finally:
        TRV.translate_text = _orig_v
    _ver2 = (_rv2.get("qa") or {}).get("verification") or {}
    check(
        "验收：verify=False 只报告、不自动重译",
        _ver2.get("retriedPages") == [] and _ver2.get("preRetryFailedPages") == [2, 3],
        str(_ver2)[:300],
    )
    check("验收：verify=False 每个块只翻一次", all(v == 1 for v in _calls_v.values()), str(_calls_v))
    with fitz.open(_noretry_out) as _vo2_v:
        check(
            "验收：未重译时保留原文、页数不变",
            _vo2_v.page_count == 3
            and "Page two body paragraph" in _vo2_v[1].get_text()
            and "Page three body paragraph" in _vo2_v[2].get_text(),
            repr(_vo2_v[1].get_text()[:80]),
        )

    # 重译仍失败 → 保留原页 + 明确告警（不丢页、不留空白）
    _fail_out = os.path.join(_vdir, "verify-fail.zh.pdf")
    TRV.translate_text = (
        lambda t, *a, **k: "[ZH] 第一页正文译文。" if "Page one" in t else _long_v
    )
    try:
        _rv3 = TRV.simple_translate(_vsrc, _fail_out, "zh", "mock")
    finally:
        TRV.translate_text = _orig_v
    _ver3 = (_rv3.get("qa") or {}).get("verification") or {}
    check(
        "验收：重译仍失败时 failedPages 保留该页",
        _ver3.get("failedPages") == [2, 3] and _ver3.get("retriedPages") == [],
        str(_ver3)[:300],
    )
    check(
        "验收：重译失败有告警",
        any("重译" in w for w in _rv3.get("warnings") or []),
        str(_rv3.get("warnings"))[:300],
    )
    with fitz.open(_fail_out) as _vo3_v:
        check(
            "验收：重译失败时页数不变且保留原文",
            _vo3_v.page_count == 3
            and "Page two body paragraph" in _vo3_v[1].get_text()
            and "Page three body paragraph" in _vo3_v[2].get_text(),
            repr(_vo3_v[1].get_text()[:80]),
        )
    _shutil_v.rmtree(_vdir, ignore_errors=True)

# ---- 表格：单元格保留原排版，表格前后的正文照常翻译 ----
if True:
    from app import translate as TRT  # noqa: E402

    _tdir = tempfile.mkdtemp(prefix="pd-table-test-")

    def _make_table_pdf(path, verticals=True, caption=False):
        _d = fitz.open()
        _p = _d.new_page(width=595, height=842)
        _p.insert_textbox(
            fitz.Rect(60, 60, 535, 140),
            "Body paragraph above the table that must be translated by the pipeline. "
            "It has two sentences so the layout is realistic.",
            fontsize=10.5,
            lineheight=1.2,
        )
        _x0, _y0, _x1, _y1 = 60.0, 240.0, 535.0, 420.0
        _cols = [_x0, _x0 + (_x1 - _x0) / 3, _x0 + 2 * (_x1 - _x0) / 3, _x1]
        _rows = [_y0, _y0 + (_y1 - _y0) / 3, _y0 + 2 * (_y1 - _y0) / 3, _y1]
        if verticals:
            for _x in _cols:
                _p.draw_line((_x, _y0), (_x, _y1), width=0.8)
        for _y in _rows:
            _p.draw_line((_x0, _y), (_x1, _y), width=0.8)
        _cells = [
            ("Model", "Accuracy", "Params"),
            ("ResNet-50 baseline network", "76.1%", "25.6M"),
            ("Ours improved method", "78.4%", "27.1M"),
        ]
        for _r in range(3):
            for _c in range(3):
                # 单元格字号与正文一致：不能靠「小字号=图」的老规则保护
                _p.insert_text((_cols[_c] + 4, _rows[_r] + 16), _cells[_r][_c], fontsize=10.5)
        if caption:
            _p.insert_text((60, 234), "Table 1. Main results of the proposed method.", fontsize=9)
        _p.insert_textbox(
            fitz.Rect(60, 470, 535, 560),
            "Body paragraph below the table that must also be translated normally after the table.",
            fontsize=10.5,
            lineheight=1.2,
        )
        _d.save(path)
        _d.close()

    _orig_t = TRT.translate_text
    _cell_texts = ["Model", "Accuracy", "Params", "ResNet-50 baseline network", "76.1%", "25.6M"]
    _tlong = "[ZH] " + "这是一段故意写得更长的译文，用来看表格是否被压坏。" * 3
    for _idx, (_tname, _tvert, _tcap) in enumerate(
        [
            ("表格：有竖线的表格（单元格与正文同字号）", True, False),
            ("表格：只有横线的三线表（无竖线也要识别）", False, False),
            ("表格：三线表 + 表题", False, True),
        ]
    ):
        _tsrc = os.path.join(_tdir, f"table-{_idx}.pdf")
        _tout = os.path.join(_tdir, f"table-{_idx}.zh.pdf")
        _make_table_pdf(_tsrc, _tvert, _tcap)
        TRT.translate_text = lambda _t, *a, **k: _tlong
        try:
            _tres = TRT.simple_translate(_tsrc, _tout, "zh", "mock", verify=False)
        finally:
            TRT.translate_text = _orig_t
        with fitz.open(_tout) as _tdoc:
            _ttxt = _tdoc[0].get_text()
        check(
            _tname + "：单元格文本保持原样",
            all(c in _ttxt for c in _cell_texts),
            repr(_ttxt[:300]),
        )
        check(
            _tname + "：表格上方正文照常翻译",
            "Body paragraph above the table" not in _ttxt and "[ZH]" in _ttxt,
            repr(_ttxt[:200]),
        )
        check(
            _tname + "：表格下方正文照常翻译",
            "Body paragraph below the table" not in _ttxt,
            repr(_ttxt[-200:]),
        )
        if _tcap:
            check(_tname + "：表题仍被翻译（不随单元格保留）", "Table 1. Main results" not in _ttxt)
        check(
            _tname + "：不静默丢表格（无表格相关告警）",
            not any("表格" in _w for _w in _tres.get("warnings") or []),
            str(_tres.get("warnings"))[:200],
        )

    # 合并屏障：表格矩形挡住上下正文块，避免单元格被并进段落/被整段重排
    _tflat = [
        {"pno": 0, "rect": fitz.Rect(20.0, 100.0, 280.0, 110.0),
         "raw": "line above the table continues", "nlines": 1, "size": 10.5},
        {"pno": 0, "rect": fitz.Rect(20.0, 114.0, 280.0, 124.0),
         "raw": "line below the table continues", "nlines": 1, "size": 10.5},
    ]
    _tbarrier = {0: [fitz.Rect(18.0, 110.5, 282.0, 113.0)]}
    check(
        "表格：表格矩形阻断跨表格的段落合并",
        len(_merge_flat_paragraphs(_tflat, _tbarrier, 10.5)) == 2,
        str([x["raw"] for x in _merge_flat_paragraphs(_tflat, _tbarrier, 10.5)]),
    )
    check(
        "表格：没有表格矩形时相邻两行仍会合并（对照，不回归）",
        len(_merge_flat_paragraphs(_tflat, {0: []}, 10.5)) == 1,
        str([x["raw"] for x in _merge_flat_paragraphs(_tflat, {0: []}, 10.5)]),
    )

# ---- 页角色：body / references / appendix（附录继续翻译，参考文献不算失败）----
if True:
    check(
        "页角色：附录/补充材料标题识别",
        all(
            _is_appendix_heading(x)
            for x in [
                "Appendix A",
                "A. Appendix",
                "APPENDIX B: Proofs",
                "Supplementary Material",
                "Supplementary Methods",
                "附录 A",
                "补充材料",
            ]
        )
        and not _is_appendix_heading(
            "Appendix A shows the detailed derivation of the bound in Section 3."
        ),
        "",
    )
    check(
        "页角色：参考文献页密度识别（正例/负例）",
        _looks_like_reference_page(
            "\n".join(
                [
                    "1. He K. Deep Residual Learning. CVPR 2016.",
                    "2. Smith J. A Study of Things. Nature 2018.",
                    "3. Doe A. Another Work. IEEE 2019.",
                    "4. Roe B. More Work. ACM 2020.",
                ]
            )
        )
        and not _looks_like_reference_page(
            "We train the network with SGD for 100 epochs and report accuracy."
        ),
        "",
    )

    _role_texts = [
        "A Study of Layout\nAbstract\nWe study layout preserving translation.\n"
        "1. Introduction\nBody sentence one about the method. " * 3,
        "2. Method\nWe train the network with SGD and evaluate on the test set. " * 4,
        "References\n1. He K. Deep Residual Learning. CVPR 2016.\n"
        "2. Smith J. A Study of Things. Nature 2018.\n"
        "3. Doe A. Another Work. IEEE 2019.\n4. Roe B. More Work. ACM 2020.",
        # 参考文献跨页续排（无标题，只有条目）
        "5. Lee C. Continued Entry. Journal 2022.\n6. Kim D. More Entries. Conf. 2021.\n"
        "7. Park E. Another Entry. arXiv 2020.\n8. Choi F. Last Entry. IEEE 2019.",
        # 参考文献之后出现附录 → 附录是正文，必须继续翻译
        "Appendix A\nProof of Theorem 1\nWe prove the bound as follows.",
        "A.1 Detailed Derivation\nWe expand the bound step by step. " * 6,
    ]
    _roles = _page_roles_from_texts(_role_texts)
    check(
        "页角色：正文→参考文献→续排→附录的过渡",
        _roles == ["body", "body", "references", "references", "appendix", "appendix"],
        str(_roles),
    )

    _vref = _page_verdict("references", 0, 0, False, 0.6)
    check(
        "页角色：参考文献页标注 references + skipped（不算正文失败）",
        _vref["role"] == "references"
        and _vref["ok"]
        and _vref["status"] == "skipped",
        str(_vref),
    )
    _vapp = _page_verdict("appendix", 10, 10, True, 0.6)
    check(
        "页角色：附录页公式区域保留原文时不判失败（stuck 但正文已译完）",
        _vapp["role"] == "appendix" and _vapp["ok"] and _vapp["status"] == "skipped",
        str(_vapp),
    )
    _vapp2 = _page_verdict("appendix", 10, 10, False, 0.6)
    check(
        "页角色：附录页正常写完 → ok",
        _vapp2["ok"] and _vapp2["status"] == "ok",
        str(_vapp2),
    )
    _vapp3 = _page_verdict("appendix", 10, 3, False, 0.6)
    check(
        "页角色：附录正文写入不足仍判失败（附录不能整页跳过）",
        not _vapp3["ok"] and _vapp3["status"] == "fail",
        str(_vapp3),
    )
    _vbody = _page_verdict("body", 10, 3, False, 0.6)
    check(
        "页角色：正文写入不足仍判失败（不回归）",
        not _vbody["ok"] and _vbody["status"] == "fail",
        str(_vbody),
    )

    # qa.verification 的结构：pageRoles 全篇覆盖；references 页以 skipped 出现
    with tempfile.TemporaryDirectory() as _rd:
        _rsrc = os.path.join(_rd, "roles-src.pdf")
        _rout = os.path.join(_rd, "roles-out.zh.pdf")
        make_pdf(_rsrc)
        _rres = simple_translate(_rsrc, _rout, target_lang="zh", backend="mock")
        _rver = (_rres.get("qa") or {}).get("verification") or {}
        _rroles = _rver.get("pageRoles") or {}
        check(
            "验收结构：pageRoles 覆盖每一页且识别参考文献页",
            _rroles.get("1") == "body" and _rroles.get("2") == "references",
            str(_rroles),
        )
        _rpage2 = next((p for p in _rver.get("pages") or [] if p.get("page") == 2), {})
        check(
            "验收结构：参考文献页有 role/status 且不在 failedPages",
            _rpage2.get("role") == "references"
            and _rpage2.get("status") == "skipped"
            and 2 not in (_rver.get("failedPages") or []),
            str(_rpage2) + " failed=" + str(_rver.get("failedPages")),
        )
        check(
            "验收结构：passed 不受参考文献页影响",
            bool(_rver.get("passed")),
            str(_rver.get("failedPages")),
        )

    # 端到端：参考文献 → 附录 的过渡；附录页必须继续翻译，且不算正文失败
    with tempfile.TemporaryDirectory() as _ad:
        _asrc = os.path.join(_ad, "appendix-src.pdf")
        _aout = os.path.join(_ad, "appendix-out.zh.pdf")
        _adoc = fitz.open()
        _ap1 = _adoc.new_page(width=595, height=842)
        _ap1.insert_textbox(
            fitz.Rect(60, 60, 535, 300), "Page one body paragraph. " * 12, fontsize=10.5, lineheight=1.2
        )
        _ap2 = _adoc.new_page(width=595, height=842)
        _ap2.insert_text((60, 80), "References", fontsize=14)
        _ap2.insert_textbox(
            fitz.Rect(60, 100, 535, 500),
            "\n".join(
                [
                    "1. He K. Deep Residual Learning. CVPR 2016.",
                    "2. Smith J. A Study of Things. Nature 2018.",
                    "3. Doe A. Another Work. IEEE 2019.",
                    "4. Roe B. More Work. ACM 2020.",
                ]
            ),
            fontsize=10.5,
            lineheight=1.4,
        )
        _ap3 = _adoc.new_page(width=595, height=842)
        _ap3.insert_text((60, 80), "Appendix A", fontsize=14)
        _ap3.insert_text((60, 110), "Proof of Theorem 1", fontsize=11)
        _ap3.insert_textbox(
            fitz.Rect(60, 140, 535, 480), "We prove the bound as follows. " * 14, fontsize=10.5, lineheight=1.2
        )
        _adoc.save(_asrc)
        _adoc.close()
        _ao = TRT.translate_text
        TRT.translate_text = lambda _t, *a, **k: "[ZH] 已翻译的正文。"
        try:
            _ares = TRT.simple_translate(_asrc, _aout, "zh", "mock")
        finally:
            TRT.translate_text = _ao
        with fitz.open(_aout) as _adoc2:
            _atxt = [pg.get_text() for pg in _adoc2]
        _aver = (_ares.get("qa") or {}).get("verification") or {}
        check(
            "页角色端到端：参考文献页保留原文不翻译",
            "Deep Residual Learning" in _atxt[1] and "[ZH]" not in _atxt[1],
            repr(_atxt[1][:120]),
        )
        check(
            "页角色端到端：附录页继续翻译（不被当成参考文献跳过）",
            "[ZH]" in _atxt[2] and "We prove the bound as follows." not in _atxt[2],
            repr(_atxt[2][:160]),
        )
        check(
            "页角色端到端：pageRoles 为 body→references→appendix",
            _aver.get("pageRoles") == {"1": "body", "2": "references", "3": "appendix"},
            str(_aver.get("pageRoles")),
        )
        check(
            "页角色端到端：附录页不算正文失败",
            bool(_aver.get("passed")) and not _aver.get("failedPages"),
            str(_aver.get("failedPages")),
        )

# ---------------------------------------------------------------------------
# 行级公式岛：公式与正文拆开，公式只保护自己
# ---------------------------------------------------------------------------

def _mkline(text, font="Times-Roman", size=10):
    return {"spans": [{"text": text, "font": font, "size": size}]}


check("公式行：纯公式判定为真", _formula_text_only("P(d_i)=w_i / sum_j w_j") is True)
check(
    "公式行：正文夹等号不判定为公式",
    _formula_text_only("where P(d_i)=w_i is the probability of the operator") is False,
)
check("公式行：数学字体行判定为公式", _line_is_formula_only(_mkline("x_i = y_i", "CMMI10")) is True)
_runs = _split_formula_lines(
    [
        _mkline("The operator is selected as follows."),
        _mkline("P(d_i)=w_i", "CMMI10"),
        _mkline("Each operator keeps its own weight."),
    ]
)
check(
    "公式行：正文/公式/正文被拆成三段",
    [flag for flag, _ in _runs] == [False, True, False]
    and ["".join(s["text"] for s in ln["spans"]) for _, part in _runs for ln in part]
    == [
        "The operator is selected as follows.",
        "P(d_i)=w_i",
        "Each operator keeps its own weight.",
    ],
    str(_runs),
)
check(
    "公式行：拆分出的公式块直接归类为 formula",
    _classify_block({"formulaOnly": True, "raw": "P(d_i)=w_i", "nlines": 1}, 10.0) == "formula",
)
check(
    "首页识别：编号解释段不误判为作者行（单页重译也会 pno=0）",
    _role_hint(
        "1. Adaptive Weights Update: To guide the search direction during the current episode, "
        "the weights of the selected operators are updated by lambda.",
        9.9,
        10.0,
        0,
        fitz.Rect(10, 300, 400, 340),
        800,
        20,
    )
    != "authors",
)
check(
    "首页识别：真正姓名列表仍判为作者行",
    _role_hint(
        "Alice Zhang, Bob Li, Carol Wang, David Chen",
        9.9,
        10.0,
        0,
        fitz.Rect(10, 100, 400, 130),
        800,
        20,
    )
    == "authors",
)

# ---------------------------------------------------------------------------
# 鉴权头：按**接口协议**选（OpenAI /chat/completions -> Bearer，
# Anthropic /messages -> x-api-key），不按网关域名判定
# ---------------------------------------------------------------------------

from app.model_auth import auth_headers, auth_protocol_for_url, is_opencode_base  # noqa: E402

check(
    "鉴权头：OpenAI 协议的 /chat/completions 用 Bearer（即使是 opencode 域名）",
    auth_headers("https://opencode.ai/zen/go/v1/chat/completions", "sk-test")
    == {"Authorization": "Bearer sk-test"},
)
check(
    "鉴权头：base URL（不带路径）按 OpenAI 协议发 Bearer",
    auth_headers("https://opencode.ai/zen/go/v1", "sk-test")
    == {"Authorization": "Bearer sk-test"},
)
check(
    "鉴权头：Anthropic Messages 协议用 x-api-key",
    auth_headers("https://gw.example.com/v1/messages", "sk-test") == {"x-api-key": "sk-test"},
)
check(
    "鉴权头：api.anthropic.com 判定为 Anthropic 协议",
    auth_protocol_for_url("https://api.anthropic.com/v1/messages") == "anthropic",
)
check(
    "鉴权头：协议可显式覆盖 URL 推断",
    auth_headers("https://gw.example.com/v1/chat/completions", "sk-test", None, "anthropic")
    == {"x-api-key": "sk-test"},
)
check(
    "鉴权头：数据源探测路径 /zen/go 仍可识别（仅用于附加会话头）",
    is_opencode_base("https://relay.example.com/zen/go/v1") is True,
)
check(
    "鉴权头：Anthropic 协议不残留 Bearer（避免双鉴权头）",
    "Authorization"
    not in auth_headers("https://gw.example.com/v1/messages", "sk-test", {"Authorization": "Bearer old"}),
)
check(
    "鉴权头：OpenAI 协议不残留 x-api-key（避免双鉴权头）",
    "x-api-key"
    not in auth_headers(
        "https://opencode.ai/zen/go/v1/chat/completions", "sk-test", {"x-api-key": "old"}
    ),
)
check(
    "鉴权头：保留已有的 UA / 会话头",
    auth_headers(
        "https://opencode.ai/zen/go/v1/chat/completions",
        "sk-test",
        {"x-opencode-session": "selection"},
    ).get("x-opencode-session")
    == "selection",
)
check("鉴权头：空 key 不生成鉴权头", auth_headers("https://api.openai.com/v1", "") == {})

_missing_msg = ""
try:
    # 未配置 apiKey 时必须在发请求前失败，而不是拿空凭据去换 401
    translate_text("hello", "openai", "zh", "https://api.openai.com/v1", None, "gpt-4o-mini")
except Exception as _exc:  # noqa: BLE001
    _missing_msg = str(_exc)
check(
    "未配置 apiKey：不发请求且提示「未配置翻译密钥」",
    "未配置翻译密钥" in _missing_msg,
    _missing_msg,
)

print("TRANSLATE_OK" if failed == 0 else f"TRANSLATE_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
