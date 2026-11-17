"""extract.extract_local 的自测（不依赖服务）。运行：python tests/test_extract.py"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app.extract import extract_local  # noqa: E402

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
    p1.insert_text((72, 720), "E2E Sample Paper", fontsize=20)
    p1.insert_text((72, 690), "Alice Zhang, Bob Li", fontsize=12)
    p2 = doc.new_page()
    p2.insert_text((72, 700), "References", fontsize=14)
    p2.insert_text(
        (72, 670),
        "[1] Smith J. A study of things. Journal of Tests, 2020. doi:10.1234/abcd.5678",
        fontsize=11,
    )
    p2.insert_text((72, 650), "[2] Doe A. Another work on stuff. 2019.", fontsize=11)
    doc.set_metadata({"title": "E2E Sample Paper", "author": "Alice Zhang; Bob Li"})
    doc.save(path)
    doc.close()


print("extract_local 测试")
with tempfile.TemporaryDirectory() as d:
    pdf = os.path.join(d, "sample.pdf")
    make_pdf(pdf)
    r = extract_local(pdf)
    check("页数正确", r["pageCount"] == 2, f"got={r['pageCount']}")
    check("标题解析", r["metadata"]["title"] == "E2E Sample Paper", str(r["metadata"]))
    check("作者解析为2个", r["metadata"]["authors"] == ["Alice Zhang", "Bob Li"], str(r["metadata"]["authors"]))
    check("参考文献切分为2条", len(r["references"]) == 2, f"got={len(r['references'])}")
    check(
        "第1条抽出 DOI",
        r["references"][0]["doi"] == "10.1234/abcd.5678",
        str(r["references"][0]),
    )
    check("第2条无 DOI", r["references"][1]["doi"] is None, str(r["references"][1]))

print("EXTRACT_OK" if failed == 0 else f"EXTRACT_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
