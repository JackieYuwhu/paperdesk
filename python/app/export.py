"""把 PDF 导出为 md / html / pdf（尽量保留公式排版）。

思路：先用 PyMuPDF 抽取「块」（文本块 / 图片块），
  * 依据字号推断标题层级（正文字号为众数，标题按倍数判定）
  * 含数学符号且较短的块判定为「公式块」→ 输出时不重排（md 用 ```math 围栏，html/pdf 用等宽 pre 样式）
  * 图片按页顺序抽出：md 引用 assets/ 下的文件；html/pdf 内嵌 data URI（自包含）
pdf 使用 PyMuPDF 的 Story（HTML→PDF 排版引擎）生成。

说明：这是「不重排」的保守策略。若要真正的公式→LaTeX 转换，可接 MinerU 等引擎（/export 已预留 engine 参数）。
"""

from __future__ import annotations

import base64
import html as html_mod
import os
import re
from collections import Counter

import fitz  # PyMuPDF

MATH_HINTS = set("=∑∫√±×÷≈≠≤≥∞∂∇αβγθλμπσφψωΔΩ→←↔∈∉⊂⊃∪∩≪≫⟨⟩")
BULLET_RE = re.compile(r"^\s*([-•*·]|\d+[.)])\s+")


def _mode(nums: list[float]) -> float:
    if not nums:
        return 12.0
    return float(Counter(round(n) for n in nums).most_common(1)[0][0])


def _looks_like_formula(text: str) -> bool:
    t = text.strip()
    if not t or len(t) > 140:
        return False
    if any(ch in MATH_HINTS for ch in t):
        return True
    return (
        "=" in t
        and len(t) < 48
        and re.fullmatch(r"[\sA-Za-z0-9_^{}\[\]().,|+\-*/=<>&\\]+", t) is not None
    )


def _extract_blocks(doc: "fitz.Document") -> tuple[list[dict], list[float]]:
    blocks: list[dict] = []
    sizes: list[float] = []
    for pno, page in enumerate(doc):
        for b in page.get_text("dict").get("blocks", []):
            if b.get("type") == 1:
                blocks.append({"page": pno, "type": "image"})
                continue
            lines = b.get("lines", [])
            text = "\n".join(
                "".join(s.get("text", "") for s in ln.get("spans", [])) for ln in lines
            ).strip("\n")
            if not text.strip():
                continue
            max_size = max(
                (s.get("size", 0.0) for ln in lines for s in ln.get("spans", [])), default=0.0
            )
            sizes.append(max_size)
            blocks.append(
                {
                    "page": pno,
                    "type": "text",
                    "text": text,
                    "size": max_size,
                    "nlines": max(1, len(lines)),
                }
            )
    return blocks, sizes


def _classify(blocks: list[dict], sizes: list[float]) -> None:
    body = _mode(sizes)
    for b in blocks:
        if b["type"] != "text":
            continue
        size = b.get("size", body)
        text = b["text"]
        if size >= body * 1.55:
            b["heading"] = 1
        elif size >= body * 1.25:
            b["heading"] = 2
        elif size >= body * 1.1:
            b["heading"] = 3
        elif _looks_like_formula(text) and b["nlines"] <= 4:
            b["formula"] = True
        elif BULLET_RE.match(text):
            b["bullet"] = True


