"""评测指标的正确性验证（用**人工标注的合成表**校验指标数学）。

真实复核表由 `eval_baseline.py dump` 生成、由人填写；这里只保证：
  · 检测 precision/recall 的混淆矩阵正确
  · **错误接受率**（accepted 但判错）被正确统计
  · 回退接受率（非 accepted 但产出仍正确）
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from eval_baseline import (  # noqa: E402
    dump_sheet,
    format_sheet,
    score_by_paper,
    score_sheet,
    split_by_paper,
)

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {extra}")


# ---- 合成标注表：2 真阳 / 1 假阳 / 1 真阴 / 1 假阴 ----
rows = [
    # 是公式 + 产出正确 → TP，且 accepted 且与期望一致 → 不算错误接受
    {"reviewed": True, "is_formula": True, "expect_latex": "a=b", "latex": "a=b", "status": "accepted"},
    # 是公式 + 非 accepted 但产出正确 → TP + 回退够用
    {"reviewed": True, "is_formula": True, "expect_latex": "\\frac{a}{b}", "latex": "\\frac{a}{b}", "status": "needs_review"},
    # 不是公式但产出了 → FP；且 accepted → **错误接受**
    {"reviewed": True, "is_formula": False, "expect_latex": None, "latex": "x=1", "status": "accepted"},
    # 不是公式且没产出 → TN
    {"reviewed": True, "is_formula": False, "expect_latex": None, "latex": None, "status": "failed"},
    # 是公式但没产出 → FN
    {"reviewed": True, "is_formula": True, "expect_latex": "y=2", "latex": None, "status": "failed"},
    # 未标注 → 不参与指标
    {"reviewed": False, "is_formula": None, "expect_latex": None, "latex": None, "status": "failed"},
]
s = score_sheet(rows)
check("混淆矩阵正确", s["confusion"] == {"tp": 2, "fp": 1, "fn": 1, "tn": 1}, str(s["confusion"]))
check("检测 precision = 2/3", abs((s["detection_precision"] or 0) - 2 / 3) < 1e-9, str(s["detection_precision"]))
check("检测 recall = 2/3", abs((s["detection_recall"] or 0) - 2 / 3) < 1e-9, str(s["detection_recall"]))
check("结构还原正确率 = 2/3", abs((s["reconstruction_accuracy"] or 0) - 2 / 3) < 1e-9, str(s["reconstruction_accuracy"]))
check("错误接受率 = 1/2（accepted 里 1 条判错）", abs((s["wrong_accept_rate"] or 0) - 0.5) < 1e-9, str(s["wrong_accept_rate"]))
check(
    "回退接受率 = 1/2（needs_review 产出正确、failed 无产出）",
    abs((s["fallback_accept_rate"] or 0) - 0.5) < 1e-9,
    str(s["fallback_accept_rate"])
)
check("只统计已标注条目", s["labeled"] == 5 and s["total"] == 6, str(s))

# ---- dump_sheet：对一份合成 PDF 也能产出复核条目 ----
import tempfile  # noqa: E402

import fitz  # noqa: E402

doc = fitz.open()
page = doc.new_page(width=400, height=300)
page.insert_text((50, 100), "E = m c^2", fontsize=12)
tmp = os.path.join(tempfile.mkdtemp(), "s.pdf")
doc.save(tmp)
doc.close()
dumped = dump_sheet([tmp])
check("dump_sheet：产出可复核条目（含原文与状态）", len(dumped) >= 1 and "raw_text" in dumped[0], str(dumped[:1]))
check("dump_sheet：复核字段默认为空（待人工填写）", dumped[0]["reviewed"] is None and dumped[0]["is_formula"] is None)
check("format_sheet：生成 Markdown 表", "| # |" in format_sheet(dumped), format_sheet(dumped)[:60])

# ---- 按论文切分（dev/test）+ per-paper 指标 ----
mix = [
    {"paper": "A.pdf", "reviewed": True, "is_formula": True, "expect_latex": "a", "latex": "a", "status": "accepted"},
    {"paper": "B.pdf", "reviewed": True, "is_formula": False, "expect_latex": None, "latex": "x", "status": "accepted"},
    {"paper": "C.pdf", "reviewed": True, "is_formula": True, "expect_latex": "c", "latex": None, "status": "failed"}
]
s1 = split_by_paper(mix, 50, 42)
s2 = split_by_paper(mix, 50, 42)
check(
    "split_by_paper：确定性（同输入同切分）",
    [r["paper"] for r in s1["dev"]] == [r["paper"] for r in s2["dev"]],
    f"{[r['paper'] for r in s1['dev']]} vs {[r['paper'] for r in s2['dev']]}"
)
check(
    "split_by_paper：同一论文不跨集",
    not (set(r["paper"] for r in s1["dev"]) & set(r["paper"] for r in s1["test"])),
    str(s1)
)
check(
    "split_by_paper：覆盖全部论文",
    len(s1["dev"]) + len(s1["test"]) == len(mix),
    f"{len(s1['dev'])}+{len(s1['test'])}"
)
per = score_by_paper(mix)
check(
    "score_by_paper：按论文给出指标（含错误接受）",
    per["B.pdf"]["wrong_accept_rate"] == 1.0 and per["A.pdf"]["wrong_accept_rate"] == 0.0,
    str({k: v["wrong_accept_rate"] for k, v in per.items()})
)

print("EVAL_METRICS_OK" if failed == 0 else f"EVAL_METRICS_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
