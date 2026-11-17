"""真实评测基线：生成**人工复核表** + 依据标注计算指标。

用法：
    python python/tests/eval_baseline.py dump  [输出目录]      # 从真实论文生成复核表
    python python/tests/eval_baseline.py score <复核表.json>   # 依据人工标注算指标

复核表每条：
    {paper, page, bbox, raw_text, latex, status, det, rec,
     reviewed, is_formula, expect_latex}      # 后三项由人工填写

指标（`score_sheet`）：
    detection_precision / detection_recall   —— 是否公式（只看已标注条目）
    reconstruction_accuracy                  —— 是公式的条目里 LaTeX 与期望一致
    wrong_accept_rate                        —— **status=accepted 但人工判为错**（最危险）
    fallback_accept_rate                     —— status!=accepted 但产出仍与期望一致（回退够用）

注意：合成样例只作为**回归**，准确率结论应以本表的人工标注为准。
"""

from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.modules import extract_modules  # noqa: E402


def dump_sheet(pdf_paths: list[str]) -> list[dict]:
    """跑一遍提取器，把每个公式写成待复核条目。"""
    rows: list[dict] = []
    for p in pdf_paths:
        try:
            res = extract_modules(p)
        except Exception as exc:  # noqa: BLE001
            print(f"  跳过 {os.path.basename(p)}：{exc}")
            continue
        name = os.path.basename(p)
        for f in res.get("formulas", []):
            rows.append(
                {
                    "paper": name,
                    "page": f["page"],
                    "bbox": f["rect"],
                    "raw_text": f.get("rawText") or f.get("text") or "",
                    "latex": f.get("latex"),
                    "status": f.get("status"),
                    "det": f.get("detectionConfidence"),
                    "rec": f.get("reconstructionConfidence"),
                    "structure_kinds": sorted(_kinds(f.get("structure"))),
                    "reviewed": None,
                    "is_formula": None,
                    "expect_latex": None,
                }
            )
    return rows


def _kinds(node) -> set[str]:
    out: set[str] = set()

    def walk(n) -> None:
        if isinstance(n, dict):
            out.add(str(n.get("k")))
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for x in n:
                walk(x)

    walk(node)
    return out


