"""统一结构化块适配层测试（阶段 B PoC）。

覆盖：默认开关关闭（产物逐字节不变、无 blocks 字段）、开启（三必填字段 + stableId 唯一
+ 对齐/orphan + 行内数学标注）、适配层异常回退（只记 warnings 不影响 modules）。
跑法：``python python/tests/test_blocks.py``，开关由本测试文件内动态设置。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz  # noqa: E402

import app.blocks_adapter as blocks_adapter  # noqa: E402
from app.modules import extract_modules  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {extra}")


def _build_pdf(path: str) -> None:
    doc = fitz.open()
    page = doc.new_page(width=600, height=800)
    page.insert_text((50, 90), "1 Introduction", fontsize=14)
    page.insert_text((50, 120), "This is the first body line.", fontsize=11)
    page.insert_text((50, 136), "Body with inline math x + y = z here.", fontsize=11)
    page.insert_text((50, 152), "This is the third body line.", fontsize=11)
    page.draw_rect(fitz.Rect(330, 100, 540, 200), color=(0, 0, 0), fill=(0.9, 0.9, 0.95))
    page.insert_text((330, 235), "Fig. 1. A caption that spans", fontsize=9)
    page.insert_text((330, 249), "multiple lines here.", fontsize=9)
    page.insert_text((50, 500), "References", fontsize=12)
    page.insert_text((50, 530), "[1] Author A. Title one.", fontsize=11)
    page.insert_text((100, 620), "E = m c^2", fontsize=11)
    page.insert_text((100, 650), "(5)", fontsize=11)
    doc.save(path)
    doc.close()


env_key = "PAPERDESK_BLOCKS_ADAPTER"
_env_backup = os.environ.pop(env_key, None)  # 保证「关闭」分支不被外部环境污染

_tmp = tempfile.mkdtemp(prefix="pd-blocks-")
_pdf = os.path.join(_tmp, "sample.pdf")
_build_pdf(_pdf)

# ---- ① 关闭（默认）：不出现 blocks 字段，且不新增 adapterVersion ----
doc_off = extract_modules(_pdf)
modules_json_off = json.dumps(doc_off["modules"], sort_keys=True, ensure_ascii=False)

check("默认关闭：产物不含 blocks 字段", "blocks" not in doc_off, str(list(doc_off.keys())))
check("默认关闭：产物不含 adapterVersion 字段", "adapterVersion" not in doc_off,
      str(list(doc_off.keys())))
check("默认关闭：warnings 无适配层失败记录", all("blocks 适配层失败" not in w for w in doc_off["warnings"]),
      str(doc_off["warnings"]))

# ---- ② 开启：三必填字段 + stableId 唯一 + modules 逐字节相同 ----
os.environ[env_key] = "1"
try:
    doc_on = extract_modules(_pdf)
finally:
    if _env_backup is None:
        os.environ.pop(env_key, None)
    else:
        os.environ[env_key] = _env_backup

check("开启：产物含 blocks 字段", "blocks" in doc_on, str(list(doc_on.keys())))
check("开启：adapterVersion 已写入", doc_on.get("adapterVersion") == blocks_adapter.ADAPTER_VERSION,
      str(doc_on.get("adapterVersion")))
check("开启：modules 数组与关闭时逐字节相同",
      json.dumps(doc_on["modules"], sort_keys=True, ensure_ascii=False) == modules_json_off, "")
check("开关关闭：除 blocks/adapterVersion 外整个产物逐字节一致",
      json.dumps({k: v for k, v in doc_off.items()}, sort_keys=True, ensure_ascii=False)
      == json.dumps({k: v for k, v in doc_on.items() if k not in ("blocks", "adapterVersion")},
                    sort_keys=True, ensure_ascii=False), "")

blocks = doc_on.get("blocks", [])
check("开启：blocks 非空", len(blocks) > 0, str(len(blocks)))

all_ok = True
sid_re = None
try:
    import re
    sid_re = re.compile(r"^p\d+-b\d+$")
except ImportError:  # pragma: no cover
    pass
ids: list[str] = []
for b in blocks:
    if sid_re is not None and not sid_re.match(b.get("stableId", "")):
        all_ok = False
    if "blockType" not in b or "sourceRegion" not in b:
        all_ok = False
    sr = b.get("sourceRegion", {})
    if not isinstance(sr, dict) or not isinstance(sr.get("page"), int):
        all_ok = False
    if not (isinstance(sr.get("rect"), list) and len(sr["rect"]) == 4):
        all_ok = False
    if sr.get("rects") is not None and not isinstance(sr["rects"], list):
        all_ok = False
    ids.append(b.get("stableId", ""))
check("每个块都有 stableId/blockType/sourceRegion 三必填字段且 stableId 匹配 ^p\\d+-b\\d+$",
      all_ok and len(blocks) > 0, str([b for b in blocks if not (b.get("stableId") and b.get("blockType") and b.get("sourceRegion"))][:2]))
check("stableId 全局唯一", len(ids) == len(set(ids)), str(ids))

enum_ok = all(b.get("blockType") in {
    "paragraph", "heading", "caption", "equation", "equation-number",
    "math-inline", "table", "figure", "reference",
} for b in blocks)
check("blockType 在允许枚举内", enum_ok, str(sorted({b.get("blockType") for b in blocks})))

check("存在与 modules 对齐成功的块（moduleId）", any("moduleId" in b for b in blocks),
      str([(b["stableId"], b.get("orphan")) for b in blocks]))
check("对不上的块标 orphan:true", all(b.get("orphan", False) == ("moduleId" not in b) for b in blocks),
      str([(b["stableId"], "moduleId" in b, b.get("orphan")) for b in blocks]))

# ---- 行内数学标注（不改写文本，给起止 offset） ----
check("行内数学被标 inlineMath（含起止 offset 与原文）",
      any(b.get("inlineMath") for b in blocks), str([b.get("text", "")[:40] for b in blocks]))
im_ok = True
for b in blocks:
    for im in b.get("inlineMath", []):
        seg = b["text"][im["start"]:im["end"]]
        if seg != im["text"]:
            im_ok = False
check("inlineMath 的 offset 能从块文本原样切出原文（文本未被改写）", im_ok,
      str([b.get("inlineMath")[:1] for b in blocks if b.get("inlineMath")][:1]))

# ---- 公式编号回挂（6.4 最小证明） ----
eqnum = [b for b in blocks if b.get("blockType") == "equation-number"]
check("识别出 equation-number 块", len(eqnum) == 1, str([b["text"] for b in blocks if b.get("blockType") == "equation-number"]))
check("equation-number 带 relatedEquationId 指向 equation 块",
      any(b.get("relatedEquationId") and any(
          x["stableId"] == b["relatedEquationId"] and x["blockType"] == "equation"
          for x in blocks) for b in eqnum), str(eqnum))
check("formula/equation 块存在", any(b.get("blockType") == "equation" for b in blocks),
      str(sorted({b.get("blockType") for b in blocks})))

# ---- caption / reference / heading 类型可见 ----
types = {b.get("blockType") for b in blocks}
check("caption 类型出现", "caption" in types, str(types))
check("reference 类型出现", "reference" in types, str(types))
check("heading 类型出现", "heading" in types, str(types))

# 文本逐字保留：所有块文本拼接后包含题注原句
check("块文本逐字保留原文（题注整句未改写）",
      any("multiple lines here" in b["text"] for b in blocks), "")

# ---- ③ 故意让 build_blocks 抛错：主流程不受影响，只记 warnings ----
_orig = blocks_adapter.build_blocks


def _boom(doc_path, modules, warnings):
    raise RuntimeError("injected failure for fallback test")


blocks_adapter.build_blocks = _boom
os.environ[env_key] = "1"
try:
    doc_fail = extract_modules(_pdf)
finally:
    blocks_adapter.build_blocks = _orig
    if _env_backup is None:
        os.environ.pop(env_key, None)
    else:
        os.environ[env_key] = _env_backup

check("适配层抛错时 modules 仍返回且与关闭时逐字节相同",
      json.dumps(doc_fail["modules"], sort_keys=True, ensure_ascii=False) == modules_json_off, "")
check("适配层抛错时产物不含 blocks 字段", "blocks" not in doc_fail, str(list(doc_fail.keys())))
check("适配层抛错只记 warnings",
      any("blocks 适配层失败" in w and "injected failure" in w for w in doc_fail["warnings"]),
      str(doc_fail["warnings"]))

try:
    os.remove(_pdf)
    os.rmdir(_tmp)
except OSError:
    pass

print("BLOCKS_OK" if failed == 0 else f"BLOCKS_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
