"""对 samples/corpus 里的样例跑「抽取 + 分块分类」测评，并把结果写入 docs/EVAL.md。

用法：
  python scripts/make-corpus.py     # 先生成语料
  python scripts/eval-corpus.py     # 跑测评并更新 docs/EVAL.md
"""

from __future__ import annotations

import os
import sqlite3
import statistics
import sys
import time

import fitz  # PyMuPDF

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from app.extract import extract_local  # noqa: E402
from app.export import _classify, _extract_blocks  # noqa: E402
from app.translate import has_cjk  # noqa: E402

CORPUS = os.path.join(ROOT, "samples", "corpus")
OUT_MD = os.path.join(ROOT, "docs", "EVAL.md")


def cjk_ratio(text: str) -> float:
    if not text:
        return 0.0
    n = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    return n / len(text)


def measure(path: str) -> dict:
    doc = fitz.open(path)
    pages = doc.page_count
    text = "\n".join(pg.get_text() for pg in doc)
    kinds: dict[str, int] = {}
    try:
        blocks, sizes = _extract_blocks(doc)
        _classify(blocks, sizes)

        def kind_of(b: dict) -> str:
            if b.get("type") == "image":
                return "image"
            if b.get("formula"):
                return "formula"
            if b.get("heading"):
                return f"heading{b.get('heading')}"
            if b.get("bullet"):
                return "list"
            return "body"

        for b in blocks:
            k = kind_of(b)
            kinds[k] = kinds.get(k, 0) + 1
    except Exception as e:  # noqa: BLE001
        kinds = {"error": str(e)}  # type: ignore[dict-item]
    doc.close()

    t0 = time.perf_counter()
    meta: dict = {}
    try:
        meta = extract_local(path) or {}
    except Exception as e:  # noqa: BLE001
        meta = {"error": str(e)}
    extract_ms = (time.perf_counter() - t0) * 1000

    # 翻译流水线（mock 后端，不调用模型；测管道与分块，不测译文质量）
    tr: dict = {}
    try:
        import tempfile

        from app.translate import simple_translate  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "out.zh.pdf")
            t1 = time.perf_counter()
            r = simple_translate(path, out, target_lang="zh", backend="mock")
            tr = {
                "blocks": r.get("blocks"),
                "ms": round((time.perf_counter() - t1) * 1000, 1),
                "suspicious": (r.get("qa") or {}).get("suspicious"),
            }
    except Exception as e:  # noqa: BLE001
        tr = {"error": str(e)[:60]}

    return {
        "file": os.path.basename(path),
        "pages": pages,
        "chars": len(text),
        "has_text_layer": len(text.strip()) > 20,
        "cjk_ratio": round(cjk_ratio(text), 3),
        "has_cjk": has_cjk(text),
        "kinds": kinds,
        "title": (meta.get("title") or "")[:48],
        "refs": len(meta.get("references") or []),
        "extract_ms": round(extract_ms, 1),
        "trans": tr,
    }


def fts_bench(rows: int = 5000, queries: int = 30) -> float:
    """纯 stdlib sqlite3 的 FTS5 查询耗时（中位数，毫秒）。"""
    con = sqlite3.connect(":memory:")
    con.execute("CREATE VIRTUAL TABLE t USING fts5(title, body)")
    words = ["attention", "translation", "layout", "formula", "scanned", "column", "cjk", "paper"]
    con.executemany(
        "INSERT INTO t(title, body) VALUES (?, ?)",
        [(f"Paper {i}", " ".join(words[(i + k) % len(words)] for k in range(12))) for i in range(rows)],
    )
    con.execute("INSERT INTO t(t) VALUES ('optimize')")
    times = []
    for i in range(queries):
        q = words[i % len(words)]
        t0 = time.perf_counter()
        con.execute("SELECT count(*) FROM t WHERE t MATCH ?", (q,)).fetchone()
        times.append((time.perf_counter() - t0) * 1000)
    con.close()
    return round(statistics.median(times), 3)


def main() -> None:
    if not os.path.isdir(CORPUS):
        print("请先运行：python scripts/make-corpus.py")
        sys.exit(1)

    files = sorted(f for f in os.listdir(CORPUS) if f.endswith(".pdf") and f != "long-30p.pdf")
    rows = [measure(os.path.join(CORPUS, f)) for f in files]

    long_path = os.path.join(CORPUS, "long-30p.pdf")
    long_ms = None
    if os.path.exists(long_path):
        long_ms = measure(long_path)["extract_ms"]

    fts_ms = fts_bench()

    import platform
    import importlib.metadata as md

    try:
        pymupdf_v = md.version("pymupdf")
    except Exception:  # noqa: BLE001
        pymupdf_v = "?"

    lines = [
        "# 评估与性能记录（EVAL）",
        "",
        "> 由 `scripts/eval-corpus.py` 自动生成；语料由 `scripts/make-corpus.py` 生成。",
        "",
        f"- 生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 环境：Python {platform.python_version()} · PyMuPDF {pymupdf_v} · {platform.system()}",
        f"- 语料目录：`samples/corpus/`（已 gitignore，按需生成）",
        "",
        "## 1. 抽取与分块分类（按样本）",
        "",
        "| 样本 | 页数 | 文本字符 | 有文本层 | 中文占比 | 分类计数 | 推断标题 | 参考文献 | 抽取耗时(ms) | 翻译块 | 翻译(ms) | 疑似未译 |",
        "|---|---:|---:|:--:|---:|---|---|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        kinds = " ".join(f"{k}:{v}" for k, v in sorted(r["kinds"].items()))
        tr = r["trans"]
        lines.append(
            f"| {r['file']} | {r['pages']} | {r['chars']} | {'是' if r['has_text_layer'] else '否'} | "
            f"{r['cjk_ratio']} | {kinds} | {r['title']} | {r['refs']} | {r['extract_ms']} | "
            f"{tr.get('blocks', '—')} | {tr.get('ms', '—')} | {tr.get('suspicious', '—')} |"
        )
    lines += [
        "",
        "## 2. 性能",
        "",
        "| 项目 | 测量 |",
        "|---|---:|",
        f"| 30 页长文抽取 | {long_ms if long_ms is not None else '—'} ms |",
        f"| FTS5 查询（5000 行 × 30 次中位数） | {fts_ms} ms |",
        "",
        "## 3. 结论与待办",
        "",
        "- **扫描件**样本无文本层（`有文本层=否`），验证了「需走视觉/OCR 引擎」的判断路径。",
        "- **双栏**样本的分块分类结果用于校验阅读顺序（`extract.page_reading_text`）。",
        "- **公式**样本被分类为 `formula`（默认不翻译）；**中文**样本用于 `has_cjk` 与 CJK 字体链路。",
        "- **翻译列用 mock 离线后端**（占位译文，非真实翻译），因此「疑似未译」非零是预期；真实译文质量需在设置里配置模型后端后人工评估。",
        "- 性能为单机参考值，非基准；如需更严，请扩展 `eval-corpus.py` 增加重复次数与对比基线。",
        "",
    ]
    os.makedirs(os.path.dirname(OUT_MD), exist_ok=True)
    with open(OUT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("已写入", OUT_MD)
    for r in rows:
        print(f"  {r['file']}: pages={r['pages']} chars={r['chars']} text={r['has_text_layer']} kinds={r['kinds']}")


if __name__ == "__main__":
    main()
