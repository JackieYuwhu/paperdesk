"""GROBID 客户端 + TEI 解析（可选，用于高质量的作者/引用抽取）。"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from . import _http as http

TEI = "{http://www.tei-c.org/ns/1.0}"


def is_available(base_url: str, timeout: float = 2.0) -> bool:
    try:
        r = http.get(base_url.rstrip("/") + "/api/isalive", timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False


def _text(el: ET.Element | None) -> str | None:
    if el is None:
        return None
    s = "".join(el.itertext()).strip()
    return s or None


def _author_name(author: ET.Element) -> str | None:
    pers = author.find(f"{TEI}persName")
    if pers is None:
        return _text(author)
    fore = " ".join(t for t in (_text(pers.find(f"{TEI}forename")) or "",) if t)
    sur = _text(pers.find(f"{TEI}surname")) or ""
    name = (f"{fore} {sur}").strip() or _text(pers)
    return name or None


def parse_tei(xml: str) -> dict:
    root = ET.fromstring(xml)

    title = None
    for t in root.iter(f"{TEI}title"):
        if t.get("type") in (None, "main"):
            title = _text(t)
            if title:
                break

    authors: list[str] = []
    for a in root.iter(f"{TEI}author"):
        n = _author_name(a)
        if n and n not in authors:
            authors.append(n)

    references: list[dict] = []
    for i, bibl in enumerate(root.iter(f"{TEI}biblStruct")):
        doi = None
        for idno in bibl.iter(f"{TEI}idno"):
            if (idno.get("type") or "").lower() == "doi":
                doi = _text(idno)
        ref_title = None
        bt = bibl.find(f".//{TEI}title")
        ref_title = _text(bt)
        year = None
        d = bibl.find(f".//{TEI}date")
        if d is not None:
            year = d.get("when") or _text(d)
        if doi or ref_title:
            references.append(
                {
                    "index": i + 1,
                    "raw": ref_title or (f"doi:{doi}" if doi else ""),
                    "doi": (doi or "").lower() or None,
                    "title": ref_title,
                    "year": year,
                    "via": "grobid",
                }
            )

    contexts: list[dict] = []
    for ref in root.iter(f"{TEI}ref"):
        if ref.get("type") != "bibr":
            continue
        tgt = (ref.get("target") or "").lstrip("#")
        txt = _text(ref)
        if tgt or txt:
            contexts.append({"target": tgt, "text": txt})

    return {
        "source": "grobid",
        "metadata": {"title": title, "authors": authors},
        "references": references,
        "contexts": contexts,
    }


def process_fulltext(pdf_path: str, base_url: str, timeout: float = 180.0) -> dict:
    url = base_url.rstrip("/") + "/api/processFulltextDocument"
    with open(pdf_path, "rb") as fh:
        files = {"input": ("file.pdf", fh, "application/pdf")}
        data = {
            "consolidateHeader": "1",
            "consolidateCitations": "0",
            "teiCoordinates": "true",
        }
        r = http.post(url, files=files, data=data, timeout=timeout)
    r.raise_for_status()
    return parse_tei(r.text)
