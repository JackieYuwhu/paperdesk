"""sidecar 导入自检：确保 app.main 能正常导入、关键路由齐全。

这类检查能拦住「编辑时把换行吃掉 / 语法错误」等低级问题（否则要等运行时才发现）。
运行：python tests/test_import.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {extra}")


try:
    from app.main import app  # noqa: E402

    paths = {r.path for r in app.routes}
    required = [
        "/health",
        "/extract",
        "/export",
        "/embed",
        "/structure",
        "/vision/metadata",
        "/inspect",
        "/skills/list",
        "/skills/save",
        "/skills/reset",
        "/skills/import",
        "/zip",
        "/translate",
        "/translate/start",
        "/translate/status/{job_id}",
        "/translate/cancel/{job_id}",
        "/translate/text",
        "/grobid/health",
    ]
    missing = [p for p in required if p not in paths]
    check("app.main 可导入", True)
    check("关键路由齐全", not missing, f"missing={missing}")

    # 各模块可导入
    import app.embed  # noqa: F401
    import app.export  # noqa: F401
    import app.grobid  # noqa: F401
    import app.mineru_engine  # noqa: F401
    import app.translate  # noqa: F401

    check("子模块可导入", True)
except Exception as exc:  # noqa: BLE001
    check("app.main 可导入", False, f"{type(exc).__name__}: {exc}")

print("IMPORT_OK" if failed == 0 else f"IMPORT_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
