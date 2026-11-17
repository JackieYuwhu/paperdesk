"""翻译技能（skills）自测。运行：python tests/test_skills.py"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

from app import skills  # noqa: E402
from app.translate import _classify_block  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {extra}")


print("skills 测试")
with tempfile.TemporaryDirectory() as d:
    skills.ensure_defaults(d)
    files = [f for f in os.listdir(d) if f.endswith(".json")]
    check("默认技能文件已写入", len(files) >= 5, str(files))

    items = skills.list_skills(d)
    matches = {i["match"] for i in items}
    check("覆盖 body/heading/caption/formula/reference", 
          {"body", "heading", "caption", "formula", "reference"} <= matches, str(matches))
    check("公式默认跳过翻译", next(i for i in items if i["match"] == "formula")["skip"] is True)

    body = next(i for i in items if i["match"] == "body")
    check("正文 prompt 含 {lang} 占位", "{lang}" in body["system"], body["system"][:40])

    # 保存
    skills.save_skill(d, "body", "Translate to {lang}. CUSTOM.", False)
    loaded = skills.load_skills(d)
    check("保存后生效", "CUSTOM" in loaded["body"]["system"], loaded["body"]["system"])

    # 恢复默认
    skills.reset_skills(d)
    loaded2 = skills.load_skills(d)
    check("恢复默认生效", "CUSTOM" not in loaded2["body"]["system"], loaded2["body"]["system"])

    # scope
    skills.save_skill(d, "heading", "T {lang}", False, "first")
    loaded3 = skills.load_skills(d)
    check("scope 保存生效", loaded3["heading"].get("scope") == "first", str(loaded3["heading"]))
    check("list 返回 scope", any(i["scope"] == "first" for i in skills.list_skills(d)))

    # 导入（含版本冲突）
    r = skills.import_skills(
        d,
        [
            {"match": "body", "system": "IMPORTED {lang}", "skip": False, "scope": "all", "version": 1},
            {"match": "caption", "system": "CAP {lang}", "skip": False, "scope": "all", "version": 1},
        ],
    )
    loaded4 = skills.load_skills(d)
    check("导入技能生效", r["imported"] == 2 and "IMPORTED" in loaded4["body"]["system"], str(loaded4["body"]))

    skills.save_skill(d, "body", "LOCALNEW", False)  # 版本自增
    r2 = skills.import_skills(d, [{"match": "body", "system": "OLD", "skip": False, "scope": "all", "version": 1}])
    check(
        "版本冲突保留本地",
        "body" in r2["conflicts"] and "LOCALNEW" in skills.load_skills(d)["body"]["system"],
        str(r2),
    )

    # 升级：导入方版本更高 → 记入 updates
    ver = int(skills.load_skills(d)["body"].get("version") or 1)
    r3 = skills.import_skills(
        d, [{"match": "body", "system": "NEWER", "skip": False, "scope": "all", "version": ver + 5}]
    )
    check(
        "导入更高版本记入 updates",
        "body" in r3["updates"] and "NEWER" in skills.load_skills(d)["body"]["system"],
        str(r3),
    )

    # only：逐项采用冲突项（force + only）
    skills.save_skill(d, "heading", "LOCALHEAD", False)  # heading 本地版本更高
    r4 = skills.import_skills(
        d, [{"match": "heading", "system": "IMPH", "skip": False, "scope": "all", "version": 1}]
    )
    check("heading 出现冲突", "heading" in r4["conflicts"], str(r4))
    r5 = skills.import_skills(
        d,
        [{"match": "heading", "system": "IMPH", "skip": False, "scope": "all", "version": 1}],
        force=True,
        only=["heading"],
    )
    check(
        "only 逐项采用导入版",
        r5["conflicts"] == [] and skills.load_skills(d)["heading"]["system"] == "IMPH",
        str(r5),
    )

    # 分类启发式
    def blk(raw, size, y0, y1, refsec=False, nlines=1):
        return {"raw": raw, "size": size, "ph": 792, "rect": fitz.Rect(72, y0, 500, y1), "refsec": refsec, "nlines": nlines}
    check("参考文献条目（1. … 年份）→ reference",
          _classify_block(blk("1. Smith J. Deep Residual Learning. 2016.", 11, 200, 214, True), 11) == "reference")
    check("页码 → margin", _classify_block(blk("Page 3", 9, 760, 770), 11) == "margin")
    check("纯数字 → margin", _classify_block(blk("12", 9, 40, 50), 11) == "margin")
    check("顶部大标题不算页眉", _classify_block(blk("Layout Preserving Translation", 18, 57, 77), 11) == "heading")
    check("公式 → formula", _classify_block(blk("E = m c^2", 11, 300, 314), 11) == "formula")
    check("图表题注 → caption", _classify_block(blk("Figure 1: Architecture overview.", 10, 500, 512), 11) == "caption")

print("SKILLS_OK" if failed == 0 else f"SKILLS_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
