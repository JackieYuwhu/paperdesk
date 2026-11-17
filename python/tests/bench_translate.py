"""真实端到端翻译基准（使用现有 Key 配置）。

用法（PowerShell）：

    $env:PAPERDESK_MT_BASEURL="https://opencode.ai/zen/go/v1"
    $env:PAPERDESK_MT_APIKEY="<你的 key>"
    $env:PAPERDESK_MT_MODEL="deepseek-v4.1-flash"
    python python\\tests\\bench_translate.py "C:\\path\\paper.pdf" --mode coarse

输出：总耗时、各阶段耗时、请求数与接口等待时间、失败段数、重试次数。
不做任何排版裁剪，结果写到临时目录。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.translate import simple_translate  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", help="输入 PDF 路径")
    ap.add_argument("--mode", default="coarse", choices=["fine", "coarse"])
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--batch", type=int, default=0, help="每批块数（0=默认）")
    ap.add_argument("--workers", type=int, default=0, help="并发数（0=默认）")
    args = ap.parse_args()

    base = os.environ.get("PAPERDESK_MT_BASEURL", "").strip()
    key = os.environ.get("PAPERDESK_MT_APIKEY", "").strip()
    model = os.environ.get("PAPERDESK_MT_MODEL", "").strip()
    if not (base and key and model):
        print(
            "缺少配置：请先设置 PAPERDESK_MT_BASEURL / PAPERDESK_MT_APIKEY / PAPERDESK_MT_MODEL",
            file=sys.stderr,
        )
        return 2

    out = os.path.join(tempfile.mkdtemp(), "bench.zh.pdf")
    t0 = time.time()
    res = simple_translate(
        args.pdf,
        out,
        target_lang=args.lang,
        backend="openai",
        base_url=base,
        api_key=key,
        model=model,
        mode=args.mode,
        batch_size=args.batch or None,
        max_workers=args.workers or 4,
    )
    wall = time.time() - t0
    report = {
        "pdf": os.path.abspath(args.pdf),
        "mode": args.mode,
        "wallSeconds": round(wall, 1),
        "timing": res.get("timing"),
        "coverage": res.get("coverage"),
        "pages": res.get("pages"),
        "blocks": res.get("blocks"),
        "warnings": res.get("warnings"),
        "outPath": out,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))

    timing = res.get("timing") or {}
    req = timing.get("requests") or 0
    print(
        "\n== 摘要 ==\n"
        f"模式 {args.mode} · 总耗时 {wall:.1f}s\n"
        f"阶段 {timing.get('stages')}\n"
        f"请求 {req} 个 · 接口等待 {timing.get('requestSeconds')}s · 平均 {timing.get('avgRequestSeconds')}s/请求\n"
        f"失败批次 {timing.get('failedBatches')} · 重试 {timing.get('retries')} · "
        f"失败段 {(res.get('coverage') or {}).get('failedBlocks')}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
