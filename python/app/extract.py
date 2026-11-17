"""本地 PDF 抽取：页数 / 元数据 / 参考文献（不依赖外部服务）。

设计为「无 GROBID 也能用」的降级路径：
  * 用 PyMuPDF 读页数、Info 元数据（title/author）、全文
  * **按分栏阅读顺序**重组每页文本（双栏论文不再串行，参考文献可正确切分）
  * Info 缺标题/作者时用**版面启发式**推断（首页最大字号块 = 标题；其下方姓名风格行 = 作者）
  * 用启发式切分「References」段落，逐条抽取 DOI
GROBID 可用时由 main.py 覆盖/合并更精确的结果。
"""

from __future__ import annotations

import re

import fitz  # PyMuPDF

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.IGNORECASE)
REF_HEADING_RE = re.compile(r"^\s*(references|bibliography|works cited|参考文献|參考文獻)\s*$", re.IGNORECASE)
REF_ITEM_RE = re.compile(r"^\s*(\[\d+\]|\(\d+\)|\d+[.)])\s")
# 参考文献段之后的“新章节”标题，用于终止收集（避免把正文吞进最后一条）
SECTION_STOP_RE = re.compile(
    r"^\s*(appendix|acknowledg(e)?ments?|supplementary|supporting information|author contributions?|"
    r"conflicts? of interest|funding|data availability)\b",
    re.IGNORECASE,
)

MAX_TEXT = 200_000
# 「姓名词」：首字母大写的西文词，或 CJK 词
_NAME_WORD = r"(?:[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\u2019.\-]*|\u4e00-\u9fff+)"
_AUTHOR_STOP_RE = re.compile(
    r"(?i)(university|institute|department|school|college|laborator|@|https?://|abstract|"
    r"keywords?|introduction|corresponding)"
)
# 部分 arXiv PDF 把左侧竖排的收录戳当成最大字号文本；它不是论文标题。
_ARXIV_STAMP_RE = re.compile(
    r"^\s*arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s*\[[^\]]+\]\s*\d{1,2}\s+\w+\s+\d{4}\s*$",
    re.IGNORECASE,
)
_ASCII_WORD_RE = re.compile(r"[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F'\u2019.\-]*")


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def normalize_doi(raw: str) -> str:
    return raw.rstrip(".,;)]}").lower()


def parse_authors(raw: str) -> list[str]:
    """从作者字符串里解析作者名（兼容 Info.author 与首页启发式行）。

    保守策略：优先用 ``;`` / ``and`` / 顿号切分；逗号仅在“每段都像完整人名（含空格）”
    时视作分隔符，否则视为「姓, 名」这一种书写形式，避免把 'Zhang, Alice' 拆错。
    """
    s = (raw or "").strip()
    if not s:
        return []
    # 统一分隔符：and / & / 顿号 / 全角分号
    s2 = re.sub(r"\s+(and|&)\s+", ";", s, flags=re.IGNORECASE)
    s2 = s2.replace("、", ";").replace("；", ";")
    if ";" in s2:
        parts = [p.strip() for p in s2.split(";")]
    elif "," in s:
        comma_parts = [p.strip() for p in s.split(",") if p.strip()]
        if len(comma_parts) >= 2 and all(" " in p for p in comma_parts):
            parts = comma_parts  # "Alice Zhang, Bob Li" -> 两个人
        else:
            parts = [s]  # "Zhang, Alice" -> 一个人
    else:
        parts = [s]
    # 去掉纯数字/页码式的噪声段，并清理姓名末尾的上标编号/脚注符号。
    # 有些 PDF 的作者行没有逗号，而是 ``Name 1 Name 2``；上标数字同时也是分隔符。
    expanded: list[str] = []
    for p in parts:
        if re.search(r"\s+\d", p):
            pieces = re.split(r"\s+\d+(?:\s+\d+)*\s*[*†‡§¶\u2217]*\s*", p)
        else:
            pieces = [p]
        expanded.extend(pieces)
    cleaned = (re.sub(r"[\d*†‡§¶\u2217]+$", "", x.strip()).strip() for x in expanded)
    return [p for p in cleaned if p and not re.fullmatch(r"[\d\s*†‡§¶\u2217]+", p)]


