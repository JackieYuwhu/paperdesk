"""Crossref 引用消解：把参考文献字符串/标题解析成 DOI。"""

from __future__ import annotations

from . import _http as http

CROSSREF = "https://api.crossref.org/works"


def _headers(mailto: str | None) -> dict:
    ua = "PaperDesk/0.1.0"
    if mailto:
        ua += f" (mailto:{mailto})"
    return {"User-Agent": ua}


def lookup(query: str, mailto: str | None = None, timeout: float = 8.0) -> dict | None:
    """用 query.bibliographic 做模糊匹配，返回最佳命中的 DOI。"""
    if not query or len(query) < 8:
        return None
    params = {"query.bibliographic": query, "rows": "1"}
    r = http.get(CROSSREF, params=params, headers=_headers(mailto), timeout=timeout)
    r.raise_for_status()
    items = (r.json().get("message") or {}).get("items") or []
    if not items:
        return None
    it = items[0]
    titles = it.get("title") or []
    return {
        "doi": (it.get("DOI") or "").lower() or None,
        "title": titles[0] if titles else None,
        "score": it.get("score"),
    }
