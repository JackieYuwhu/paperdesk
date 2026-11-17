"""视觉识别翻译 / 元数据抽取。

把 PDF 页面渲染成图片，交给**多模态模型**（如 deepseek-v4.1-flash 等支持视觉的
OpenAI 兼容 /chat/completions 模型）来识别并翻译 / 抽取元数据。
用于**扫描件或没有文本层**的 PDF——这类文档走不了本地文本抽取。
"""

from __future__ import annotations

import base64
import json
import os
import re
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

import fitz  # PyMuPDF

from .translate import CJK_FONT, cjk_fontname, has_cjk

DPI = 150


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def page_count(path: str) -> int:
    doc = fitz.open(path)
    try:
        return doc.page_count
    finally:
        doc.close()


def render_pages_b64(path: str, page_indices: list[int], dpi: int = DPI) -> list[str]:
    doc = fitz.open(path)
    out: list[str] = []
    try:
        for i in page_indices:
            if 0 <= i < doc.page_count:
                pix = doc[i].get_pixmap(dpi=dpi)
                out.append(_b64(pix.tobytes("png")))
    finally:
        doc.close()
    return out


def _api_error(body: str) -> str:
    try:
        j = json.loads(body)
        for path in (("error", "message"), ("error", "error", "message"), ("message",)):
            cur = j
            ok = True
            for k in path:
                if isinstance(cur, dict) and k in cur:
                    cur = cur[k]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, str) and cur:
                return cur[:200]
    except Exception:  # noqa: BLE001
        pass
    return body[:200]


def chat_vision(
    base_url: str | None,
    api_key: str | None,
    model: str | None,
    headers: dict | None,
    prompt: str,
    images_b64: list[str],
    timeout: float = 180.0,
) -> str:
    """调用多模态模型：一条文本提示 + 若干张图片，返回文本。"""
    from . import _http as http
    from .model_auth import auth_headers
    from .model_protocol import chat_endpoint, chat_payload, response_text

    if not base_url or not api_key:
        raise RuntimeError("视觉翻译需要模型服务：请在「设置」里填写 Base URL 与 API Key")
    url = chat_endpoint(base_url)
    content: list[dict] = [{"type": "text", "text": prompt}]
    for b in images_b64:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}})
    body, req_headers = chat_payload(url, {
        "model": model or "gpt-4o-mini",
        "temperature": 0,
        "messages": [{"role": "user", "content": content}],
    }, auth_headers(url, api_key, headers))
    r = http.post(url, json=body, headers=req_headers, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code} {_api_error(r.text)}")
    return (response_text(r.json()) or "").strip()


def _lang_name(lang: str) -> str:
    m = {"zh": "中文", "en": "英文", "ja": "日文", "ko": "韩文", "fr": "法文", "de": "德文"}
    return m.get((lang or "zh").lower(), lang)


