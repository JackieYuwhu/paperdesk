"""行内公式 → 可读文字/HTML（第四轮：译文 PDF 的上下标与希腊字母）。

背景：抽取阶段行内公式会被还原成裸文本（如 ``x^2``、``\\alpha_i``、``P(theta)``），
写回 PDF 时又按正文字体同字号同基线排版，结果上下标丢失、希腊字母变成命令名。

这里的转换规则保持**保守**：
- 只转换能确定含义的命令/标记；未识别的命令原样保留，并记入 ``unrepresentable``，
  由调用方在报告里标明「这些公式未能可靠还原」，绝不猜一个看起来对的结果。
- 上下标用 Unicode 上下标字符（优先）或 ``<sup>/<sub>``（HTML 路径）表达，
  两者都比「拍平成正文字」更接近原意。
"""

from __future__ import annotations

import re

GREEK: dict[str, str] = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ",
    "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
    "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "φ",
    "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
}

OPS: dict[str, str] = {
    "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "sim": "∼", "propto": "∝",
    "times": "×", "cdot": "·", "pm": "±", "mp": "∓", "div": "÷",
    "infty": "∞", "partial": "∂", "nabla": "∇", "sum": "∑", "prod": "∏",
    "int": "∫", "oint": "∮", "sqrt": "√", "in": "∈", "notin": "∉",
    "subset": "⊂", "subseteq": "⊆", "supset": "⊃", "cup": "∪", "cap": "∩",
    "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒",
    "Leftarrow": "⇐", "leftrightarrow": "↔", "forall": "∀", "exists": "∃",
    "emptyset": "∅", "angle": "∠", "perp": "⊥", "parallel": "∥",
    "ldots": "…", "cdots": "⋯", "prime": "′", "circ": "∘",
}

SUP: dict[str, str] = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶",
    "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽",
    ")": "⁾", "n": "ⁿ", "i": "ⁱ", "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ",
    "e": "ᵉ", "k": "ᵏ", "m": "ᵐ", "o": "ᵒ", "p": "ᵖ", "t": "ᵗ", "x": "ˣ",
    "y": "ʸ", "T": "ᵀ",
}

SUB: dict[str, str] = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆",
    "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍",
    ")": "₎", "a": "ₐ", "e": "ₑ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "l": "ₗ",
    "m": "ₘ", "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ",
    "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
}

# 行内公式线索：命令、上下标、显式数学符号
_INLINE_HINT = re.compile(
    r"\\[a-zA-Z]+|\^\{?[0-9A-Za-z+\-]|_\{?[0-9A-Za-z+\-]|"
    r"[α-ωΑ-Ω≤≥≈≠±×·∑∏∫√∂∇∈⊂∪∩→∞⁄]"
)

_CMD = re.compile(r"\\([a-zA-Z]+)")


def has_inline_math(text: str) -> bool:
    """文本里是否含需要特殊排版的行内公式线索。"""
    if not text:
        return False
    return bool(_INLINE_HINT.search(text))


def _sup_sub_unicode(match: re.Match[str]) -> str:
    token = match.group(2) or match.group(3) or ""
    table = SUP if match.group(1) == "^" else SUB
    mapped = "".join(table.get(ch, "") for ch in token)
    if len(mapped) != len(token):
        # 有字符没有对应的 Unicode 上下标：整体退回原样，交给 HTML 路径处理
        return match.group(0)
    return mapped


def to_unicode_math(text: str) -> str:
    """把常见的行内公式标记换成 Unicode（用于只能写纯文本的路径）。"""
    if not text:
        return text
    s = text
    s = re.sub(r"\\frac\{([^{}]*)\}\{([^{}]*)\}", r"(\1)⁄(\2)", s)
    s = re.sub(r"\\([a-zA-Z]+)", lambda m: GREEK.get(m.group(1)) or OPS.get(m.group(1)) or m.group(0), s)
    s = re.sub(r"([\^_])(?:\{([^{}]*)\}|(\w))", _sup_sub_unicode, s)
    return s


def unrepresentable_commands(text: str) -> list[str]:
    """返回无法确定含义的 LaTeX 命令（去重、保持出现顺序）。"""
    seen: list[str] = []
    for m in _CMD.finditer(text or ""):
        name = m.group(1)
        if name in GREEK or name in OPS or name in {"frac", "mathrm", "text", "left", "right", "big", "Big", "quad", "hspace"}:
            continue
        cmd = "\\" + name
        if cmd not in seen:
            seen.append(cmd)
    return seen


def _esc_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def inline_math_html(text: str) -> str:
    """把行内公式渲染成 HTML 片段（上下标用 <sup>/<sub>，与正文基线对齐）。

    在**转义之后**做替换，避免用户文本里的 ``<`` 被当成标签。
    """
    s = _esc_html(text or "")

    # 分数：a/b 形式，保留括号语义
    s = re.sub(r"\\frac\{([^{}]*)\}\{([^{}]*)\}", r"(\1)⁄(\2)", s)
    # 命令 → 符号（未识别的保持原样，报告里会列出）
    s = re.sub(
        r"\\([a-zA-Z]+)",
        lambda m: GREEK.get(m.group(1)) or OPS.get(m.group(1)) or m.group(0),
        s,
    )
    # \mathrm{x} / \text{x} → x
    s = re.sub(r"\\(?:mathrm|text|mathbf|mathit)\{([^{}]*)\}", r"\1", s)
    # 上下标：多字符（x^{ij}）与单字符（x^2）都支持
    s = re.sub(r"\^\{([^{}]*)\}", r"<sup>\1</sup>", s)
    s = re.sub(r"\^([0-9A-Za-z+\-])", r"<sup>\1</sup>", s)
    s = re.sub(r"_\{([^{}]*)\}", r"<sub>\1</sub>", s)
    s = re.sub(r"_([0-9A-Za-z+\-])", r"<sub>\1</sub>", s)
    return s
