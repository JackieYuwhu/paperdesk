"""可选引擎：MinerU —— 把 PDF 转成带 LaTeX 公式的 Markdown。

依赖较重且首次运行需下载模型，因此做成「尽力而为」：
  * 未安装 / 调用失败 -> 抛异常，由调用方回退到内置引擎
安装：pip install "mineru[core]"（或旧版 magic-pdf）
"""

from __future__ import annotations

import glob
import importlib.util
import os
import shutil
import subprocess
import sys


def is_available() -> bool:
    """不做实际导入，避免启动开销。"""
    if shutil.which("mineru") or shutil.which("magic-pdf"):
        return True
    try:
        return importlib.util.find_spec("mineru") is not None
    except Exception:  # noqa: BLE001
        return False


def run_mineru(pdf_path: str, out_dir: str, timeout: float = 1800.0) -> str:
    """调用 MinerU，返回产出的 Markdown 路径。失败抛异常。"""
    if not is_available():
        raise RuntimeError("未检测到 MinerU（pip install 'mineru[core]'）")
    os.makedirs(out_dir, exist_ok=True)

    cli = shutil.which("mineru") or shutil.which("magic-pdf")
    if cli:
        cmd = [cli, "-p", pdf_path, "-o", out_dir]
    else:
        cmd = [sys.executable, "-m", "mineru", "-p", pdf_path, "-o", out_dir]

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "MinerU 执行失败")[-400:])

    mds = sorted(glob.glob(os.path.join(out_dir, "**", "*.md"), recursive=True), key=os.path.getmtime)
    if not mds:
        raise RuntimeError("MinerU 未产出 Markdown")
    return mds[-1]
