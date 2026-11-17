"""翻译**调度**基准（离线、无网络）：验证「请求数/批大小/波次」，不测真实模型质量。

背景：翻译慢的主因是模型请求延迟，而调度决定了要付几次延迟。真实端点上单请求耗时
随段数远快于线性（实测 4 段≈42s、8 段≈61s、16 段≈127s），所以最优是
「请求数不超过并发数（一波打完）+ 批尽量小」。本脚本用上述曲线替换真实请求，
只隔离调度，不把模拟当真实性能验收。

用法：

    python python\\tests\\bench_schedule.py            # 生成类论文样本并跑两种配置
    python python\\tests\\bench_schedule.py <paper.pdf> --workers 32 --scale 0.02

`--scale` 把「秒」缩放成测试用的小数值（比例不变），用于快速冒烟；
报告里的 `translateSeconds` 已换算回未缩放时间。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.translate import simple_translate  # noqa: E402

PAPER = (
    "We study layout preserving translation for scientific documents where the position "
    "of every text block must stay stable after translation. The system classifies blocks "
    "into body headings captions formulas references and margins, then translates only "
    "the blocks that carry natural language. Our evaluation covers single column two "
    "column scanned and formula heavy papers with a focus on faithfulness and readability. "
    "Experiments show that preserving geometry reduces reading effort while a careful "
    "tradeoff between font scaling and overflow reporting keeps every page readable. "
)
SECTIONS = [
    "Introduction", "Related Work", "Method", "Data and Evaluation",
    "Results", "Discussion", "Conclusion", "Limitations",
]
CAPTION = (
    "Figure {n}. Layout preservation rate over document categories. The horizontal axis "
    "shows page index and the vertical axis shows the fraction of text blocks that kept "
    "their original position after translation."
)


def latency(segments: int) -> float:
    """单请求延迟（秒）：按真实端点实测点线性插值/外推。"""
    if segments <= 4:
        return 42.0
    if segments <= 8:
        return 42.0 + (61.0 - 42.0) * (segments - 4) / 4.0
    if segments <= 16:
        return 61.0 + (127.0 - 61.0) * (segments - 8) / 8.0
    return 127.0 + (segments - 16) * 10.0


def make_paper(path: str, pages: int = 12) -> None:
    """两栏、分节、图题注、参考文献的类论文 PDF（只用于调度测量）。"""
    doc = fitz.open()
    cols = [(54.0, 282.0), (313.0, 541.0)]
    n_sec = 0
    for pno in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((54, 40), "Preprint 2026 - Schedule Bench", fontsize=8)
        if pno == 0:
            page.insert_text((54, 780), "Layout Preserving Translation of Scientific Papers", fontsize=17)
            page.insert_text((54, 762), "A. Author, B. Author, C. Author", fontsize=10)
            page.insert_text((54, 744), "Abstract", fontsize=12)
            page.insert_textbox(fitz.Rect(54, 700, 541, 740), PAPER * 2, fontsize=9.5, lineheight=1.2)
        for c, (x0, x1) in enumerate(cols):
            y = 684.0 if (pno == 0 and c == 0) else 780.0
            first = True
            while y > 120:
                if first and pno > 0 and c == 0:
                    page.insert_text((x0, y), f"{n_sec + 1}  {SECTIONS[n_sec % len(SECTIONS)]}", fontsize=12)
                    n_sec += 1
                    y -= 24
                first = False
                text = PAPER if (pno + c) % 2 else PAPER[:470]
                rect = fitz.Rect(x0, y - 168, x1, y)
                page.insert_textbox(rect, text, fontsize=9.5, lineheight=1.18)
                y = rect.y0 - 12
                if (pno * 2 + c) % 3 == 0 and y > 150:
                    page.insert_textbox(
                        fitz.Rect(x0, y - 58, x1, y),
                        CAPTION.format(n=n_sec + 1),
                        fontsize=8.5,
                        lineheight=1.15,
                    )
                    y -= 70
    page = doc.new_page(width=595, height=842)
    page.insert_text((54, 788), "References", fontsize=12)
    for k in range(26):
        page.insert_text(
            (54, 766 - k * 26),
            f"[{k + 1}] Smith J, Doe A. A representative reference title. Journal, 2024;{k + 1}:1-10.",
            fontsize=8.5,
        )
    doc.save(path)
    doc.close()


def run(pdf: str, workers: int, scale: float, mode: str) -> dict:
    calls: list[dict] = []
    lock = threading.Lock()

    import app.translate as TR

    def fake_many(texts, target_lang, base_url, api_key, model, extra_headers=None,
                  system=None, timeout=120.0, ids=None, no_think=True):
        t0 = time.monotonic()
        time.sleep(latency(len(texts)) * scale)
        t1 = time.monotonic()
        with lock:
            calls.append({"n": len(texts), "run": t1 - t0})
        return list(texts)

    TR._openai_translate_many = fake_many
    TR.extract_glossary = lambda *a, **k: []

    out = os.path.join(tempfile.mkdtemp(), "bench.zh.pdf")
    t0 = time.monotonic()
    res = TR.simple_translate(
        pdf,
        out,
        target_lang="zh",
        backend="openai",
        base_url="http://127.0.0.1:1/v1",
        api_key="bench",
        model="bench",
        mode=mode,
        max_workers=workers,
        auto_glossary=False,
    )
    wall = time.monotonic() - t0
    timing = res.get("timing") or {}
    sizes = [c["n"] for c in calls]
    translate = (timing.get("stages") or {}).get("translate") or 0.0
    return {
        "workers": workers,
        "mode": mode,
        "requests": len(calls),
        "batchSize": timing.get("batchSize"),
        "batchSizes": sorted(sizes),
        "waves": -(-len(calls) // max(1, workers)),
        "blocks": res.get("blocks"),
        "translateSeconds": round(translate / max(scale, 1e-9), 1),
        "localStagesSeconds": {
            k: round(v, 2)
            for k, v in (timing.get("stages") or {}).items()
            if k != "translate"
        },
        "wall": round(wall, 2),
        "simulatedRequestSeconds": round(sum(c["run"] for c in calls) / max(scale, 1e-9), 0),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?", default="")
    ap.add_argument("--workers", type=int, default=0, help="0=跑 24 与 32 两组")
    ap.add_argument("--scale", type=float, default=0.02)
    ap.add_argument("--mode", default="fine", choices=["fine", "coarse"])
    args = ap.parse_args()

    pdf = args.pdf
    if not pdf:
        pdf = os.path.join(tempfile.mkdtemp(), "schedule-bench.pdf")
        make_paper(pdf)

    workers_list = [args.workers] if args.workers else [24, 32]
    rows = [run(pdf, w, args.scale, args.mode) for w in workers_list]
    print(json.dumps({"pdf": os.path.abspath(pdf), "simulated": True, "runs": rows},
                     ensure_ascii=False, indent=2))
    for r in rows:
        print(
            f"workers={r['workers']} requests={r['requests']} batch={r['batchSize']} "
            f"waves={r['waves']} translate≈{r['translateSeconds']}s（模拟）"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
