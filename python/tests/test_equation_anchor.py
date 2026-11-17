"""公式编号锚定测试（阶段 C 增量）。

覆盖（合成 blocks 列表直接调用 ``anchor_equation_numbers``，不用真实 PDF）：
① 同行左右与上一行两类关系都能命中；② 无编号块时产物保持 null、warnings 为空；
③ 跨页不串（第 1 页的编号不会被挂到第 2 页的公式）；④ 距离阈值与失败仅记 warnings。

跑法：``python python/tests/test_equation_anchor.py``，输出 ``EQUATION_OK``。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app.blocks_adapter as blocks_adapter  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {extra}")


PH = 800.0  # 页高（顶边原点坐标 → 底边原点矩形的换算基准，与 modules.to_bottom 一致）


def blk(sid, btype, page, x0, x1, ytop, ybottom, text):
    """构造一个标注块；ytop/ybottom 是**顶边原点**页内位置（页面顶部为 0）。"""
    rect = [round(x0, 2), round(PH - ybottom, 2), round(x1, 2), round(PH - ytop, 2)]
    return {
        "stableId": sid,
        "blockType": btype,
        "sourceRegion": {"page": page, "rect": rect},
        "text": text,
    }


# ---- ① 合成两页 doc：同行左右 + 上一行 双向锚定；第 2 页只有公式没有编号 ----
doc1 = [
    # 第 1 页
    blk("p1-beq1", "equation", 1, 100, 300, 600, 614, "E = m c^2"),
    blk("p1-bn1", "equation-number", 1, 306, 324, 600, 612, "(3)"),   # 同行右侧
    blk("p1-beq2", "equation", 1, 400, 500, 600, 614, "F = m a"),
    blk("p1-bn2", "equation-number", 1, 375, 393, 600, 612, "(4)"),   # 同行左侧
    blk("p1-beq3", "equation", 1, 100, 340, 640, 654, "G = k x"),
    blk("p1-bn3", "equation-number", 1, 350, 368, 655, 667, "(5)"),   # 上一行（编号在下一行）
    # 第 2 页：只有公式，没有编号
    blk("p2-beq9", "equation", 2, 100, 300, 600, 614, "H = g t"),
]
warnings1: list[str] = []
blocks_adapter.anchor_equation_numbers(doc1, warnings1)

num1 = {b["stableId"]: b for b in doc1}
check("同行右侧编号挂到同行公式", num1["p1-bn1"]["relatedEquationId"] == "p1-beq1",
      str(num1["p1-bn1"]))
check("同行左侧编号挂到同行公式", num1["p1-bn2"]["relatedEquationId"] == "p1-beq2",
      str(num1["p1-bn2"]))
check("上一行编号挂到上一行公式（编号在公式下一行也命中）",
      num1["p1-bn3"]["relatedEquationId"] == "p1-beq3", str(num1["p1-bn3"]))
check("公式本体回写 numberText=编号原文", num1["p1-beq1"].get("numberText") == "(3)",
      str(num1["p1-beq1"].get("numberText")))
check("公式本体回写 numberStableId=编号块", num1["p1-beq1"].get("numberStableId") == "p1-bn1",
      str(num1["p1-beq1"].get("numberStableId")))
check("第 2 页公式没有被第 1 页编号污染（无 numberStableId）",
      "numberStableId" not in num1["p2-beq9"] and "numberText" not in num1["p2-beq9"],
      str(num1["p2-beq9"]))
check("全部命中时不写 warnings", warnings1 == [], str(warnings1))
check("编号核心 number=(4→4/5→5) 去括号保留字母衬位",
      num1["p1-bn1"].get("number") == "3" and num1["p1-bn2"].get("number") == "4"
      and num1["p1-bn3"].get("number") == "5",
      str([num1[k].get("number") for k in ("p1-bn1", "p1-bn2", "p1-bn3")]))
check("numberRaw 保留括号原文", num1["p1-bn1"].get("numberRaw") == "(3)"
      and num1["p1-bn2"].get("numberRaw") == "(4)" and num1["p1-bn3"].get("numberRaw") == "(5)",
      str([num1[k].get("numberRaw") for k in ("p1-bn1", "p1-bn2", "p1-bn3")]))
check("公式本体文本未被改写（没有任何 LaTeX 写入）",
      num1["p1-beq1"]["text"] == "E = m c^2", str(num1["p1-beq1"]["text"]))

# ---- ② 无编号块：relatedEquationId 全为 null（键不存在/不真），warnings 为空 ----
doc2 = [
    blk("p1-bp0", "paragraph", 1, 50, 400, 100, 114, "This is a plain paragraph."),
    blk("p1-beq0", "equation", 1, 100, 300, 600, 614, "I = v / r"),
    blk("p2-beq0", "equation", 2, 100, 300, 600, 614, "J = w t"),
]
warnings2: list[str] = []
blocks_adapter.anchor_equation_numbers(doc2, warnings2)
check("无编号块：没有任何 relatedEquationId",
      all(not b.get("relatedEquationId") for b in doc2),
      str([(b["stableId"], b.get("relatedEquationId")) for b in doc2]))
check("无编号块：warnings 为空", warnings2 == [], str(warnings2))
check("无编号块：公式不写 numberText/numberStableId",
      all("numberText" not in b and "numberStableId" not in b for b in doc2), "")

# ---- ③ 跨页不串：第 1 页的编号不会被挂到第 2 页的公式，失败只写 warnings ----
doc3 = [
    blk("p1-bn9", "equation-number", 1, 100, 150, 600, 612, "(9)"),
    blk("p2-beq5", "equation", 2, 100, 300, 600, 614, "K = p q"),
]
warnings3: list[str] = []
blocks_adapter.anchor_equation_numbers(doc3, warnings3)
check("跨页不串：第 1 页编号 relatedEquationId 为 null",
      not doc3[0].get("relatedEquationId"), str(doc3[0]))
check("跨页不串：第 2 页公式没有任何回写",
      "numberStableId" not in doc3[1] and "numberText" not in doc3[1]
      and not doc3[1].get("relatedEquationId"), str(doc3[1]))
check("跨页失败只写 warnings（存在一条说明）",
      len(warnings3) == 1 and "未找到同页可关联的公式块" in warnings3[0], str(warnings3))

# ---- ④ 距离阈值：编号离公式超过 1.6 × 行高 → 不锚定，只写 warnings ----
doc4 = [
    blk("p1-beq4", "equation", 1, 100, 300, 600, 614, "L = s q"),
    blk("p1-bn7", "equation-number", 1, 306, 324, 690, 702, "(7)"),  # 隔了 4 行，间距超阈值
]
warnings4: list[str] = []
blocks_adapter.anchor_equation_numbers(doc4, warnings4)
check("超阈值编号 relatedEquationId 为 null",
      not doc4[1].get("relatedEquationId"), str(doc4[1]))
check("超阈值失败只写 warnings", len(warnings4) == 1
      and "未找到同页可关联的公式块" in warnings4[0], str(warnings4))
check("超阈值时公式不回写", "numberStableId" not in doc4[0], str(doc4[0]))

# ---- 编号解析：全角 / Eq. 前缀 / 带字母 / 抽不出 ----
cases = {
    "(3)": ("3", "(3)"),
    "（3）": ("3", "（3）"),
    "(3a)": ("3a", "(3a)"),
    "Eq. (3)": ("3", "(3)"),
    "Equation (12)": ("12", "(12)"),
    "不是编号": (None, None),
}
for text, want in cases.items():
    got = blocks_adapter._parse_eq_number(text)
    check(f"编号解析 {text!r} → {want}", got == want, str(got))

print("EQUATION_OK" if failed == 0 else f"EQUATION_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