def score_sheet(rows: list[dict]) -> dict:
    """依据人工标注（reviewed=True 的条目）计算指标。"""
    labeled = [r for r in rows if r.get("reviewed")]
    tp = fp = fn = tn = 0
    rec_ok = rec_total = 0
    wrong_accept = accepted_total = 0
    fallback_ok = fallback_total = 0
    for r in labeled:
        is_f = bool(r.get("is_formula"))
        produced = bool(r.get("latex"))
        if is_f and produced:
            tp += 1
        elif is_f and not produced:
            fn += 1
        elif not is_f and produced:
            fp += 1
        else:
            tn += 1
        if is_f:
            rec_total += 1
            want = (r.get("expect_latex") or "").strip()
            got = (r.get("latex") or "").strip()
            if want and got == want:
                rec_ok += 1
            if r.get("status") != "accepted":
                fallback_total += 1
                if want and got == want:
                    fallback_ok += 1
        if r.get("status") == "accepted":
            accepted_total += 1
            want = (r.get("expect_latex") or "").strip()
            got = (r.get("latex") or "").strip()
            # accepted 但「不是公式」或「与期望不符」→ 错误接受
            if not is_f or (want and got != want):
                wrong_accept += 1
    precision = tp / (tp + fp) if (tp + fp) else None
    recall = tp / (tp + fn) if (tp + fn) else None
    return {
        "labeled": len(labeled),
        "total": len(rows),
        "detection_precision": precision,
        "detection_recall": recall,
        "reconstruction_accuracy": (rec_ok / rec_total) if rec_total else None,
        "wrong_accept_rate": (wrong_accept / accepted_total) if accepted_total else None,
        "fallback_accept_rate": (fallback_ok / fallback_total) if fallback_total else None,
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


def score_by_paper(rows: list[dict]) -> dict[str, dict]:
    """按论文分组给指标（避免同篇论文的相似排版把总体指标带偏）。"""
    by_paper: dict[str, list[dict]] = {}
    for r in rows:
        by_paper.setdefault(r.get("paper") or "(unknown)", []).append(r)
    return {p: score_sheet(rs) for p, rs in by_paper.items()}


def _paper_hash(paper: str, seed: int = 42) -> str:
    """论文名的确定性哈希（决定论文在切分里的顺序）。"""
    import hashlib

    return hashlib.sha1(f"{seed}:{paper}".encode("utf-8")).hexdigest()


def split_by_paper(
    rows: list[dict], test_percent: int = 50, seed: int = 42
) -> dict[str, list[dict]]:
    """按**论文**划分 dev / test（整篇进同一集，不逐条随机）。

    论文按确定性哈希排序后**交替**分配（2 篇 → 1 dev + 1 test），
    避免论文数少时全部落进同一集。
    """
    papers = sorted({(r.get("paper") or "") for r in rows}, key=lambda p: _paper_hash(p, seed))
    assign: dict[str, str] = {}
    for i, p in enumerate(papers):
        assign[p] = "test" if i % 2 == 0 else "dev"
    out: dict[str, list[dict]] = {"dev": [], "test": []}
    for r in rows:
        out[assign.get(r.get("paper") or "", "dev")].append(r)
    return out


def format_sheet(rows: list[dict]) -> str:
    """Markdown 复核表（人工只需填 is_formula / expect_latex）。"""
    lines = [
        "| # | 论文 | 页 | 原文 | 当前 LaTeX | status | 是公式?(是/否) | 期望 LaTeX |",
        "|---|------|----|------|-----------|--------|----------------|-----------|"
    ]
    for i, r in enumerate(rows):
        raw = (r.get("raw_text") or "").replace("|", "\\|")[:40]
        latex = (r.get("latex") or "").replace("|", "\\|")[:40]
        lines.append(f"| {i} | {r['paper'][:18]} | {r['page']} | `{raw}` | `{latex}` | {r['status']} | | |")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "dump"
    if cmd == "dump":
        out_dir = argv[2] if len(argv) > 2 else "eval"
        base = os.path.join(os.environ.get("APPDATA", ""), "paperdesk", "data", "storage")
        pdfs = sorted(glob.glob(os.path.join(base, "*", "*.pdf")))
        if not pdfs:
            print("未找到真实论文（可在参数里给出 PDF 目录）")
            return 1
        rows = dump_sheet(pdfs)
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "formulas_review.json"), "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)
        with open(os.path.join(out_dir, "formulas_review.md"), "w", encoding="utf-8") as fh:
            fh.write(format_sheet(rows))
        split = split_by_paper(rows)
        papers = sorted({r["paper"] for r in rows})
        dev_papers = sorted({r["paper"] for r in split["dev"]})
        test_papers = sorted({r["paper"] for r in split["test"]})
        print(f"已生成 {len(rows)} 条待复核公式 → {out_dir}/formulas_review.{{json,md}}")
        print(f"论文 {len(papers)} 篇 → dev {len(dev_papers)} 篇 / test {len(test_papers)} 篇")
        for p in papers:
            print(f"  [{'test' if p in test_papers else 'dev '}] {p}")
        print("自动指标（未标注部分仅供参考）：", json.dumps(score_sheet(rows), ensure_ascii=False))
        return 0
    if cmd == "score":
        path = argv[2]
        with open(path, encoding="utf-8") as fh:
            rows = json.load(fh)
        split = split_by_paper(rows)
        print("总体：", json.dumps(score_sheet(rows), ensure_ascii=False))
        print("dev ：", json.dumps(score_sheet(split["dev"]), ensure_ascii=False))
        print("test：", json.dumps(score_sheet(split["test"]), ensure_ascii=False))
        print("按论文：")
        for paper, m in score_by_paper(rows).items():
            part = "test" if any(r in split["test"] for r in rows if r.get("paper") == paper) else "dev"
            print(f"  [{part}] {paper[:50]}: labeled={m['labeled']} wrong_accept={m['wrong_accept_rate']}")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