def split_references(full_text: str) -> list[str]:
    """按 'References' 标题 + 条目编号切分参考文献。"""
    lines = [ln.strip() for ln in full_text.splitlines()]
    idx = None
    for i, ln in enumerate(lines):
        if REF_HEADING_RE.match(ln):
            idx = i
    if idx is None:
        for i, ln in enumerate(lines):
            if ln.lower() in ("references", "bibliography"):
                idx = i
                break
    if idx is None:
        return []

    entries: list[str] = []
    cur: str | None = None
    for ln in lines[idx + 1 :]:
        if not ln:
            continue
        if REF_ITEM_RE.match(ln):
            if cur:
                entries.append(cur)
            cur = ln
        elif cur is not None:
            if REF_HEADING_RE.match(ln) or SECTION_STOP_RE.match(ln):
                break
            cur += " " + ln
    if cur:
        entries.append(cur)
    return [e for e in (_norm_ws(x) for x in entries) if len(e) > 3]


def _col_of(block: tuple, mid: float) -> int:
    """块所属栏：0=左（含跨栏），1=右。"""
    x0, x1 = block[0], block[2]
    if x0 < mid < x1:
        return 0  # 跨栏块（标题等）归左，按 y 参与排序
    return 0 if (x0 + x1) / 2 < mid else 1


