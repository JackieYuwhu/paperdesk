"""structure.extract_structure 的自测（不依赖服务）。运行：python tests/test_structure.py"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.structure import extract_structure  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {extra}")


def make_pdf(path):
    doc = fitz.open()
    p1 = doc.new_page()
    p1.insert_text((72, 720), "Theorem 1. For every x, f(x) = x^2 is convex.", fontsize=11)
    p1.insert_text((72, 700), "Proof. It follows from the second derivative.", fontsize=11)
    p1.insert_text((72, 680), "Lemma 2. The function is bounded below by 0.", fontsize=11)
    p2 = doc.new_page()
    p2.insert_text((72, 700), "E = m c^2    (1)", fontsize=11)
    p2.insert_text((72, 680), "sum_{i=1}^{n} a_i <= B", fontsize=11)
    p2.insert_text((72, 660), "Definition 3. Let X be a set.", fontsize=11)
    doc.save(path)
    doc.close()


print("extract_structure 测试")
with tempfile.TemporaryDirectory() as d:
    pdf = os.path.join(d, "s.pdf")
    make_pdf(pdf)
    r = extract_structure(pdf)
    kinds = {t["kind"] for t in r["theorems"]}
    check("页数正确", r["pageCount"] == 2, f"got={r['pageCount']}")
    check("识别到定理类环境", {"Theorem", "Lemma", "Definition"} <= kinds, str(kinds))
    check("定理陈述非空", all(len(t["statement"]) > 3 for t in r["theorems"]), str(r["theorems"]))
    check("识别到公式", len(r["equations"]) >= 2, str(r["equations"]))
    check("公式含编号", any(e["number"] == "1" for e in r["equations"]), str(r["equations"]))
    check("计数一致", r["counts"]["equations"] == len(r["equations"]), str(r["counts"]))

print("STRUCTURE_OK" if failed == 0 else f"STRUCTURE_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