def _write_text_pdf(out: str, pages_text: list[str]) -> dict:
    """把每页译文写入一个文本 PDF（一页源文 → 一页输出）。

    放不下的页面**不再静默留白**：PDF 内给出明确提示，完整译文按源页写入
    `<out>.overflow.json`；段数/统计返回给调用方。不追加页面，保持页对应。
    """
    doc = fitz.open()
    W, H = 595, 842  # A4
    margin = 54
    rect = fitz.Rect(margin, margin, W - margin, H - margin)
    overflow: dict[str, str] = {}
    empty_pages: list[int] = []
    written = 0
    for idx, text in enumerate(pages_text):
        t = (text or "").strip()
        if not t:
            doc.new_page(width=W, height=H)
            empty_pages.append(idx + 1)
            continue
        placed = False
        for size in (10.5, 9.5, 8.5, 7.5, 6.5, 5.5, 4.5, 4.0):
            page = doc.new_page(width=W, height=H)
            fontname = cjk_fontname(page) if has_cjk(t) else "helv"
            rc = page.insert_textbox(rect, t, fontname=fontname, fontsize=size, lineheight=1.4)
            if rc >= 0:
                placed = True
                written += 1
                break
            doc.delete_page(doc.page_count - 1)  # 放不下：丢弃这张重试
        if not placed:
            # 4pt 仍放不下：写可读提示（不能留空白），完整译文进 overflow
            page = doc.new_page(width=W, height=H)
            fontname = cjk_fontname(page) if has_cjk(t) else "helv"
            notice = (
                f"第 {idx + 1} 页译文过长，未能在 4pt 下完整排入本页。\n\n"
                "完整译文已按源页写入同目录的 .overflow.json；"
                "如启用了 Markdown 导出，也可在 Markdown 中查看。\n"
                "源页数保持不变（未追加页面）。"
            )
            rc = page.insert_textbox(
                fitz.Rect(margin, margin, W - margin, H - margin),
                notice,
                fontname=fontname,
                fontsize=9.5,
                lineheight=1.5,
            )
            if rc < 0:
                try:
                    page.insert_text((margin, margin + 12), notice[:120], fontname=fontname, fontsize=8)
                except Exception:  # noqa: BLE001
                    pass
            overflow[str(idx + 1)] = t
    overflow_path = None
    if overflow:
        overflow_path = os.path.splitext(out)[0] + ".overflow.json"
        try:
            with open(overflow_path, "w", encoding="utf-8") as fh:
                json.dump(
                    {"pageCount": len(pages_text), "pages": overflow},
                    fh,
                    ensure_ascii=False,
                    indent=2,
                )
        except Exception:  # noqa: BLE001
            overflow_path = None
    try:
        doc.subset_fonts()
    except Exception:  # noqa: BLE001
        pass
    doc.save(out, garbage=3, deflate=True, clean=True)
    doc.close()
    return {
        "written": written,
        "emptyPages": empty_pages,
        "overflowPages": sorted(int(k) for k in overflow),
        "overflowPath": overflow_path,
    }


def translate_pdf_vision(
    src: str,
    out: str,
    target_lang: str = "zh",
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    headers: dict | None = None,
    on_progress=None,
    is_cancelled=None,
    html_out: str | None = None,
    md_out: str | None = None,
    max_workers: int = 4,
) -> dict:
    """逐页「模型看图 → 输出译文 Markdown」→ 组装成文本 PDF（多页并发）。"""

    def report(stage: str, done: int, total: int) -> None:
        if on_progress is not None:
            try:
                on_progress(stage, done, total)
            except Exception:  # noqa: BLE001
                pass

    def cancelled() -> bool:
        return bool(is_cancelled and is_cancelled())

    report("analyzing", 0, 0)
    total = page_count(src)
    report("translating", 0, total)

    texts: list[str] = [""] * total

    def _one(i: int) -> tuple[int, str]:
        if cancelled():
            raise RuntimeError("已取消")
        imgs = render_pages_b64(src, [i])
        if cancelled():
            raise RuntimeError("已取消")
        prompt = (
            "你是严谨的学术论文翻译助手。请识别这张论文页面图片中的**全部正文**"
            "（忽略页眉、页脚与页码），将其完整翻译为"
            f"{_lang_name(target_lang)}；保留公式（用 LaTeX 或原样）、小标题与段落结构；"
            "输出纯 Markdown 正文；**不要输出页码、页眉、页脚**；不要任何解释性前言或结语。"
        )
        return i, chat_vision(base_url, api_key, model, headers, prompt, imgs)

    workers = max(1, min(int(max_workers or 4), max(1, total)))
    done = 0
    # 有界在途窗口：不要一次性把所有页面丢进线程池——取消时排队页仍会继续调用模型。
    pool = ThreadPoolExecutor(max_workers=workers)
    pending: dict = {}
    next_i = 0
    try:
        while next_i < total or pending:
            if cancelled():
                raise RuntimeError("已取消")
            while next_i < total and len(pending) < max(1, workers * 2):
                pending[pool.submit(_one, next_i)] = next_i
                next_i += 1
            if not pending:
                break
            finished, _ = wait(pending, timeout=1.0, return_when=FIRST_COMPLETED)
            if cancelled():
                raise RuntimeError("已取消")
            for fut in finished:
                i = pending.pop(fut)
                try:
                    _, t = fut.result()
                except Exception as exc:  # noqa: BLE001
                    if cancelled():
                        raise RuntimeError("已取消") from exc
                    raise RuntimeError(f"第 {i + 1} 页视觉翻译失败：{str(exc)[:200]}") from exc
                texts[i] = t
                done += 1
                report("translating", done, total)
    finally:
        # 取消/失败：取消尚未开始的页，且不等待在途请求（它们最长 180s）。
        for fut in list(pending):
            fut.cancel()
        try:
            pool.shutdown(wait=False, cancel_futures=True)
        except TypeError:  # Python < 3.9
            pool.shutdown(wait=False)

    report("writing", 0, total)
    stats = _write_text_pdf(out, texts)
    warnings: list[str] = []
    if stats["overflowPages"]:
        warnings.append(
            f"有 {len(stats['overflowPages'])} 页译文过长，PDF 内已给出提示；"
            f"完整译文按源页写入 "
            f"{os.path.basename(stats['overflowPath'] or '') or '.overflow.json'}"
            "（未追加页面，页数保持 1:1）"
        )
    if stats["emptyPages"]:
        warnings.append(
            f"有 {len(stats['emptyPages'])} 页模型返回空内容："
            + ", ".join(str(x) for x in stats["emptyPages"][:8])
        )

    html_path = None
    if html_out:
        try:
            _write_vision_html(html_out, texts)
            html_path = html_out
        except Exception:  # noqa: BLE001
            html_path = None

    md_path = None
    if md_out:
        try:
            with open(md_out, "w", encoding="utf-8") as fh:
                for i, md in enumerate(texts):
                    fh.write(f"\n<!-- 第 {i + 1} 页 -->\n\n{md.strip()}\n")
            md_path = md_out
        except Exception:  # noqa: BLE001
            md_path = None

    report("done", total, total)
    return {
        "engine": "vision",
        "backend": "openai",
        "targetLang": target_lang,
        "pages": total,
        # blocks 只统计**真正落版**的页，不能把超长空白页算作成功
        "blocks": stats["written"],
        "outPath": out,
        "htmlPath": html_path,
        "bilingualPath": None,
        "mdPath": md_path,
        "bilingualMdPath": None,
        "overflowPath": stats["overflowPath"],
        "coverage": {
            "expected": total,
            "written": stats["written"],
            "overflowPages": len(stats["overflowPages"]),
            "emptyPages": len(stats["emptyPages"]),
            "failedPages": 0,
        },
        "warnings": warnings,
    }


