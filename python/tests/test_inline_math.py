"""行内公式还原自测（离线、确定性）。运行：python tests/test_inline_math.py"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.inline_math import (  # noqa: E402
    has_inline_math,
    inline_math_html,
    to_unicode_math,
    unrepresentable_commands,
)

FAILED = []


def check(name, cond):
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}")
        FAILED.append(name)


# 1) 识别：只有真正的公式才走 htmlbox 路径，普通句子不能被误判
check("普通句子不算行内公式", not has_inline_math("the model is trained on CIFAR-10"))
check("希腊字母算公式", has_inline_math("learning rate $\\alpha = 0.1$"))
check("上下标算公式", has_inline_math("x^{2} + y_{i}"))
check("数学符号算公式", has_inline_math("error ≤ 0.05 and x ∈ R"))

# 2) 命令转 Unicode：可还原的必须还原成正确字形
u = to_unicode_math("\\alpha + \\beta \\leq \\gamma")
check("希腊字母转 unicode", "α" in u and "β" in u and "≤" in u and "γ" in u)
check("times 转 unicode", "×" in to_unicode_math("a \\times b"))
check("infty 转 unicode", "∞" in to_unicode_math("n \\to \\infty"))
check("arrow 转 unicode", "→" in to_unicode_math("x \\rightarrow y"))

# 3) HTML：上下标要成为真正的 <sup>/<sub>，而不是普通文字
h = inline_math_html("x^{2}")
check("上标生成 sup", "<sup>2</sup>" in h)
h2 = inline_math_html("y_{i}")
check("下标生成 sub", "<sub>i</sub>" in h2)
h3 = inline_math_html("\\frac{a+b}{c}")
check("分数保留分子分母", "a+b" in h3 and "c" in h3 and ("⁄" in h3 or "/" in h3))
h4 = inline_math_html("E = mc^{2} \\quad \\alpha")
check("混合上下标与希腊字母", "<sup>2</sup>" in h4 and "α" in h4)
check("HTML 转义尖括号", "&lt;" in inline_math_html("a < b"))

# 4) 不可可靠还原的命令要能被报告出来（不生成看似正常的错误公式）
check(
    "未知命令被报告",
    any(c.endswith("unknowncmd") for c in unrepresentable_commands("\\unknowncmd{x}")),
)
check("frac 属已知命令不报告", unrepresentable_commands("\\frac{a}{b}") == [])
check("普通文本无不可还原命令", unrepresentable_commands("plain text") == [])

if FAILED:
    print(f"INLINE_MATH_FAIL ({len(FAILED)})")
    sys.exit(1)
print("INLINE_MATH_OK")