def page_reading_text(page: "fitz.Page") -> str:
    """把一页重排为「左栏自上而下 -> 右栏自上而下」的阅读顺序文本。"""
    try:
        blocks = page.get_text("blocks")
    except Exception:  # noqa: BLE001
        blocks = []
    blocks = [b for b in blocks if len(b) >= 5 and isinstance(b[4], str) and b[4].strip()]
    if not blocks:
        return page.get_text("text")

    width = page.rect.width or 1.0
    mid = width / 2.0
    left_n = sum(1 for b in blocks if b[2] <= mid + 4)
    right_n = sum(1 for b in blocks if b[0] >= mid - 4)
    # 双栏判定：左右两半都各有若干“仅属于本半栏”的块
    two_col = left_n >= 2 and right_n >= 2 and (left_n + right_n) >= max(2, len(blocks) // 2)

    if two_col:
        ordered = sorted(blocks, key=lambda b: (_col_of(b, mid), round(b[1], 1), b[0]))
    else:
        # 单栏：PyMuPDF 返回的块序本身即阅读顺序，保持原序（避免破坏按内容流写入的顺序）
        ordered = blocks
    return "\n".join(_norm_ws(b[4]) for b in ordered)


def _looks_like_author_line(text: str) -> bool:
    t = (text or "").strip().rstrip("*†‡§¶0123456789 ,")
    if len(t) < 3 or len(t) > 220:
        return False
    if _AUTHOR_STOP_RE.search(t) or _ARXIV_STAMP_RE.match(t):
        return False
    # 编号单位行（"2 Independent Researcher"）不是作者。
    if re.match(r"^\s*\d+\s+", t):
        return False
    # 正文句子常以连字符断行，作者行不会这样结尾。
    if t.endswith("-"):
        return False
    if re.search(r"\d{3,}", t):  # 学号 / 年份 / 页码
        return False
    words = re.findall(_NAME_WORD, t)
    if len(words) < 2:
        return False
    all_words = _ASCII_WORD_RE.findall(t)
    if len(all_words) > 14:
        return False
    capped = [w for w in words if w[:1].isupper() or "\u4e00" <= w[0] <= "\u9fff"]
    # 作者行里大写姓名词应占多数；正文句子通常夹杂大量小写虚词。
    return len(capped) >= max(2, int(len(all_words) * 0.6))


def infer_title_authors(doc: "fitz.Document") -> tuple[str | None, list[str]]:
    """首页版面启发式：最大字号块 = 标题；其下方首个姓名风格行 = 作者。"""
    if doc.page_count == 0:
        return None, []
    try:
        data = doc[0].get_text("dict")
    except Exception:  # noqa: BLE001
        return None, []

    spans: list[tuple[float, str, tuple[float, float, float, float]]] = []
    lines: list[tuple[float, str, float]] = []
    for block in data.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        for line in block.get("lines", []):
            # 跳过竖排文字（如 arXiv 左侧收录戳），否则它的字号会压过真正标题。
            direction = line.get("dir") or (1, 0)
            if abs(float(direction[1])) > 0.01:
                continue
            line_texts: list[str] = []
            line_size = 0.0
            for span in line.get("spans", []):
                txt = (span.get("text") or "").strip()
                if not txt or _ARXIV_STAMP_RE.match(txt):
                    continue
                size = float(span.get("size", 0) or 0)
                bbox = tuple(span.get("bbox", (0.0, 0.0, 0.0, 0.0)))
                spans.append((size, txt, bbox))  # type: ignore[arg-type]
                line_texts.append(txt)
                line_size = max(line_size, size)
            line_text = _norm_ws(" ".join(line_texts))
            if line_text:
                lines.append((float(line["bbox"][1]), line_text, line_size))
    if not spans:
        return None, []

    max_size = max(s[0] for s in spans)
    title_spans = [s for s in spans if s[0] >= max_size - 0.5 and 2 <= len(s[1]) <= 200]
    title = _norm_ws(" ".join(s[1] for s in title_spans)) or None
    if title and (len(title) < 4 or title.lower() in ("untitled", "microsoft word")):
        title = None

    authors: list[str] = []
    if title:
        title_bottom = max((s[2][3] for s in title_spans), default=0.0)
        # 作者行要按整行判断：一行里常有多位作者，按 span 拆会只取到第一个人。
        candidates = [ln for ln in lines if ln[0] >= title_bottom - 1 and ln[2] < max_size - 0.5]
        candidates.sort(key=lambda ln: ln[0])
        chunks: list[str] = []
        last_y: float | None = None
        for y, text, _size in candidates[:20]:
            if _looks_like_author_line(text):
                # 同一行的多位作者可能是独立 span/line；先按 y 合并，再解析姓名。
                if chunks and last_y is not None and abs(y - last_y) < 2:
                    chunks[-1] = f"{chunks[-1]} {text}"
                else:
                    chunks.append(text)
                last_y = y
                if len(chunks) >= 3:  # 作者通常不超过三行
                    break
            elif chunks:
                break
        if chunks:
            authors = parse_authors(" ".join(chunks))
    return title, authors


def extract_local(path: str) -> dict:
    doc = fitz.open(path)
    try:
        page_count = doc.page_count
        meta = doc.metadata or {}
        title = (meta.get("title") or "").strip() or None
        authors = parse_authors(meta.get("author") or "")
        page_texts = [page_reading_text(page) for page in doc]
        full_text = "\n".join(page_texts)

        # Info 缺字段时用版面启发式补齐（仅在缺失时）
        if not title or not authors:
            h_title, h_authors = infer_title_authors(doc)
            if not title:
                title = h_title
            if not authors:
                authors = h_authors
    finally:
        doc.close()

    references = []
    for i, raw in enumerate(split_references(full_text)):
        dois = DOI_RE.findall(raw)
        references.append(
            {
                "index": i + 1,
                "raw": raw,
                "doi": normalize_doi(dois[0]) if dois else None,
                "title": None,
                "via": "text" if dois else None,
            }
        )

    all_dois = sorted({normalize_doi(d) for d in DOI_RE.findall(full_text)})

    return {
        "source": "fallback",
        "pageCount": page_count,
        "metadata": {"title": title, "authors": authors},
        "references": references,
        "dois": all_dois,
        "pages": [{"page": i + 1, "text": t} for i, t in enumerate(page_texts)],
        "fullText": full_text[:MAX_TEXT],
        "warnings": [],
    }