def _write_vision_html(out: str, pages_md: list[str]) -> None:
    """把每页译文 Markdown 转成结构化 HTML（复用 export 的 md→html）。"""
    from .export import _md_to_html
    from .translate import _TR_CSS

    parts = [
        "<!doctype html><html lang='zh'><head><meta charset='utf-8'/>"
        f"<title>译文</title><style>{_TR_CSS}</style></head><body>"
    ]
    for i, md in enumerate(pages_md):
        parts.append(f"<section class='pg'><div class='pgno'>第 {i + 1} 页</div>")
        parts.append(_md_to_html(md or "", "", inline_images=True))
        parts.append("</section>")
    parts.append("</body></html>")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))


_META_PROMPT = (
    "你是文献元数据抽取助手。请阅读这些论文首页图片，输出**严格 JSON**（不要任何多余文字、"
    "不要 Markdown 代码围栏），字段如下：\n"
    '{"title": 字符串, "authors": [字符串], "abstract": 字符串, '
    '"year": 整数或 null, "venue": 字符串或 null, "doi": 字符串或 null}\n'
    "authors 用「名 姓」形式；abstract 用原文语言；找不到的字段用 null 或空数组。"
)


def extract_metadata_vision(
    src: str,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    headers: dict | None = None,
    max_pages: int = 2,
) -> dict:
    n = min(max_pages, page_count(src))
    imgs = render_pages_b64(src, list(range(n)))
    text = chat_vision(base_url, api_key, model, headers, _META_PROMPT, imgs, timeout=120.0)
    # 容错：截取第一个 { 到最后一个 }
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    try:
        data = json.loads(text)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"模型未返回合法 JSON：{str(exc)[:120]}") from exc

    authors = data.get("authors") or []
    if isinstance(authors, str):
        authors = [a.strip() for a in re.split(r"[;,]", authors) if a.strip()]
    year = data.get("year")
    try:
        year = int(year) if year is not None else None
    except (TypeError, ValueError):
        year = None
    return {
        "title": (data.get("title") or None),
        "authors": [str(a) for a in authors if str(a).strip()],
        "abstract": (data.get("abstract") or None),
        "year": year,
        "venue": (data.get("venue") or None),
        "doi": (data.get("doi") or None),
    }
