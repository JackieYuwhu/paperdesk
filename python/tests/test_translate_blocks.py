"""按块切分翻译单元 + 译文回填对齐 测试（阶段 D 第一步）。

覆盖（合成 blocks 列表直接调用纯函数，不用真实 PDF、不联网）：
① 分组边界（heading / caption / equation / figure / table 必须断开，不可译类型
   绝不进可译文本）；② 跨页不合并；③ 长度上限切分（默认 1200 与 opts 覆盖）；
④ 正常回填（字典 replies、带 unitId 的列表 replies、纯字符串列表 replies）；
⑤ 三种恶劣输入：replies 少于 units、unitId 对不上、译文空串——返回完整块列表
   且 warnings 非空、不抛异常。

跑法：``python python/tests/test_translate_blocks.py``，输出 ``ALIGN_OK``。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.translate_blocks import (  # noqa: E402
    align_reply,
    build_units_payload,
    group_blocks,
)

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {extra}")


def blk(sid, btype, page, text):
    """构造最小结构化块（形状同 blocks_adapter 产物）。"""
    return {
        "stableId": sid,
        "blockType": btype,
        "sourceRegion": {"page": page, "rect": [0.0, 0.0, 100.0, 20.0]},
        "text": text,
    }


# ---- ① 分组边界：paragraph 合并；heading / caption 各自成单元；黑名单绝不进文本 ----
doc1 = [
    blk("b0", "paragraph", 1, "第一段甲。"),
    blk("b1", "paragraph", 1, "第一段乙。"),
    blk("b2", "heading", 1, "第二节 结果"),
    blk("b3", "paragraph", 1, "第三段丙。"),
    blk("b4", "equation", 1, "E = m c^2"),
    blk("b5", "equation-number", 1, "(3)"),
    blk("b6", "caption", 1, "图 1 实验装置"),
    blk("b7", "table", 1, "| a | b |"),
    blk("b8", "figure", 1, "[figure]"),
    blk("b9", "reference", 1, "[1]某人.某文.2024"),
]
u1 = group_blocks(doc1)
by_ids = [u["blocks"][0]["stableId"] for u in u1]
check("段落合并成一个单元，heading 断开",
      [u["blocks"][0]["stableId"] for u in u1[:2]] == ["b0", "b2"]
      and u1[0]["text"] == "第一段甲。第一段乙。", str(u1[:2]))
check("heading / caption 各占边界单元",
      u1[1]["blocks"] == [doc1[2]] and u1[1]["translatable"] is True
      and any(u["blocks"][0]["stableId"] == "b6" for u in u1), str(by_ids))
check("equation/equation-number/table/figure 各自成不可译单元且 text 为空",
      all(u["translatable"] is False and u["text"] == ""
          for u in u1 if u["blocks"][0]["stableId"] in ("b4", "b5", "b7", "b8")),
      str([u for u in u1 if not u["translatable"]]))
check("payload 不携带 equations/table/figure 正文，可译文本在单元 text",
      all(u["text"] == "" for u in build_units_payload(u1)
          if u["translatable"] is False),
      str([u for u in build_units_payload(u1) if not u["translatable"]]))
check("单元覆盖全部块且不重叠（展平等于原文顺序）",
      [b["stableId"] for u in u1 for b in u["blocks"]]
      == [b["stableId"] for b in doc1], str(by_ids))

# ---- ② 跨页不合并 ----
doc2 = [
    blk("p1a", "paragraph", 1, "第一页段落。"),
    blk("p1b", "paragraph", 1, "第一页段落二。"),
    blk("p2a", "paragraph", 2, "第二页段落。"),
    blk("p2b", "paragraph", 2, "第二页段落二。"),
]
u2 = group_blocks(doc2)
check("跨页不合并：第 1 页一个单元、第 2 页一个单元",
      len(u2) == 2 and u2[0]["page"] == 1 and u2[1]["page"] == 2
      and [len(u["blocks"]) for u in u2] == [2, 2], str(u2))
mix2 = [blk("n1", "paragraph", 1, "有页。"),
        blk("n2", "paragraph", None, "无页。")]
check("page 缺失的块单独成单元（不并入相邻单元）",
      len(group_blocks(mix2)) == 2, str(group_blocks(mix2)))

# ---- ③ 长度上限：默认 1200 与 opts 覆盖 ----
long_para_a = "甲" * 700
long_para_b = "乙" * 700
u3 = group_blocks([
    blk("la", "paragraph", 1, long_para_a),
    blk("lb", "paragraph", 1, long_para_b),
])
check("默认上限 1200：合并超限断开成两个单元（甲 700 / 乙 700）",
      len(u3) == 2 and u3[0]["text"] == long_para_a
      and u3[1]["text"] == long_para_b, str([len(u["text"]) for u in u3]))
u3b = group_blocks([
    blk("sa", "paragraph", 1, "短一段。"),
    blk("sb", "paragraph", 1, "短二段。"),
    blk("sc", "paragraph", 1, "短三段。"),
], opts={"maxChars": 10})
check("opts.maxChars=10：8+4 超限，切开后各自成单元",
      [u["text"] for u in u3b] == ["短一段。短二段。", "短三段。"], str(u3b))
check("单块超限不二分，自成一个单元",
      len(group_blocks([blk("big", "paragraph", 1, "超" * 1300)])) == 1)

# ---- ④ 正常回填：三种 replies 形态 ----
u4 = group_blocks([
    blk("ra", "paragraph", 1, "Hello world."),
    blk("rh", "heading", 1, "Results"),
    blk("rb", "paragraph", 1, "Second part."),
    blk("rc", "equation", 1, "x + y = z"),
])
d0, d1, d2 = [u["unitId"] for u in u4 if u["translatable"]]
io = lambda res: [b["translation"] for b in res["blocks"]]  # noqa: E731
check("正常回填前：一段+标题+二段+公式 共 4 个单元，3 个可译",
      len(u4) == 4 and len([u for u in u4 if u["translatable"]]) == 3, str(u4))
res4a = align_reply(u4, {d0: "你好世界。", d1: "结果", d2: "第二部分。"})
check("字典 replies 按 unitId 回填",
      io(res4a) == ["你好世界。", "结果", "第二部分。", "x + y = z"],
      str(res4a["blocks"]))
check("正常回填无 warnings，不可译块（equation）译文=原文",
      res4a["warnings"] == [] and io(res4a)[3] == "x + y = z",
      str(res4a["warnings"]))
res4b = align_reply(u4, [{"unitId": d0, "text": "你好世界。"},
                         {"unitId": d1, "text": "结果"},
                         {"unitId": d2, "text": "第二部分。"}])
check("带 unitId 的列表 replies 按 unitId 回填",
      io(res4b) == ["你好世界。", "结果", "第二部分。", "x + y = z"],
      str(res4b["blocks"]))
res4c = align_reply(u4, ["你好世界。", "结果", "第二部分。"])
check("纯字符串列表 replies 按序号回填（3 个可译单元全命中，无警告）",
      io(res4c) == ["你好世界。", "结果", "第二部分。", "x + y = z"]
      and res4c["warnings"] == [], str(res4c["warnings"]))
check("回填不改输入 units（纯函数）",
      all("translation" not in b for u in u4 for b in u["blocks"]), str(u4))

# ---- ⑤ 恶劣输入 1：replies 少于 units（字典缺一项 + 字符串列表短一截）----
res5a = align_reply(u4, {d0: "你好世界。", d1: "结果"})
check("字典缺一项：缺失可译单元的块 translation 为空且警告非空",
      io(res5a) == ["你好世界。", "结果", "", "x + y = z"]
      and len(res5a["warnings"]) == 1 and d2 in res5a["warnings"][0], str(res5a))
res5b = align_reply(u4, ["你好世界。"])
check("字符串列表短一截：多缺的可译单元各降级空译文并各记一条警告",
      io(res5b)[0] == "你好世界。" and io(res5b)[1] == "" and io(res5b)[2] == ""
      and io(res5b)[3] == "x + y = z"
      and len(res5b["warnings"]) == 2, str(res5b))
check("恶劣输入返回完整块列表（块数与 units 展平一致）",
      len(res5a["blocks"]) == 4 and len(res5b["blocks"]) == 4,
      str((len(res5a["blocks"]), len(res5b["blocks"]))))

# ---- ⑤ 恶劣输入 2：unitId 对不上 ----
res6 = align_reply(u4, {"no-such-unit": "译文", "another-x": "译文2"})
check("unitId 全对不上：全部可译块空译文 + 缺失与对不上两类警告",
      io(res6) == ["", "", "", "x + y = z"] and len(res6["warnings"]) == 5
      and any("no-such-unit" in w for w in res6["warnings"]),
      str(res6["warnings"]))

# ---- ⑤ 恶劣输入 3：译文为空字符串 ----
res7 = align_reply(u4, {d0: "", d1: "   "})
empty_ws = [w for w in res7["warnings"] if "译文为空" in w]
missing_ws = [w for w in res7["warnings"] if "对不上" in w]
check("空串/全空白译文：降级为空译文并各记一条「译文为空」警告",
      io(res7) == ["", "", "", "x + y = z"] and len(empty_ws) == 2,
      str(res7["warnings"]))
check("空串用例里缺的第 3 个单元同时有「对不上」警告",
      len(missing_ws) == 1 and d2 in missing_ws[0], str(missing_ws))
res8 = align_reply(u4, None)
check("replies=None：全部可译块降级空译文、不可译块保持原文、不抛异常",
      io(res8) == ["", "", "", "x + y = z"] and len(res8["warnings"]) >= 1,
      str(res8["warnings"]))

print("ALIGN_OK" if failed == 0 else f"ALIGN_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
