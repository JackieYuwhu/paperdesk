"""pdf2zh 外部引擎适配。

产物必须来自**本次运行独立的临时目录**：
旧实现把输出直接写进共享的 translated/ 目录，找不到 `<stem>-mono.pdf` 时
会枚举目录里任意非 dual PDF 并 move 走——可能搬走另一篇论文的历史译文。
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import tempfile


def _find_cli() -> str | None:
    exe = shutil.which("pdf2zh")
    if exe:
        return exe
    # 常见安装位置（pip --user / venv）
    pats = [
        os.path.expanduser("~/.local/bin/pdf2zh"),
        os.path.expanduser("~/AppData/Roaming/Python/*/Scripts/pdf2zh.exe"),
        os.path.expanduser("~/AppData/Local/Programs/Python/*/Scripts/pdf2zh.exe"),
    ]
    for p in pats:
        hits = glob.glob(p)
        if hits:
            return hits[0]
    return None


def run_pdf2zh(src: str, out: str, target_lang: str = "zh") -> dict:
    """调用 pdf2zh CLI，并只接受本次任务目录中产生的 mono PDF。"""
    try:
        import pdf2zh  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"pdf2zh 未安装: {exc}") from exc

    cli = _find_cli()
    cmd = [cli] if cli else [sys.executable, "-m", "pdf2zh"]
    tmp_dir = tempfile.mkdtemp(prefix="paperdesk-pdf2zh-")
    try:
        result = subprocess.run(
            cmd + [src, "-o", tmp_dir, "-li", "en", "-lo", target_lang[:2]],
            capture_output=True,
            text=True,
            timeout=1800,
        )
        if result.returncode != 0:
            raise RuntimeError(f"pdf2zh 失败: {result.stderr[-400:]}")

        mono = os.path.join(tmp_dir, os.path.splitext(os.path.basename(src))[0] + "-mono.pdf")
        if not os.path.exists(mono):
            # 只在**本次任务目录**内兜底（这里的文件一定由本任务产生），
            # 绝不去共享输出目录挑文件。
            candidates = [
                f
                for f in os.listdir(tmp_dir)
                if f.lower().endswith(".pdf") and "dual" not in f.lower()
            ]
            if not candidates:
                raise RuntimeError("pdf2zh 未产出 PDF（未找到 -mono.pdf）")
            if len(candidates) > 1:
                raise RuntimeError(
                    "pdf2zh 产出了多个候选 PDF，无法确定产物: " + ", ".join(sorted(candidates))
                )
            mono = os.path.join(tmp_dir, candidates[0])

        # 产物校验：必须是可读 PDF，且页数与源文件一致（对照阅读依赖页对应）
        import fitz

        try:
            with fitz.open(mono) as d:
                pages = d.page_count
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"pdf2zh 产物不是可读 PDF: {str(exc)[:160]}") from exc
        if pages <= 0:
            raise RuntimeError("pdf2zh 产物页数为 0")
        try:
            with fitz.open(src) as d:
                src_pages = d.page_count
        except Exception:  # noqa: BLE001
            src_pages = pages
        if src_pages and pages != src_pages:
            raise RuntimeError(f"pdf2zh 产物页数不一致（原文 {src_pages} / 译文 {pages}）")

        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        shutil.move(mono, out)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        "engine": "pdf2zh",
        "backend": "pdf2zh",
        "targetLang": target_lang,
        "pages": pages,
        "blocks": 0,
        "outPath": out,
        "warnings": [],
    }