def _save_images(doc: "fitz.Document", out_dir: str) -> dict[int, list[dict]]:
    """按页导出图片，返回 {页码: [info, ...]}（与 page.get_images 顺序一致）。"""
    assets_dir = os.path.join(out_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    by_page: dict[int, list[dict]] = {}
    n = 0
    seen: set[int] = set()
    for pno, page in enumerate(doc):
        infos: list[dict] = []
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                infos.append({"file": None, "b64": None, "ext": None})
                continue
            seen.add(xref)
            try:
                info = doc.extract_image(xref)
            except Exception:  # noqa: BLE001
                infos.append({"file": None, "b64": None, "ext": None})
                continue
            n += 1
            ext = info.get("ext", "png")
            fname = f"img_{n}.{ext}"
            with open(os.path.join(assets_dir, fname), "wb") as fh:
                fh.write(info["image"])
            infos.append(
                {
                    "file": fname,
                    "b64": base64.b64encode(info["image"]).decode("ascii"),
                    "ext": ext,
                }
            )
        by_page[pno] = infos
    return by_page


class _ImageCursor:
    def __init__(self, by_page: dict[int, list[dict]]) -> None:
        self.by_page = by_page
        self.pos: dict[int, int] = {}

    def next(self, page: int) -> dict | None:
        lst = self.by_page.get(page, [])
        i = self.pos.get(page, 0)
        self.pos[page] = i + 1
        return lst[i] if i < len(lst) else None


def _to_markdown(blocks: list[dict], cursor: _ImageCursor) -> str:
    out: list[str] = []
    for b in blocks:
        if b["type"] == "image":
            info = cursor.next(b["page"])
            if info and info["file"]:
                out.append(f"\n![](assets/{info['file']})\n")
            continue
        text = b["text"].strip()
        if b.get("heading"):
            out.append(f"{'#' * b['heading']} {text.replace(chr(10), ' ')}\n")
        elif b.get("formula"):
            out.append("```math\n" + text + "\n```\n")
        else:
            out.append(text.replace("\n", " ") + "\n")
    return "\n".join(out)


CSS = """
body { max-width: 780px; margin: 0 auto; padding: 28px 22px; line-height: 1.7;
       font-family: -apple-system, 'Segoe UI', 'Noto Sans SC', sans-serif; color: #1a1d21; }
h1 { font-size: 1.7em; margin: 1.1em 0 .55em; text-align: center; }
h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
p { margin: .55em 0; }
.formula { white-space: pre; overflow-x: auto; font-family: 'Cambria Math', Consolas, monospace;
           background: #f6f8fa; border-left: 3px solid #d0d7de; padding: 8px 12px; margin: 10px 0; }
img { max-width: 100%; }
"""


def _body_html(blocks: list[dict], cursor: _ImageCursor, inline_images: bool) -> str:
    parts: list[str] = []
    for b in blocks:
        if b["type"] == "image":
            info = cursor.next(b["page"])
            if not info or not info["file"]:
                continue
            src = (
                f"data:image/{info['ext']};base64,{info['b64']}"
                if inline_images
                else f"assets/{info['file']}"
            )
            parts.append(f'<p><img src="{src}" alt=""/></p>')
            continue
        if b.get("heading"):
            lvl = min(3, b["heading"])
            parts.append(f"<h{lvl}>{html_mod.escape(b['text']).replace(chr(10), ' ')}</h{lvl}>")
        elif b.get("formula"):
            parts.append(f'<div class="formula">{html_mod.escape(b["text"])}</div>')
        else:
            parts.append(f"<p>{html_mod.escape(b['text']).replace(chr(10), '<br/>')}</p>")
    return "\n".join(parts)


def _write_html(out: str, body: str) -> None:
    doc = (
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"/>'
        f"<title>导出文档</title><style>{CSS}</style></head><body>{body}</body></html>"
    )
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(doc)


def _write_pdf(out: str, body: str) -> None:
    story = fitz.Story(html=f"<div>{body}</div>", user_css=CSS)
    writer = fitz.DocumentWriter(out)
    mediabox = fitz.paper_rect("a4")
    where = mediabox + (36, 36, -36, -36)
    guard = 0
    while True:
        guard += 1
        if guard > 5000:
            break
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
        if not more:
            break
    writer.close()


def _data_uri(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except Exception:  # noqa: BLE001
        return ""
    ext = os.path.splitext(path)[1].lstrip(".").lower() or "png"
    return f"data:image/{ext};base64,{base64.b64encode(raw).decode('ascii')}"


def _md_to_html(md_text: str, base_dir: str, inline_images: bool) -> str:
    """极简 Markdown -> HTML（标题/图片/公式块/段落），用于 MinerU 产出的 md。"""
    parts: list[str] = []
    for block in re.split(r"\n{2,}", md_text):
        b = block.strip()
        if not b:
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", b)
        if m:
            lvl = min(3, len(m.group(1)))
            parts.append(f"<h{lvl}>{html_mod.escape(m.group(2))}</h{lvl}>")
            continue
        img = re.match(r"^!\[[^\]]*\]\(([^)]+)\)$", b)
        if img:
            src = img.group(1)
            if inline_images:
                src = _data_uri(os.path.join(base_dir, src)) or src
            parts.append(f'<p><img src="{src}" alt=""/></p>')
            continue
        if b.startswith("$$") and b.endswith("$$"):
            parts.append(f'<div class="formula">{html_mod.escape(b)}</div>')
            continue
        text = html_mod.escape(b).replace("\n", "<br/>")
        # 行内公式：保留 LaTeX 原文，可交给前端 KaTeX 渲染
        text = re.sub(r"\$([^$\n]+)\$", r'<span class="math">\1</span>', text)
        parts.append(f"<p>{text}</p>")
    return "\n".join(parts)


def _export_with_mineru(md_path: str, out: str, fmt: str) -> None:
    md_text = open(md_path, encoding="utf-8").read()
    base_dir = os.path.dirname(md_path)
    if fmt == "md":
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(md_text)
        return
    body = _md_to_html(md_text, base_dir, inline_images=True)
    if fmt == "html":
        _write_html(out, body)
    else:
        _write_pdf(out, body)


def export_document(path: str, out: str, fmt: str = "md", engine: str = "simple") -> dict:
    fmt = (fmt or "md").lower()
    engine = (engine or "simple").lower()
    out_dir = os.path.dirname(out) or "."
    os.makedirs(out_dir, exist_ok=True)
    warnings: list[str] = []

    # 可选：MinerU（公式 -> LaTeX）
    if engine == "mineru":
        try:
            from .mineru_engine import run_mineru

            md_path = run_mineru(path, os.path.join(out_dir, "_mineru"))
            _export_with_mineru(md_path, out, fmt)
            return {
                "format": fmt,
                "engine": "mineru",
                "outPath": out,
                "pages": 0,
                "blocks": 0,
                "images": 0,
                "formulas": 0,
                "warnings": warnings,
            }
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"MinerU 不可用，已回退内置引擎: {str(exc)[:150]}")
            engine = "simple"

    doc = fitz.open(path)
    try:
        page_count = doc.page_count
        blocks, sizes = _extract_blocks(doc)
        _classify(blocks, sizes)
        has_img = any(b["type"] == "image" for b in blocks)
        by_page = _save_images(doc, out_dir) if has_img else {}
    finally:
        doc.close()

    if fmt == "md":
        cursor = _ImageCursor(by_page)
        content = _to_markdown(blocks, cursor)
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(content)
    elif fmt == "html":
        body = _body_html(blocks, _ImageCursor(by_page), inline_images=True)
        _write_html(out, body)
    elif fmt == "pdf":
        body = _body_html(blocks, _ImageCursor(by_page), inline_images=True)
        _write_pdf(out, body)
    else:
        raise ValueError(f"不支持的导出格式: {fmt}")

    images = sum(1 for p in by_page.values() for i in p if i.get("file"))
    return {
        "format": fmt,
        "engine": engine,
        "outPath": out,
        "pages": page_count,
        "blocks": sum(1 for b in blocks if b["type"] == "text"),
        "images": images,
        "formulas": sum(1 for b in blocks if b.get("formula")),
        "warnings": warnings,
    }
