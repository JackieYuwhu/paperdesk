"""保版式翻译（内置引擎）。

思路：逐页取出文本块 -> 翻译 -> 用红action覆盖原文 -> 在**同一矩形内**回填译文。
这样段落位置、图片、公式（非文本对象）都保持原样，属于「位置稳定」的版面保持。

翻译后端可插拔：
  * mock   : 加前缀，离线可用、结果确定（用于测试/演示）
  * none   : 原样返回
  * openai : 任意 OpenAI 兼容 /chat/completions 服务（需 baseUrl + apiKey + model）
"""

from __future__ import annotations

from .model_protocol import chat_endpoint, chat_payload, response_text

import base64
import json
import math
import os
import re
import shutil
import unicodedata
import sys
import tempfile
import threading
import time
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, as_completed, wait
from pathlib import Path

import fitz  # PyMuPDF

from .skills import load_skills
from .model_auth import auth_headers
from .inline_math import has_inline_math, inline_math_html, to_unicode_math, unrepresentable_commands

CJK_RE = re.compile(r"[\u3000-\u9fff\uff00-\uffef]")
CJK_FONT = "china-s"  # PyMuPDF 内置中文字体（不嵌入，仅作兜底）

# 译文正文字号相对原文的默认增量（pt）：用户反馈译文偏小，默认 +1.5pt 并允许覆盖。
DEFAULT_FONT_DELTA = 1.5

# 系统 CJK 字体（优先嵌入，保证 pdf.js 等查看器能渲染中文）
_CJK_CACHE: dict = {"checked": False, "path": None}


def plan_chunks(indices: list[int], batch: int) -> list[list[int]]:
    """把 indices 按 batch 切成若干块（batch<=0 视为不切）。"""
    if batch <= 0:
        return [list(indices)] if indices else []
    return [indices[i : i + batch] for i in range(0, len(indices), batch)]


def build_chunk_plan(groups: list[tuple[str, str, list[int]]], batch: int) -> list[dict]:
    """groups: [(key, system, indices)] -> 全局工作项 [{key, system, indices}]，按原顺序展开所有块。"""
    plan: list[dict] = []
    for key, system, indices in groups:
        for ch in plan_chunks(indices, batch):
            plan.append({"key": key, "system": system, "indices": ch})
    return plan


def group_translation_items(
    kinds: list[str],
    sections: list[str],
    skip_mask: list[bool],
    use_section: bool,
) -> list[tuple[tuple[str, str], list[int]]]:
    """把待翻译块分组到「请求组」。

    默认按内容类型（kind）分组就够了：同类型的 system prompt 相同，同一组可以在
    一个请求里带上很多段的上下文。**不要默认按章节拆分**——那会把请求数放大到
    「章节数 × 类型数」，在延迟主导的网关上等于数倍总耗时。只有当用户自定义的
    system prompt 真的引用了 `{section}` 时，才按章节拆分以保住该变量。
    """
    groups: dict[tuple[str, str], list[int]] = {}
    for i, k in enumerate(kinds):
        if i < len(skip_mask) and skip_mask[i]:
            continue
        sec = sections[i] if (use_section and i < len(sections)) else ""
        groups.setdefault((k, sec), []).append(i)
    return list(groups.items())


def pick_batch_size(group_sizes: list[int], workers: int, cap: int = 16) -> int:
    """选「一波发完」前提下尽量小的批大小。

    单请求耗时随段数增长远快于线性（实测 4 段≈42s、8 段≈61s、16 段≈127s），
    所以最优不是「批越大越好」，而是：请求数不超过并发数（一波打完）时，
    批越小单请求越快。这里是纯函数，便于单测。
    """
    sizes = [int(n) for n in group_sizes if n > 0]
    if not sizes:
        return 1
    cap = max(1, int(cap))
    workers = max(1, int(workers))
    for batch in range(1, cap + 1):
        requests = sum((n + batch - 1) // batch for n in sizes)
        if requests <= workers:
            return batch
    return cap


# 关闭「思考」的请求参数：OpenCode Zen / DeepSeek 等 OpenAI 兼容网关接受该字段；
# 少数服务端会以 400 拒绝未知参数，此时自动去掉并重试一次（同进程内不再尝试）。
# 只匹配「thinking/reasoning 与 unsupported/unknown/... 同时出现」的错误，
# 避免把「max_tokens 不受支持」之类无关的 400 也当成该参数被拒。
_THINK_PARAM_RE = re.compile(
    r"(?i)(?:thinking|reasoning)[^\n]{0,80}"
    r"(?:unsupported|unrecognized|unknown|unexpected|not supported|not permitted|"
    r"forbidden|invalid|extra)"
    r"|(?:unsupported|unrecognized|unknown|unexpected|invalid|extra)[^\n]{0,60}"
    r"(?:thinking|reasoning)"
)
_NO_THINK_UNSUPPORTED = False



def cjk_fontfile() -> str | None:
    if _CJK_CACHE["checked"]:
        return _CJK_CACHE["path"]
    _CJK_CACHE["checked"] = True
    if os.name == "nt":
        cands = [
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/simhei.ttf",
            "C:/Windows/Fonts/Deng.ttf",
            "C:/Windows/Fonts/simsun.ttc",
        ]
    elif sys.platform == "darwin":
        cands = [
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        ]
    else:
        cands = [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/truetype/arphic/uming.ttc",
        ]
    for c in cands:
        if os.path.exists(c):
            _CJK_CACHE["path"] = c
            return c
    return None


def cjk_fontname(page: "fitz.Page") -> str:
    """在当前页注册可嵌入的中文字体，返回字体名；无系统字体则回退内置 china-s。

    同一页只注册一次：`insert_font` 内部会走 CheckFont/get_fonts（约 10ms/次），
    而排版是逐块调用本函数——一页二三十个块就等于把同一份字体重复注册二三十遍。
    """
    cached = getattr(page, "_pd_cjk_font", None)
    if cached:
        return cached
    name = CJK_FONT
    path = cjk_fontfile()
    if path:
        try:
            page.insert_font(fontname="cjk", fontfile=path)
            name = "cjk"
        except Exception:  # noqa: BLE001
            name = CJK_FONT
    try:
        page._pd_cjk_font = name  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    return name

_IMG_NONE = getattr(fitz, "PDF_REDACT_IMAGE_NONE", 0)
_LINE_NONE = getattr(fitz, "PDF_REDACT_LINE_ART_NONE", 0)


def has_cjk(s: str) -> bool:
    return bool(CJK_RE.search(s))


# 常见符号 → 目标字体里通常可用的等价写法（避免译文出现「口」字形 tofu）
_SYMBOL_MAP = {
    "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "⇐": "<=", "↑": "^", "↓": "v",
    "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~=", "≡": "==", "∝": "~", "≃": "~=",
    "×": "x", "÷": "/", "−": "-", "±": "+/-", "·": ".", "•": "*", "…": "...",
    "“": '"', "”": '"', "‘": "'", "’": "'", "–": "-", "—": "-", "―": "-", "　": " ",
    "∑": "sum", "∏": "prod", "√": "sqrt", "∞": "inf", "∂": "d", "∫": "int",
    "∈": " in ", "∉": " not in ", "⊂": " subset ", "⊆": " subset ", "∪": " union ",
    "∩": " intersect ", "∀": "for all", "∃": "exists", "∇": "grad", "°": " deg ",
    "µ": "u", "★": "*", "☆": "*", "✔": "v", "✓": "v", "✗": "x", "✘": "x", "⚠": "!",
    "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5", "⑥": "6", "⑦": "7", "⑧": "8",
    "⑨": "9", "⑩": "10", "⟨": "<", "⟩": ">", "⌈": "ceil(", "⌉": ")",
}

_font_cache: dict[str, object] = {}


def _font_for(fontname: str):
    """取一个 fitz.Font 用于探测字形覆盖（失败返回 None → 只做符号映射）。"""
    if fontname in _font_cache:
        return _font_cache[fontname]
    f = None
    try:
        if fontname == "cjk":
            path = cjk_fontfile()
            f = fitz.Font(fontfile=path) if path else fitz.Font(CJK_FONT)
        else:
            f = fitz.Font(fontname)
    except Exception:  # noqa: BLE001
        f = None
    _font_cache[fontname] = f
    return f


_GREEK_NAMES = {
    "ALPHA": "α", "BETA": "β", "GAMMA": "γ", "DELTA": "δ", "EPSILON": "ε",
    "ZETA": "ζ", "ETA": "η", "THETA": "θ", "IOTA": "ι", "KAPPA": "κ",
    "LAMDA": "λ", "LAMBDA": "λ", "MU": "μ", "NU": "ν", "XI": "ξ",
    "OMICRON": "ο", "PI": "π", "RHO": "ρ", "SIGMA": "σ", "TAU": "τ",
    "UPSILON": "υ", "PHI": "φ", "CHI": "χ", "PSI": "ψ", "OMEGA": "ω",
}
_KEEP_SYMBOLS = "∈∉⊂⊆⊃⊇∪∩≤≥≠≈∞∑∏∫√∂∇±×÷·→←↔⇒⇔°′″"


def _glyph_fallback(ch: str) -> str | None:
    """字体缺字时的**语义**回退：数学花体/双线体等 → 基础字母；希腊名 → 希腊字母。

    例：𝒯(U+1D4AF) → "T"，ℋ → "H"，𝓕 → "F"，𝒪 → "O"。
    这样不会变成 "?"/"□"，也不丢信息（这些只是**同形变体**）。
    """
    try:
        nm = unicodedata.name(ch)
    except ValueError:
        return None
    parts = nm.split()
    if not parts:
        return None
    last = parts[-1]
    if len(last) == 1 and last.isalnum():
        # 小写变体（MATHEMATICAL ... SMALL T）要保留下写
        return last.lower() if "SMALL" in parts else last
    if last in _GREEK_NAMES:
        return _GREEK_NAMES[last]
    return None


def _sanitize_text(text: str, font) -> str:
    """把目标字体没有的字形替换/剔除，避免渲染成「口」字形（tofu）。

    - 常见数学/装饰符号 → 映射为 ASCII 等价写法；
    - 私用区/emoji 一律剔除；
    - 其余字体缺失的字符 → 有映射则替换，否则丢弃。
    """
    out: list[str] = []
    for ch in text:
        if ch in "\n\r\t":
            out.append(ch)
            continue
        # ASCII 一定可渲染（helv/CJK 字体都含 ASCII），**绝不**清洗（避免空格/标点被吞）
        if ord(ch) < 128:
            out.append(ch)
            continue
        o = ord(ch)
        if 0xE000 <= o <= 0xF8FF or 0x1F000 <= o <= 0x1FAFF:
            out.append(_SYMBOL_MAP.get(ch, ""))
            continue
        if font is None:
            # 字体未知：只映射「已知会 tofu 的符号」，其余保留
            out.append(_SYMBOL_MAP.get(ch, ch))
            continue
        try:
            # 注意：新版 PyMuPDF 的 Font.has_glyph 只接受 **码点 int**（传 str 会抛
            # TypeError，被下面 except 吞掉 → 字形检测**整个失效**，𝒫 之类会画成豆腐块）
            ok = bool(font.has_glyph(ord(ch)))
        except Exception:  # noqa: BLE001
            ok = True
        if ok:
            out.append(ch)
            continue
        rep = _SYMBOL_MAP.get(ch)
        if rep is None:
            rep = _glyph_fallback(ch)
        if rep is None:
            # 最后兜底：字母/数字/常见数学符号**保留原字符**（宁可画不出，也不要变成 "?"）
            rep = ch if (ch.isalnum() or ch in _KEEP_SYMBOLS) else ""
        out.append(rep)
    return "".join(out)


_LATEX_CMDS = {
    # 关系 / 集合
    "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆", "supset": "⊃",
    "supseteq": "⊇", "cup": "∪", "cap": "∩", "emptyset": "∅", "varnothing": "∅",
    "le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "sim": "∼", "propto": "∝", "ll": "≪", "gg": "≫",
    # 运算 / 符号
    "times": "×", "cdot": "·", "pm": "±", "mp": "∓", "div": "÷",
    "infty": "∞", "sum": "∑", "prod": "∏", "int": "∫", "sqrt": "√",
    "partial": "∂", "nabla": "∇", "forall": "∀", "exists": "∃",
    "to": "→", "rightarrow": "→", "leftarrow": "←", "leftrightarrow": "↔",
    "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔",
    "dots": "…", "ldots": "…", "cdots": "…", "vdots": "⋮", "ddots": "⋱",
    "mid": "|", "vert": "|", "Vert": "‖", "langle": "⟨", "rangle": "⟩",
    "lceil": "⌈", "rceil": "⌉", "lfloor": "⌊", "rfloor": "⌋",
    # 希腊字母
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "lambda": "λ",
    "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ", "sigma": "σ",
    "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "φ", "chi": "χ",
    "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ",
    "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ",
    "Omega": "Ω",
    # 排版命令：去掉命令本身，保留花括号里的内容
    "mathcal": "", "mathrm": "", "mathbf": "", "mathit": "", "mathbb": "",
    "mathsf": "", "mathtt": "", "text": "", "textbf": "", "textit": "",
    "operatorname": "", "overline": "", "hat": "", "bar": "", "tilde": "",
    "vec": "", "dot": "", "ddot": "", "left": "", "right": "", "big": "",
    "Big": "", "bigl": "", "bigr": "", "limits": "", "nolimits": "",
    "quad": " ", "qquad": "  ", ",": " ", ";": " ", ":": " ", "!": "",
}


def _latex_to_plain(text: str) -> str:
    """把译文里漏出来的行内 LaTeX 变成**可读文本**（PDF 里没法排版公式）。

    例如 `\\(r_{h(i)} \\in \\{1,\\dots,n\\}\\)` → `r_{h(i)} ∈ {1,…,n}`。
    以前这些内容会被原样画进 PDF，读者看到的是 `\\(...\\)` 这种乱码。
    """
    if not text or ("\\" not in text and "$" not in text):
        return text
    s = text
    for a, b in (
        ("$$", ""),
        ("$", ""),
        ("\\(", ""),
        ("\\)", ""),
        ("\\[", ""),
        ("\\]", ""),
    ):
        s = s.replace(a, b)
    # 转义花括号先占位，避免下面统一去括号时丢掉
    s = s.replace("\\{", "\u0001").replace("\\}", "\u0002")
    s = s.replace("{", "").replace("}", "")
    s = s.replace("\u0001", "{").replace("\u0002", "}")

    def _cmd(m) -> str:  # noqa: ANN001
        return _LATEX_CMDS.get(m.group(1), "")

    s = re.sub(r"\\([A-Za-z]+)\s*", _cmd, s)
    s = re.sub(r"\\([^A-Za-z\n])", lambda m: _LATEX_CMDS.get(m.group(1), m.group(1)), s)
    s = s.replace("~", " ")
    s = re.sub(r"[ \t]{2,}", " ", s)
    return s.strip()


_MATH_CSS = """
@font-face { __ff_cjk__ }
@font-face { __ff_math__ }
body {font-family: cjk; font-size: __size__pt; line-height: 1.24; margin: 0; color: __color__;}
p { margin: 0; }
.m { font-family: math; }
"""


def _math_css(cjk: str, math: str, size: float, color) -> str:
    return (
        _MATH_CSS.replace("__ff_cjk__", "font-family: cjk; src: url(%s);" % cjk.replace("\\", "/"))
        .replace("__ff_math__", "font-family: math; src: url(%s);" % math.replace("\\", "/"))
        .replace("__size__", "%.2f" % max(MIN_FONT_SIZE, size))
        .replace("__color__", _css_color(color))
    )


def _css_color(c) -> str:
    if not c:
        return "#000000"
    try:
        r, g, b = (max(0, min(255, int(float(v) * 255))) for v in c)
        return "#%02x%02x%02x" % (r, g, b)
    except Exception:  # noqa: BLE001
        return "#000000"


def _draw_inline_math_box(
    page, box, text: str, size: float, color, min_scale: float = 0.72
) -> tuple[float, float, bool, list[str]]:
    """行内公式版式：中文正文 + `<sup>/<sub>` 上下标，基线随字号自动对齐。

    返回 (实际字号, 底部 y, 是否溢出, 未能还原的命令列表)。
    ``scale_low`` 设下限，宁可等上层下移重排，也不把整段缩成看不清的小字。
    """
    math = math_fontfile()
    cjk = cjk_fontfile() or ""
    if not math or not cjk:
        return size, box.y1, True, []
    unrep = unrepresentable_commands(text)
    html = inline_math_html(text)
    css = _math_css(cjk, math, float(size), color)
    try:
        spare, scale = page.insert_htmlbox(
            box, "<p>%s</p>" % html, css=css, scale_low=float(min_scale)
        )
    except Exception:  # noqa: BLE001
        return size, box.y1, True, unrep
    eff = max(MIN_FONT_SIZE, float(size) * float(scale))
    overflow = bool(spare is not None and spare < 0)
    used = box.y0 + max(0.0, box.height - max(0.0, float(spare or 0.0)))
    return round(eff, 2), used, overflow, unrep


def _draw_math_box(page, box, text: str, size: float, color) -> tuple[float, float, bool]:
    """中文 + 数学变体混排（`insert_htmlbox`），保留 𝒫/ℙ 的字体类别。

    返回 (实际字号, 底部 y, 是否溢出)。数学字体不存在时由调用方走普通路径。
    """
    import html as _html

    math = math_fontfile()
    cjk = cjk_fontfile() or ""
    if not math or not cjk:
        return size, box.y1, True
    esc = _html.escape(text)
    esc = _MATH_VARIANTS_RE.sub(
        lambda m: "<span class='m'>%s</span>" % m.group(0), esc
    )
    css = _math_css(cjk, math, float(size), color)
    try:
        spare, scale = page.insert_htmlbox(
            box, "<p>%s</p>" % esc, css=css, scale_low=0.55
        )
    except Exception:  # noqa: BLE001
        return size, box.y1, True
    eff = max(MIN_FONT_SIZE, float(size) * float(scale))
    overflow = bool(spare is not None and spare < 0)
    used = box.y0 + max(0.0, box.height - max(0.0, float(spare or 0.0)))
    return round(eff, 2), used, overflow


def _marker(target_lang: str) -> str:
    return "[ZH] " if target_lang.lower().startswith("zh") else f"[{target_lang.upper()}] "


def translate_text(
    text: str,
    backend: str,
    target_lang: str,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    headers: dict | None = None,
    cache: dict | None = None,
    no_think: bool = True,
) -> str:
    if not text.strip():
        return text
    if backend in ("none", "echo"):
        return text
    if backend == "openai":
        out = _openai_translate_plain(
            text, target_lang, base_url, api_key, model, headers, no_think=no_think
        )
        # 少数模型会在译文前加「[0]/0./1)」编号（批量 id 协议的残留），去掉
        return re.sub(r"^\s*(?:\[\s*\d+\s*\]|\d+\s*[.)、])\s*", "", out).strip()
    # mock（默认）：确定性前缀，离线可用
    return _marker(target_lang) + re.sub(r"\s+", " ", text).strip()


def _openai_translate_plain(
    text: str,
    target_lang: str,
    base_url: str | None,
    api_key: str | None,
    model: str | None,
    headers: dict | None = None,
    no_think: bool = True,
) -> str:
    """单段翻译：**不用** id/JSON 数组协议。

    划词翻译只有一段，走数组协议既慢，又容易被模型把 `[{"id":"0"...}]`
    回显成「[0]」前缀。这里直接用纯文本请求。
    """
    if not base_url or not api_key:
        raise RuntimeError("未配置翻译密钥（请在 设置 → 模型服务 填写 API Key）")
    url = chat_endpoint(base_url)
    body: dict = {
        "model": model or "gpt-4o-mini",
        "temperature": 0,
        "messages": [
            {
                "role": "system",
                "content": (
                    f"Translate the user's text into {target_lang}. "
                    "Keep mathematical symbols, placeholders like ⟦0⟧ and paragraph breaks. "
                    "Output only the translation, with no numbering, quotes or commentary."
                ),
            },
            {"role": "user", "content": text},
        ],
    }
    if no_think:
        body["thinking"] = {"type": "disabled"}
    # 单段路径此前漏了鉴权头（批量路径在下面自己拼过），真模型下必然 401。
    # 按**接口协议**选头：/chat/completions -> Bearer；/messages -> x-api-key。
    r = _post_chat(url, body, auth_headers(url, api_key, headers), 120.0)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code} {_api_error(r.text)}")
    content = (response_text(r.json()) or "").strip()
    if content.startswith("```"):
        content = content.strip("`").strip()
    return content


def _openai_translate(
    text: str,
    target_lang: str,
    base_url: str | None,
    api_key: str | None,
    model: str | None,
    headers: dict | None = None,
    no_think: bool = True,
) -> str:
    return _openai_translate_many(
        [text], target_lang, base_url, api_key, model, headers, no_think=no_think
    )[0]


def _openai_translate_many(
    texts: list[str],
    target_lang: str,
    base_url: str | None,
    api_key: str | None,
    model: str | None,
    extra_headers: dict | None = None,
    system: str | None = None,
    timeout: float = 120.0,
    ids: list[str] | None = None,
    no_think: bool = True,
) -> list[str]:
    """一次请求翻译多条（返回等长 JSON 数组）。失败会抛异常（不静默回退）。

    每条前面带**稳定 id**：坐标/样式留在本地，翻译只认 id。返回后会校验
    「id 齐全、无重复、无空串」；不满足则退回按顺序 / 逐条翻译。

    no_think=True 时请求体带 `thinking: {"type": "disabled"}`：论文段落翻译不需要
    推理，开着思考会让单请求多等几十秒。服务端不接受该参数时由 `_post_chat`
    自动去掉并重试，不影响其它网关。
    """
    import json

    if not base_url or not api_key:
        raise RuntimeError("未配置翻译密钥（请在 设置 → 模型服务 填写 API Key）")

    ids = ids or [str(i) for i in range(len(texts))]
    if len(ids) != len(texts):
        raise RuntimeError("内部错误：翻译 id 与文本数量不一致")

    system_prompt = system or (
        f"Translate each numbered segment into {target_lang}. "
        "Segments are prefixed with a stable id in square brackets; keep the same order. "
        "Keep placeholders such as ⟦0⟧ unchanged. "
        "Return ONLY a JSON array of strings, same order and same count. "
        "Do not merge or split segments."
    )
    url = chat_endpoint(base_url)
    headers = auth_headers(url, api_key, extra_headers)
    numbered = "\n".join(f"[{i}] {t}" for i, t in zip(ids, texts))
    first_err = ""

    # 先尝试批量
    try:
        body: dict = {
            "model": model or "gpt-4o-mini",
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": numbered},
            ],
        }
        if no_think:
            body["thinking"] = {"type": "disabled"}
        r = _post_chat(url, body, headers, timeout)
        if r.status_code >= 400:
            first_err = f"HTTP {r.status_code} {_api_error(r.text)}"
        else:
            content = (response_text(r.json()) or "").strip()
            if content.startswith("```"):
                content = content.strip("`")
                content = content[content.find("[") :]
            start, end = content.find("["), content.rfind("]")
            arr = json.loads(content[start : end + 1]) if start >= 0 and end > start else None
            if isinstance(arr, list) and len(arr) == len(texts):
                # 优先：对象数组 {"id": ..., "text": ...} —— 可以真正按 id 校验
                if all(isinstance(x, dict) for x in arr):
                    got: dict[str, str] = {}
                    dup = False
                    for x in arr:
                        k = str(x.get("id") or "")
                        if k in got:
                            dup = True
                            break
                        got[k] = str(x.get("text") or "")
                    if dup:
                        first_err = "模型返回了重复 id"
                    elif set(got) == set(ids) and all(got[k].strip() for k in ids):
                        return [got[k] for k in ids]
                    else:
                        first_err = "模型返回的 id 与请求不一致（缺失/多余）"
                elif all(str(x).strip() for x in arr):
                    # 兼容：只返回字符串数组（按请求顺序对应 id）
                    return [str(x) for x in arr]
                else:
                    first_err = "模型返回了空字符串"
            else:
                first_err = "模型返回格式不符合预期（期望等长非空 JSON 数组）"
    except Exception as exc:  # noqa: BLE001
        first_err = str(exc)[:200]

    # 兜底：只在**单条**请求时退化为纯文本（1 次额外请求）。
    # 批量时绝不在这里串行重试——那会让一个 32 段的批次在最坏情况下变成 32×timeout，
    # 外层也无法按批次/单块做统一的限流与取消。
    if len(texts) != 1:
        raise RuntimeError(first_err or "批量翻译失败")
    t = texts[0]
    try:
        body = {
            "model": model or "gpt-4o-mini",
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": f"Translate into {target_lang}. Output only the translation.",
                },
                {"role": "user", "content": t},
            ],
        }
        if no_think:
            body["thinking"] = {"type": "disabled"}
        r = _post_chat(url, body, headers, timeout)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code} {_api_error(r.text)}")
        content = (response_text(r.json()) or "").strip()
        if not content:
            raise RuntimeError(
                "模型返回空内容（可能模型/端点不兼容，或该模型不走 /chat/completions）"
            )
        return [content]
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(first_err or str(exc)[:200]) from exc


def _api_error(body: str) -> str:
    """从错误体里提取可读信息（兼容 OpenAI / OpenCode 结构）"""
    import json

    try:
        j = json.loads(body)
        for path in (("error", "message"), ("error", "error", "message"), ("message",)):
            cur = j
            ok = True
            for k in path:
                if isinstance(cur, dict) and k in cur:
                    cur = cur[k]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, str) and cur:
                return cur[:200]
    except Exception:  # noqa: BLE001
        pass
    return body[:200]


def _post_chat(url: str, body: dict, headers: dict | None, timeout: float):
    """POST /chat/completions；带 thinking 关闭参数，服务端拒绝时自动去掉重试一次。

    为什么要重试：`thinking` 是部分网关（OpenCode Zen / DeepSeek）的扩展字段，
    严格校验的 OpenAI 兼容服务会以 400「unknown/unsupported parameter」拒绝。
    一次失败后在本进程内永久停用该字段，不把错误暴露给上层。
    """
    global _NO_THINK_UNSUPPORTED
    from . import _http as http

    def _send(payload: dict):
        wire_body, wire_headers = chat_payload(url, payload, headers)
        return http.post(url, json=wire_body, headers=wire_headers, timeout=timeout)

    if "thinking" not in body or _NO_THINK_UNSUPPORTED:
        return _send({k: v for k, v in body.items() if k != "thinking"})
    r = _send(body)
    if r.status_code < 400:
        return r
    detail = f"{_api_error(r.text)} {str(getattr(r, 'text', ''))[:300]}"
    if not _THINK_PARAM_RE.search(detail):
        return r
    _NO_THINK_UNSUPPORTED = True
    try:
        sys.stderr.write(
            "[translate] 服务端不接受 thinking 参数，已停用「关闭思考」并重试（本进程内不再发送）\n"
        )
    except Exception:  # noqa: BLE001
        pass
    return _send({k: v for k, v in body.items() if k != "thinking"})


def _apply_redactions(page: "fitz.Page") -> None:
    try:
        page.apply_redactions(images=_IMG_NONE, graphics=_LINE_NONE)
    except TypeError:
        page.apply_redactions()


def _glossary_cache_file(cache_dir: str, key: str) -> str:
    d = os.path.join(cache_dir, ".glossary")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, key + ".json")


def extract_glossary(
    sample: str,
    target_lang: str,
    base_url: str | None,
    api_key: str | None,
    model: str | None,
    headers: dict | None = None,
    cache_dir: str | None = None,
    limit: int = 24,
) -> list[tuple[str, str]]:
    """从标题/摘要/正文抽样里抽「术语 → 目标语译法」，供全篇统一使用。

    - 只发**一次**请求（关闭思考，约 5~8s）；
    - 结果按「内容 + 语言 + 模型」落盘缓存，同一篇论文重译时零成本；
    - 任何失败都返回空表：不加术语约束，但绝不阻断翻译。
    """
    import hashlib

    text = (sample or "").strip()
    if not text or not base_url or not api_key:
        return []
    key = hashlib.sha1(f"{target_lang}\n{model}\n{text[:6000]}".encode("utf-8")).hexdigest()[:16]
    cache = _glossary_cache_file(cache_dir, key) if cache_dir else None
    if cache:
        try:
            with open(cache, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                pairs = [(str(a), str(b)) for a, b in data if a and b]
                if pairs:
                    return pairs[:limit]
        except Exception:  # noqa: BLE001
            pass

    url = chat_endpoint(base_url)
    req_headers = auth_headers(url, api_key, headers)
    system = (
        "You are a terminology extractor for academic papers. "
        f"Pick the {limit} most important domain-specific terms (nouns or short noun phrases) "
        "from the excerpts and give their standard translations. "
        'Return ONLY a JSON array of objects: [{"en": "...", "zh": "..."}]. '
        "No definitions, no commentary, no duplicates. "
        f"Target language: {target_lang}."
    )
    try:
        # 走 _post_chat：抽术语同样不想开思考；服务端拒绝 thinking 参数时会自动去掉重试，
        # 不会因为严格校验而让术语表永远为空（那会每次翻译都白发一次失败请求）。
        r = _post_chat(
            url,
            {
                "model": model or "gpt-4o-mini",
                "temperature": 0,
                "max_tokens": 1200,
                # 抽术语不需要推理：开思考只会白白多等十几秒
                "thinking": {"type": "disabled"},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": text[:6000]},
                ],
            },
            req_headers,
            60.0,
        )
        if r.status_code >= 400:
            return []
        content = (response_text(r.json()) or "").strip()
        start, end = content.find("["), content.rfind("]")
        if start < 0 or end <= start:
            return []
        arr = json.loads(content[start : end + 1])
    except Exception:  # noqa: BLE001
        return []

    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    if isinstance(arr, list):
        for item in arr:
            if not isinstance(item, dict):
                continue
            en = str(item.get("en") or item.get("term") or "").strip()
            zh = str(item.get("zh") or item.get("translation") or "").strip()
            if not en or not zh or len(en) > 60 or len(zh) > 40:
                continue
            k = en.lower()
            if k in seen:
                continue
            seen.add(k)
            out.append((en, zh))
            if len(out) >= limit:
                break
    if cache and out:
        try:
            with open(cache, "w", encoding="utf-8") as fh:
                json.dump([list(t) for t in out], fh, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            pass
    return out


def parse_glossary(text: str | None, limit: int = 60) -> list[tuple[str, str]]:
    """解析用户自定义术语表：每行 `英文=中文`（也接受 `英文:中文` / 制表符分隔）。"""
    out: list[tuple[str, str]] = []
    for line in (text or "").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        sep = "=" if "=" in raw else ("\t" if "\t" in raw else ("：" if "：" in raw else ":"))
        if sep not in raw:
            continue
        en, _, zh = raw.partition(sep)
        en, zh = en.strip(), zh.strip()
        if en and zh:
            out.append((en, zh))
        if len(out) >= limit:
            break
    return out


def _sample_bg(pix, rect: "fitz.Rect", page_rect: "fitz.Rect"):
    """从页面位图采样某块区域的**背景色**（取众数，文字像素属少数，故为底色）。

    返回 (r, g, b) 0..1，或 None（无法采样）。
    """
    if pix is None:
        return None
    try:
        sx = pix.width / max(1.0, page_rect.width)
        sy = pix.height / max(1.0, page_rect.height)
        x0 = max(0, int(rect.x0 * sx))
        x1 = min(pix.width - 1, int(rect.x1 * sx))
        y0 = max(0, int(rect.y0 * sy))
        y1 = min(pix.height - 1, int(rect.y1 * sy))
        if x1 <= x0 or y1 <= y0:
            return None
        cnt: dict[tuple[int, int, int], int] = {}
        for i in range(6):
            x = x0 + (x1 - x0) * i // 5
            for j in range(3):
                y = y0 + (y1 - y0) * j // 2
                px = pix.pixel(x, y)
                key = (px[0] // 16, px[1] // 16, px[2] // 16)
                cnt[key] = cnt.get(key, 0) + 1
        if not cnt:
            return None
        (r, g, b), _ = max(cnt.items(), key=lambda kv: kv[1])
        rr = min(1.0, (r * 16 + 8) / 255)
        gg = min(1.0, (g * 16 + 8) / 255)
        bb = min(1.0, (b * 16 + 8) / 255)
        # 量化会把纯白 255 算成 248/255≈0.972（肉眼是浅灰）。
        # 近白统一归到纯白，否则每个文本块都会被刷成一块灰色矩形。
        if min(rr, gg, bb) >= 0.94 and max(rr, gg, bb) - min(rr, gg, bb) <= 0.03:
            return (1.0, 1.0, 1.0)
        return (rr, gg, bb)
    except Exception:  # noqa: BLE001
        return None


def _lum(c: tuple[float, float, float]) -> float:
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def _pick_text_color(orig_int, bg):
    """选译文颜色：优先沿用原字色；若与底色对比不足则按底色亮度取黑/白，保证可读。"""
    oc = None
    if isinstance(orig_int, int) and orig_int >= 0:
        oc = (((orig_int >> 16) & 255) / 255, ((orig_int >> 8) & 255) / 255, (orig_int & 255) / 255)
    if bg is None:
        return oc or (0.0, 0.0, 0.0)
    lb = _lum(bg)
    if oc is not None and abs(_lum(oc) - lb) > 0.35:
        return oc
    return (0.0, 0.0, 0.0) if lb > 0.5 else (1.0, 1.0, 1.0)


# 译文最小可读字号（floor）。低于此值不再缩字，宁可下移/重排。
MIN_FONT_SIZE = 8.0
# 译文最大字号（避免从微小矩形里推算出夸张字号）。
MAX_FONT_SIZE = 22.0


def _fit_text_rotated(
    page: "fitz.Page",
    rect: "fitz.Rect",
    text: str,
    n_lines: int,
    angle: float,
    max_h: float | None = None,
    orig_size: float | None = None,
    max_w: float | None = None,
    color: tuple[float, float, float] | None = None,
    stats: dict | None = None,
    min_size: float = 4.0,
) -> tuple[float, float]:
    """倾斜文本的保角度落版：和 ``_fit_text`` 相同的「先原文号、放不下再缩」策略。

    实现用 ``TextWriter.fill_textbox`` 在**水平局部坐标**里排版，再用
    ``write_text(morph=(pivot, Matrix(angle)))`` 绕锚点旋转，因此译文既能换行/缩字，
    又保持与原文一致的文字方向（竖排标签、旋转表头、坐标轴标题）。

    返回 ``(字号, 文本底部 y)``，供上层排版游标使用。
    """
    if stats is not None:
        stats["last_truncated"] = False
        stats["last_ok"] = True
    body = (text or "").strip()
    if not body:
        return 0.0, rect.y0
    cjk = has_cjk(body)
    fontname = cjk_fontname(page) if cjk else "helv"
    font = _font_for(fontname)
    body = _sanitize_text(body, font)
    if not body.strip() or font is None:
        # 没有可用字体对象：退回水平落版（宁可不倾斜，也不能丢内容）
        return _fit_text(
            page, rect, body, n_lines, max_h, orig_size, max_w, color, stats, min_size
        )

    lh = 1.24
    if orig_size and float(orig_size) > 1.0:
        base = float(orig_size) * (1.0 if cjk else 1.06)
    else:
        # 没有原文实测字号时，用矩形短边估算（旋转块的 bbox 长边不是行高）
        base = min(rect.width, rect.height) * 0.8
    base = max(MIN_FONT_SIZE, min(MAX_FONT_SIZE, base))

    rad = math.radians(float(angle))
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    ac, as_ = abs(cos_a), abs(sin_a)
    w = max(1.0, float(rect.width))
    h = max(1.0, float(rect.height))
    # 局部坐标：L 沿文字方向，H 垂直于文字方向。bbox 是旋转后的轴对齐外框，
    # 用 (w,h) 反解 L（减去行高在垂直方向的投影），避免 90° 竖排被当成「很窄」。
    h0 = max(1, int(n_lines or 1)) * base * lh
    l1 = (w - h0 * as_) / max(ac, 0.1)
    l2 = (h - h0 * ac) / max(as_, 0.1)
    local_w = max(l1, l2, base * 2.0)
    local_w = min(local_w, max(w, h) * 1.6, max(page.rect.width, page.rect.height))
    max_local_h = min(
        max(w, h) * 1.8,
        (float(max_h) - float(rect.y0)) if max_h is not None else page.rect.height,
    )
    max_local_h = max(base * lh, max_local_h)
    cx, cy = float(rect.x0) + w / 2.0, float(rect.y0) + h / 2.0
    mat = fitz.Matrix(float(angle))

    def _page_pt(lx: float, ly: float) -> tuple[float, float]:
        # PyMuPDF 的 Matrix(θ) 在 write_text 里把局部 +x 映射为 (cosθ, -sinθ)、
        # +y 映射为 (sinθ, cosθ)。这里按同一约定换算，锚点才能和局部排版对齐。
        return (cx + lx * cos_a + ly * sin_a, cy - lx * sin_a + ly * cos_a)

    candidates = [base]
    for c in (12.0, 11.0, 10.0, 9.5, 9.0, 8.5, 8.0, 7.5, 7.0, MIN_FONT_SIZE):
        if c < base - 0.05:
            candidates.append(c)
    if MIN_FONT_SIZE not in candidates:
        candidates.append(MIN_FONT_SIZE)

    def _try(size: float, box_h: float) -> tuple[float, float] | None:
        lines = _est_lines(body, local_w, size, cjk)
        need = max(1, lines) * size * lh
        box_h = max(box_h, need)
        if box_h > max_local_h + 0.5:
            return None
        hx, hy = local_w / 2.0, box_h / 2.0
        px, py = cx - (hx * cos_a + hy * sin_a), cy - (-hx * sin_a + hy * cos_a)
        box = fitz.Rect(px, py, px + local_w, py + box_h)
        tw = fitz.TextWriter(page.rect)
        try:
            left = tw.fill_textbox(
                box,
                body,
                pos=(px, py),
                font=font,
                fontsize=size,
                lineheight=lh,
                align=0,
            )
        except Exception:  # noqa: BLE001
            return None
        if left:
            return None
        tw.write_text(page, color=color if color is not None else (0.0, 0.0, 0.0), morph=(fitz.Point(px, py), mat))
        # 已写文本的底部：局部外框四角旋转后的最大 y（用于页内重排游标）
        ys = [_page_pt(lx, ly)[1] for lx in (0.0, local_w) for ly in (0.0, box_h)]
        return size, max(page.rect.y0 + 1.0, min(max(ys), page.rect.height))

    for size in candidates:
        lines = _est_lines(body, local_w, size, cjk)
        need = max(1, lines) * size * lh
        for box_h in (need, need + size * 0.6):
            got = _try(size, box_h)
            if got is not None:
                return got

    if stats is not None:
        stats["truncated"] = int(stats.get("truncated", 0)) + 1
        stats["last_truncated"] = True
        stats["last_ok"] = False
    return 4.0, float(rect.y1)


def _fit_text(
    page: "fitz.Page",
    rect: "fitz.Rect",
    text: str,
    n_lines: int,
    max_h: float | None = None,
    orig_size: float | None = None,
    max_w: float | None = None,
    color: tuple[float, float, float] | None = None,
    stats: dict | None = None,
    min_size: float = 4.0,
    angle: float = 0.0,
    size_delta: float = 0.0,
) -> tuple[float, float]:
    """把译文写进矩形，返回 (实际字号, 文本底部 y)。

    策略（优先保证「可读」而非「塞进原盒子」）：
      1. 目标字号取**原文实测字号**（``orig_size``），使译文与周边排版同级；
         不再用矩形高度反推，避免系统性过缩（尤其是标题 / 小栏正文）。
      2. 优先在原矩形内落版；放不下则**向下扩展**到 ``max_h``（同栏下一障碍物之前的空隙）。
      3. 只有扩展到空隙仍放不下时，才逐级**缩小字号**，但**绝不低于 MIN_FONT_SIZE**。
      4. 用 ``insert_textbox`` 的返回值判定是否溢出；溢出则重试更小字号，避免静默裁切。
         超出空隙的重排（下移后续块）由上层 write 循环负责。

    ``max_h`` 为允许的**底部 y 坐标上限**；``max_w`` 为允许的**右侧 x 上限**（单行块可用）。
    返回底部 y 供重排游标使用。
    """
    if abs(float(angle or 0.0)) >= 1.0:
        return _fit_text_rotated(
            page,
            rect,
            text,
            n_lines,
            float(angle),
            max_h,
            orig_size,
            max_w,
            color,
            stats,
            min_size,
        )
    if stats is not None:
        stats['last_truncated'] = False
        stats['last_ok'] = True
    if not (text or "").strip():
        return 0.0, rect.y0
    cjk = has_cjk(text)
    fontname = cjk_fontname(page) if cjk else "helv"
    lh = 1.24 if cjk else 1.24
    # 字体缺失字形 → 映射/剔除，避免出现「口」字形占位符
    text = _sanitize_text(text, _font_for(fontname))
    if not text.strip():
        return 0.0, rect.y0

    # 目标字号：按原文实测字号并稍微放大（6%），尽量让译文更清晰；
    # 放不下再由下方候选逐级缩小（绝不低于 MIN_FONT_SIZE）。
    base = float(orig_size) * (1.0 if cjk else 1.06) if orig_size and orig_size > 1.0 else rect.height / max(1, n_lines) * 0.86
    # 用户可见的字号增量（默认 +1.5pt）：译文偏小时整体调大一档，再由候选逐级回收
    if size_delta:
        base = base + float(size_delta)
    base = max(MIN_FONT_SIZE, min(MAX_FONT_SIZE, base))

    # 水平可用宽度：单行块（多为标题/标签）可用同排右侧障碍物之前的空间；
    # 其余块仅留极小余量，避免紧贴盒子边界而被迫换行/缩字。
    # 水平可用宽度：**单行标题/标签和普通段落**都可以用到同栏右侧障碍物之前的空间。
    # 旧实现只给单行块扩宽 → 段落末行/短段被压成 4–6pt，而旁边其实整栏空白。
    if max_w is not None:
        bx1 = min(max(rect.x1, float(max_w)), page.rect.width - 6.0)
    else:
        x_slack = min(6.0, rect.width * 0.08) if len(text) <= 48 else 0.0
        bx1 = min(rect.x1 + x_slack, page.rect.width - 6.0)
    bx1 = max(bx1, rect.x0 + 1.0)
    box_w = max(1.0, bx1 - rect.x0)

    page_bottom = page.rect.height - 8.0
    bottom = page_bottom
    if max_h is not None:
        bottom = min(page_bottom, max(float(max_h), rect.y0 + MIN_FONT_SIZE * lh))
    max_box_h = max(MIN_FONT_SIZE * lh, bottom - rect.y0)

    # 候选字号：优先目标字号，其后严格递减，最后兜底到 floor
    candidates = [base]
    for c in (12.0, 11.0, 10.0, 9.5, 9.0, 8.5, 8.0, 7.5, 7.0, MIN_FONT_SIZE):
        if c < base - 0.05:
            candidates.append(c)
    if MIN_FONT_SIZE not in candidates:
        candidates.append(MIN_FONT_SIZE)

    for size in candidates:
        lines = _est_lines(text, box_w, size, cjk)
        need = lines * size * lh
        # 同一字号下先按估算高度试，放不下再加一点「行高余量」再试（避免因估算偏紧而过缩）
        for box_h in (need, need + size * 0.55):
            if box_h <= rect.height + 0.5:
                box = fitz.Rect(rect.x0, rect.y0, bx1, min(bottom, max(rect.y1, rect.y0 + box_h)))
            elif box_h <= max_box_h + 0.5:
                box = fitz.Rect(rect.x0, rect.y0, bx1, rect.y0 + box_h)
            else:
                continue
            left = page.insert_textbox(
                box, text, fontname=fontname, fontsize=size, lineheight=lh,
                color=color if color is not None else (0.0, 0.0, 0.0),
            )
            if left is None or left >= 0:
                return size, box.y1

    # 仍放不下：用允许区域内 + floor 字号写入（至少保证字号不低于 floor、不静默缩字）
    # 放不下时：先继续缩小字号（4pt 起，**内容完整**优先于字号），仍放不下才截断并记账
    box = fitz.Rect(rect.x0, rect.y0, bx1, max(bottom, rect.y0 + MIN_FONT_SIZE * lh))
    for tiny in (MIN_FONT_SIZE, 6.5, 6.0, 5.0, 4.0):
        if tiny < min_size:
            continue
        left = page.insert_textbox(
            box, text, fontname=fontname, fontsize=tiny, lineheight=lh,
            color=color if color is not None else (0.0, 0.0, 0.0),
        )
        if left is None or left >= 0:
            return tiny, box.y1
    # 极小字号仍溢出：insert_textbox 会静默截断 -> 记录，供上层报告
    if stats is not None:
        stats['truncated'] = int(stats.get('truncated', 0)) + 1
        stats['last_truncated'] = True
        # 明确告诉调用方「这段没有落版」：不能把它计成已写（否则 PDF 会留空白却报成功）
        stats['last_ok'] = False
    return 4.0, box.y1


def _write_original_back(
    page: "fitz.Page", rect: "fitz.Rect", raw: str, orig_size: float | None
) -> bool:
    """译文放不下时的兜底：把**原文**写回同一矩形，保证页面不出现无解释的空白。

    译文完整内容已按源页写入 overflow sidecar，不会被丢弃。
    """
    body = (raw or "").strip()
    if not body:
        return False
    size = float(orig_size or 9.0)
    cjk = has_cjk(body)
    fontname = cjk_fontname(page) if cjk else "helv"
    text = _sanitize_text(body, _font_for(fontname))
    if not text.strip():
        return False
    cand = [size]
    s = size
    while s > 5.0:
        s *= 0.9
        cand.append(s)
    for s in cand:
        left = page.insert_textbox(
            rect, text, fontname=fontname, fontsize=s, lineheight=1.18
        )
        if left is None or left >= 0:
            return True
    # 最后一次尝试仍须检查返回值，失败由调用方明确记账。
    try:
        left = page.insert_textbox(
            rect, text, fontname=fontname, fontsize=5.0, lineheight=1.1
        )
        if left is None or left >= 0:
            return True
    except Exception:  # noqa: BLE001
        pass
    return False


def _est_lines(text: str, width: float, size: float, cjk: bool) -> int:
    """估算文本在给定宽度/字号下需要多少行（CJK 按近方形估，拉丁按约 0.52em 估）。"""
    if width <= 1 or size <= 0:
        return max(1, text.count("\n") + 1)
    per = max(1.0, width / (size * (1.0 if cjk else 0.52)))
    n = 0
    for para in text.split("\n"):
        n += max(1, int(len(para) / per) + 1)
    return n


def _x_overlap(a: "fitz.Rect", b: "fitz.Rect") -> float:
    return max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))


# ---- 矢量图形识别：位于「图形内部」的文本不翻译、不覆盖（保持图形原样） ----
_FIG_MARGIN = 1.5


def _figure_regions(page: "fitz.Page", draws: list | None = None) -> list["fitz.Rect"]:
    """把页面上矢量绘图聚成若干「图形区域」包围盒，供判定图形内部文本。

    仅返回像「图形」的簇（含曲线/填充，或「矩形+连线」的示意图结构），
    以尽量排除纯线条网格（表格边框）。近整页的边框/背景亦被排除。
    """
    try:
        draws = page.get_drawings() if draws is None else draws
    except Exception:  # noqa: BLE001
        return []
    rects: list[fitz.Rect] = []
    feats: list[dict] = []
    for d in draws:
        r = d.get("rect")
        if r is None:
            continue
        rr = fitz.Rect(r)
        if rr.is_infinite:
            continue
        f = {"curve": False, "rect": False, "line": False, "fill": d.get("type") in ("f", "fs")}
        for it in d.get("items") or []:
            k = it[0]
            if k in ("c", "qu"):
                f["curve"] = True
            elif k == "re":
                f["rect"] = True
            elif k == "l":
                f["line"] = True
        rects.append(rr)
        feats.append(f)
    if not rects:
        return []

    n = len(rects)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    # 连通域：栅格只用来**找候选**，最终仍用原始「margin 内相邻」判定确认，
    # 所以不会改变结果。原来是 O(n²)：30 页论文里单页 12.8s、整篇分析 385s。
    if n > 1:
        _CELL = _FIG_MARGIN

        def _near(a: int, b: int) -> bool:
            ra, rb = rects[a], rects[b]
            return not (
                ra.x1 + _FIG_MARGIN < rb.x0
                or rb.x1 + _FIG_MARGIN < ra.x0
                or ra.y1 + _FIG_MARGIN < rb.y0
                or rb.y1 + _FIG_MARGIN < ra.y0
            )

        # 膨胀一个 margin：能相邻的两个矩形必定落在同一格（不漏）
        # 近整页的背景框会覆盖十几万格，单独走「与所有元素比较」（n 次），否则单页要 1s
        owner: dict[tuple[int, int], int] = {}
        big: list[int] = []
        for i, rr in enumerate(rects):
            x0 = int((rr.x0 - _FIG_MARGIN) // _CELL)
            x1 = int((rr.x1 + _FIG_MARGIN) // _CELL)
            y0 = int((rr.y0 - _FIG_MARGIN) // _CELL)
            y1 = int((rr.y1 + _FIG_MARGIN) // _CELL)
            if (x1 - x0 + 1) * (y1 - y0 + 1) > n:
                big.append(i)
                continue
            for cx in range(x0, x1 + 1):
                for cy in range(y0, y1 + 1):
                    k = (cx, cy)
                    prev = owner.get(k)
                    if prev is None:
                        owner[k] = i
                    elif prev != i and _near(prev, i):
                        union(prev, i)
        for b in big:
            for a in range(n):
                if a != b and _near(a, b):
                    union(a, b)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    pw, ph = page.rect.width, page.rect.height
    out: list[fitz.Rect] = []
    for idxs in groups.values():
        r = rects[idxs[0]]
        has_curve = has_fill = has_rect = has_line = False
        for k in idxs:
            r = r | rects[k]
            has_curve = has_curve or feats[k]["curve"]
            has_fill = has_fill or feats[k]["fill"]
            has_rect = has_rect or feats[k]["rect"]
            has_line = has_line or feats[k]["line"]
        if r.width < 10 or r.height < 10:  # 图标也可能很小（原 24 会漏掉小图标）
            continue
        if r.width > 0.9 * pw and r.height > 0.75 * ph:  # 近整页边框/背景
            continue
        # 图形特征：曲线/填充，或「矩形 + 连线」的示意图；纯线条网格（表格）被排除
        if not (has_curve or has_fill or (has_rect and has_line)):
            continue
        out.append(r)
    return out


def _inside_figure(rect: "fitz.Rect", regions: list["fitz.Rect"]) -> bool:
    area = rect.get_area()
    if area <= 0:
        return False
    for r in regions:
        inter = r & rect
        if inter.is_valid and inter.get_area() >= 0.88 * area:
            return True
    return False


_TR_CSS = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
/* 阅读栏：舒适宽度 + 中文友好行高/字距 */
body { max-width: 720px; margin: 0 auto; padding: 0 22px 80px;
       font-family: -apple-system, 'Segoe UI', 'Noto Sans SC', 'PingFang SC',
                    'Microsoft YaHei', 'Source Han Sans SC', sans-serif;
       font-size: 17px; line-height: 1.9; color: #1b1e23; background: #fff;
       letter-spacing: .01em; text-wrap: pretty;
       -webkit-text-size-adjust: 100%; }
/* 标题层级：越上级越大、间距越舒展；避免标题与后文脱节 */
h1, h2, h3 { line-height: 1.45; font-weight: 700; color: #14171c;
             margin: 1.6em 0 .55em; break-after: avoid; text-wrap: balance; }
h1 { font-size: 1.55em; margin-top: 1.3em; }
h2 { font-size: 1.32em; margin-top: 1.5em; }
h3 { font-size: 1.12em; font-weight: 600; margin: 1.25em 0 .38em; }
p { margin: .9em 0; orphans: 3; widows: 3; }
.para { }
/* 外链（原文 URL / 链接注解）：可点、可辨识，并标出会打开浏览器 */
a.ext-link { color: #2f6fed; text-decoration: underline; text-underline-offset: 2px; }
a.ext-link::after { content: " ↗"; font-size: .82em; opacity: .75; }
/* 图表区域：与正文段落样式隔离，绝不套用 body/para 排版 */
.fig { margin: 1.4em 0 .35em; text-align: center; break-inside: avoid; }
.fig img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
img { max-width: 100%; height: auto; }
/* 题注：居中、小一号、弱色，视觉上区别于正文 */
.caption { margin: .5em auto 1.5em; max-width: 96%; text-align: center;
           font-size: .88em; line-height: 1.65; color: #5b6167;
           orphans: 3; widows: 3; }
/* 公式：逐字保留、居中、可用横向滚动，不被拆断 */
.formula { font-family: 'Cambria Math', 'Latin Modern Math', 'STIX Two Math', Georgia, serif;
           text-align: center; margin: 1.15em 0; font-size: 1.02em; line-height: 1.7;
           overflow-x: auto; break-inside: avoid; }
.pg { margin-bottom: 34px; }
.pg + .pg { border-top: 1px solid #ececec; padding-top: 24px; }
.pgno { position: sticky; top: 0; z-index: 3; font-size: 11px; color: #9aa0a6;
        background: rgba(255,255,255,.92); -webkit-backdrop-filter: blur(4px);
        backdrop-filter: blur(4px); padding: 5px 0; margin-bottom: 10px;
        letter-spacing: .5px; }
.pg-target { background: rgba(120,180,255,.28); border-radius: 4px; }
.math { font-family: 'Cambria Math', 'Latin Modern Math', 'STIX Two Math', Georgia, serif; }
.math sub, .math sup { font-size: .72em; }
@media (prefers-color-scheme: dark) {
  body { background: #1b1d21; color: #e6e6e6; }
  h1, h2, h3 { color: #eef0f3; }
  .caption { color: #9aa0a6; }
  .pg + .pg { border-top-color: #2c2f34; }
  .pgno { background: rgba(27,29,33,.9); color: #8b9099; }
}
"""

_FORMULA_HINT = set("=∑∫√±×÷≈≠≤≥∞∂∇αβγθλμπσφψωΔΩ→←↔∈∉⊂⊃∪∩")

_CAPTION_RE = re.compile(r"(?i)^\s*(fig(ure)?\.?|table|algorithm|listing)\s*\d*|^\s*(图|表)\s*\d*")
# 图/表题注（供可重排阅读区标记 data-cap，仍按普通文本翻译）
_CAP_RE = re.compile(r"(?i)^\s*(figure|fig\.?|table|图|表)\s*\d")
_REF_ITEM_RE = re.compile(r"^\s*\[\d+\]\s")
_NUM_REF_RE = re.compile(r"^\s*\d{1,3}\.\s+")
_REF_HEADING_RE = re.compile(r"(?i)^\s*(references|bibliography|works cited|参考文献|參考文獻)\s*$")
_ABSTRACT_RE = re.compile(r"(?i)^\s*(abstract|摘要)\b")
_SECTION_START_RE = re.compile(
    r"(?i)^\s*(\d+(\.\d+)*)\s+[A-Z\u4e00-\u9fff]"
    r"|^\s*(keywords|key words|ccs concepts|introduction|related work|background|"
    r"关键词|引言|相关工作)\b"
)
_PAGE_NUM_RE = re.compile(r"(?i)^(page\s*)?\d{1,4}\s*(/\s*\d{1,4})?$")
_ROMAN_RE = re.compile(r"^[ivxlcdm]{1,7}$", re.IGNORECASE)
# 参考文献之后的"后置事项"标题：遇到就结束 refsec，
# 否则作者贡献/致谢等正文会被当成参考文献跳过。
_BACK_MATTER_RE = re.compile(
    r"(?i)^\s*(author contributions?|acknowledg(e)?ments?|competing interests?|"
    r"conflicts? of interest|data availability|code availability|additional information|"
    r"reprints? and permissions|publisher'?s note|extended data|supplementary information|"
    r"作者贡献|致谢|利益冲突|数据可用性|补充材料|作者简介)"
)
# 附录/补充材料标题：出现在参考文献之后再出现时表示**正文恢复**。
# 附录常带公式、算法、证明，属于需要翻译的正文，绝不能当参考文献跳过。
_APPENDIX_HEADING_RE = re.compile(
    r"^(?:\s*[A-Z]\s*[.．]?\s*)?(?i:appendix|appendices)\b"
    r"|^\s*(?i:supplementary\s+(?:materials?|methods?|notes?|text|information|"
    r"figures?|tables?)|supporting\s+(?:materials?|information))\b"
    r"|^\s*(?:附\s*录|补\s*充\s*材\s*料|補充材料|补充说明|补充信息|附\s*件)"
)


def _is_appendix_heading(raw: str) -> bool:
    """一行文本是否是附录/补充材料标题（而不是正文里提到 appendix 的句子）。"""
    s = (raw or "").strip()
    if not s or len(s) > 80:
        return False
    if not _APPENDIX_HEADING_RE.match(s):
        return False
    # 「Appendix A shows ...」「附录中给出了……」这类正文句子：较长且带句末标点
    if len(s) > 24 and re.search(r"[.。!?！？]\s*$", s):
        return False
    return True


def _looks_like_reference_page(lines_or_text=None) -> bool:
    """参考文献页启发式：编号条目 + 年份 + 期刊/会议名密度（跨页续排常无标题）。"""
    if isinstance(lines_or_text, str):
        lines = lines_or_text.splitlines()
    else:
        lines = [ln for ln in (lines_or_text or []) if isinstance(ln, str)]
    txt = "\n".join(lines)
    if not txt.strip():
        return False
    num = sum(1 for ln in lines if _NUM_REF_RE.match(ln) or _REF_ITEM_RE.match(ln))
    years = len(re.findall(r"\b(?:19|20)\d{2}\b", txt))
    venues = len(
        re.findall(
            r"(?:Nat\.|Nature|Science|IEEE|ACM|arXiv|Proceedings|Journal|Conf\.)",
            txt,
        )
    )
    if num >= 4 and years >= 2 and venues >= 1:
        return True
    # 纯 arXiv / DOI 列表：条目多、年份多，但没有期刊名
    return num >= 6 and years >= 3


def _first_page_is_front_matter(lines: list[str]) -> bool:
    """首页只有标题/摘要（摘要之后还没有正文章节）→ front_matter，供 UI 区分。"""
    abs_i = -1
    for i, ln in enumerate(lines):
        if _ABSTRACT_RE.match(ln):
            abs_i = i
            break
    if abs_i < 0:
        return False
    # 「1. Introduction」这类带点号的章节编号不在 _SECTION_START_RE 里（它只认 1.2），
    # 这里单独补一条，避免首页摘要之后已经有正文却仍被标成 front_matter。
    return not any(
        _SECTION_START_RE.match(ln)
        or re.match(r"^\s*\d{1,2}\s*[.．]\s*[A-Z\u4e00-\u9fff]", ln)
        for ln in lines[abs_i + 1:]
    )


def _page_roles_from_texts(page_texts) -> list[str]:
    """按页判定角色：body / references / appendix（首页可为 front_matter）。

    规则（页序推进，参考文献可跨页续排；纯函数，便于单测）：
    - 页内出现附录/补充材料标题 → 本页起 appendix（附录是正文，必须翻译）；
    - 页内出现 References/Bibliography 标题 → 本页起 references；
    - references 状态遇到附录/后置事项标题、或遇到明显是正文的页 → 回到 body；
      只有「编号条目 + 年份 + 期刊名」的续排页仍判 references（没有标题也不会漏）。
    - appendix 状态一直延续到文末（附录之后通常还有补充材料，都属于正文）。
    """
    roles: list[str] = []
    mode = "body"
    for pno, text in enumerate(page_texts or []):
        lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
        ref_i = app_i = back_i = -1
        for i, ln in enumerate(lines):
            if _is_appendix_heading(ln):
                app_i = i
            if _REF_HEADING_RE.match(ln):
                ref_i = i
            elif _BACK_MATTER_RE.match(ln):
                back_i = i
        if app_i >= 0 and app_i >= ref_i:
            mode, role = "appendix", "appendix"
        elif ref_i >= 0:
            mode, role = "references", "references"
        elif mode == "references":
            if back_i >= 0:
                mode, role = "body", "body"
            elif _looks_like_reference_page(lines):
                role = "references"
            elif sum(len(ln) for ln in lines) >= 240:
                # 参考文献之后的续排页也可能是正文；文字不少且不像条目列表 → 正文
                mode, role = "body", "body"
            else:
                role = "references"
        elif mode == "appendix":
            role = "appendix"
        else:
            role = "body"
        if pno == 0 and role == "body" and _first_page_is_front_matter(lines):
            role = "front_matter"
        roles.append(role)
    return roles


def _page_verdict(
    role: str,
    expected: int,
    written: int,
    stuck: bool,
    threshold: float,
    heavy: bool = False,
    ref_like_stuck: bool = False,
) -> dict:
    """单页验收结论（纯函数，便于单测）。

    role 只影响「失败」的归类，不改变正文写回：
    - references：整页保留原文，标注 skipped，不算正文失败；
    - appendix：正常按比例验收（附录是正文）；只有「已写够比例但公式/证明等区域
      仍覆盖原文」的 stuck 才放过，写入比例不足仍算失败（那是真的没翻译）；
    - body：原逻辑，比例不足或原文未覆盖即失败。
    """
    exp = int(expected or 0)
    wrt = int(written or 0)
    rate = round(wrt / exp, 4) if exp else 1.0
    out = {"expected": exp, "written": wrt, "ratio": rate, "role": role}
    if heavy:
        return {**out, "ok": True, "status": "skipped", "reason": "图形对象过多，整页保留原文"}
    if role == "references" or ref_like_stuck:
        return {**out, "ok": True, "status": "skipped", "reason": "参考文献页保留原文"}
    if role == "appendix" and stuck and exp and rate >= threshold:
        return {
            **out,
            "ok": True,
            "status": "skipped",
            "reason": "附录页：公式/证明等区域保留原文（正文已译，不计失败）",
        }
    ok = bool(exp) and rate >= threshold and not stuck
    why = ""
    if not exp:
        why = "该页没有可验收的正文块"
    elif rate < threshold:
        why = f"正文写入不足（{wrt}/{exp}）"
    if stuck:
        why = ("原文未被覆盖；" + why) if why else "原文未被覆盖"
    return {**out, "ok": ok, "status": "ok" if ok else "fail", "reason": why}

# ---- 结构化文本对象：角色判定（DOI / URL / 作者 / 栏目 / 标题）----
_DOI_RE = re.compile(r"(?i)^\s*(https?://(dx\.)?doi\.org/|doi\s*:\s*)?10\.\d{4,9}/\S+\s*$")
_URL_RE = re.compile(r"(?i)^\s*https?://\S+\s*$")
_ORCID_RE = re.compile(r"(?i)\borcid\b|https?://orcid\.org/")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_ARTICLE_TYPE_RE = re.compile(
    r"(?i)^\s*(article|research article|review|letter|brief communication|editorial|"
    r"comment|correspondence|news|perspective|analysis|resource)\s*$"
)

# 默认原样保留的角色（不翻译、不擦除、不重绘）
PRESERVE_ROLES = {
    "doi",
    "url",
    "authors",
    "affiliation",
    "article-type",
    "header",
    "footer",
    "figure",
    "table",
    "formula",
    "reference",
    "code",
}


def _line_dom_style(line: dict) -> tuple:
    """一行文本的主导样式（按字符数投票）：(字体家族, 字号, 字色)。"""
    cnt: dict[tuple, int] = {}
    for s in line.get("spans", []):
        key = (
            s.get("family") or "",
            round(float(s.get("size") or 0.0) * 2) / 2,
            int(s.get("color") or 0),
        )
        cnt[key] = cnt.get(key, 0) + len(s.get("text") or "")
    return max(cnt, key=cnt.get) if cnt else ("", 0.0, 0)


def _group_lines_by_style(lines: list[dict]) -> list[list[dict]]:
    """把同一个 PDF 文本块里的行按**样式突变**切成段。

    只按 字号 / 字色 / 字体家族 切：DOI、栏目名、标题因此各自成段；
    粗体、斜体、链接等**段内**样式仍留在 span 里，不会把一段话拆碎。
    """
    groups: list[list[dict]] = []
    cur: list[dict] = []
    cur_key: tuple | None = None
    for ln in lines:
        key = _line_dom_style(ln)
        if cur_key is None:
            cur, cur_key = [ln], key
            continue
        same = (
            key[0] == cur_key[0]
            and abs(float(key[1]) - float(cur_key[1])) <= 0.8
            and int(key[2]) == int(cur_key[2])
        )
        if same:
            cur.append(ln)
        else:
            groups.append(cur)
            cur, cur_key = [ln], key
    if cur:
        groups.append(cur)
    return groups


# 公式行里允许出现的英文函数/算子名；除此之外的两个以上英文单词视为正文。
_FORMULA_WORDS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
    "log", "ln", "exp", "max", "min", "arg", "softmax", "sigmoid", "relu",
    "det", "rank", "diag", "trace", "lim", "sup", "inf", "mod", "gcd", "lcm",
    "st", "s.t", "iff", "for", "all", "and", "or", "not", "in", "of", "to",
}
_MATH_FONT_RE = re.compile(
    r"(?:math|symbol|cmsy|cmmi|cmex|stix|mathjax|cambria\s*math|lmroman\s*math)",
    re.I,
)


def _formula_text_only(t: str) -> bool:
    """整行是否只像公式，而不是「正文里夹一个等号」。

    这是行级判断，用于把「公式行 + 正文行」从同一个 PyMuPDF 块里拆开；
    块级不要再拿整段文本做一刀切。
    """
    s = (t or "").strip()
    if not s or len(s) > 160 or "\n" in s:
        return False
    if re.search(r"[。！？!?；;]", s):
        return False
    if _CAP_RE.match(s):
        return False
    if not _looks_formula(s):
        return False
    words = re.findall(r"[A-Za-z]{2,}", s)
    prose = [w for w in words if w.lower() not in _FORMULA_WORDS]
    # 两个以上普通英文词，基本就是句子；一个普通词也可能是 "where/thus"。
    if len(prose) >= 2:
        return False
    if len(prose) == 1 and prose[0].lower() in {
        "where", "thus", "then", "this", "that", "with", "from", "into",
        "using", "when", "while", "each", "such", "have", "has", "are", "is",
        "we", "the", "and", "for", "our", "can", "may", "will",
    }:
        return False
    return True


def _text_has_prose(t: str) -> bool:
    """块里是否有成句正文（用于避免“公式占比高”误伤整段正文）。

    行内公式在翻译前已经替换成 ``⟦n⟧`` 占位符，正文块可以照常翻译；
    只有“几乎全是符号/公式、没有句子”的块才整块保留。
    """
    s = (t or "").strip()
    if not s:
        return False
    words = re.findall(r"[A-Za-z]{2,}", s)
    prose = [w for w in words if w.lower() not in _FORMULA_WORDS]
    if len(prose) >= 3:
        return True
    return len(re.findall(r"[\u4e00-\u9fff]", s)) >= 12


def _line_is_formula_only(line: dict) -> bool:
    """一行文字是否应作为独立公式岛保留（不翻译、不擦除）。"""
    text = "".join(str(s.get("text") or "") for s in (line.get("spans") or [])).strip()
    if not _formula_text_only(text):
        return False
    total = max(1, len(text))
    math_chars = 0
    for sp in line.get("spans") or []:
        if _MATH_FONT_RE.search(str(sp.get("font") or "")):
            math_chars += len(str(sp.get("text") or ""))
    # 数学字体行，或含明确的公式关系符/数学符号
    return math_chars / total >= 0.45 or bool(
        re.search(r"[=∑∫√±×÷≈≠≤≥∞∂∇∈∉⊂⊃∪∩→←↔^_{}\\]", text)
    ) or "=" in text


def _split_formula_lines(lines: list[dict]) -> list[tuple[bool, list[dict]]]:
    """把同一样式组按「公式行 / 正文行」切成连续片段。

    PyMuPDF 经常把独立公式和上下正文放进同一个 block；先在这里拆开，
    后面才能只保护公式、翻译正文。
    """
    runs: list[tuple[bool, list[dict]]] = []
    cur: list[dict] = []
    cur_formula: bool | None = None
    for ln in lines:
        is_formula = _line_is_formula_only(ln)
        if cur_formula is None:
            cur, cur_formula = [ln], is_formula
            continue
        if is_formula == cur_formula:
            cur.append(ln)
        else:
            runs.append((cur_formula, cur))
            cur, cur_formula = [ln], is_formula
    if cur:
        runs.append((bool(cur_formula), cur))
    return runs


def _role_hint(
    text: str,
    size: float,
    body_size: float,
    pno: int,
    rect,
    page_h: float,
    page_max_size: float,
) -> str:
    """区域 + 位置 + 内容 + 样式综合判定角色（不只看字号或颜色）。"""
    t = (text or "").strip()
    if not t:
        return ""
    if _DOI_RE.match(t):
        return "doi"
    if _URL_RE.match(t):
        return "url"
    if _ORCID_RE.search(t) or (_EMAIL_RE.search(t) and len(t) <= 200):
        return "affiliation"
    if _ARTICLE_TYPE_RE.match(t) and size <= max(body_size, 1.0) * 1.4:
        return "article-type"
    if pno == 0:
        words = t.split()
        caps = sum(1 for w in words if w[:1].isupper())
        # 作者行：多个大写开头的姓名 + 上标数字 / "&" / 多逗号，且不是句子
        if (
            3 <= len(words) <= 40
            and caps >= 3
            and ("&" in t or bool(re.search(r"\d", t)) or t.count(",") >= 2)
            and not re.search(r"[.。!?！？]\s*$", t)
            # 单页重译的临时 PDF 里这一页也是 pno=0；编号段落/带冒号的解释文
            # 不能按首页作者行处理。
            and not re.match(r"^\s*\d+(?:\.\d+)*[.)]?\s+\S", t)
            and ":" not in t
            and "：" not in t
        ):
            return "authors"
        # 标题：首页、接近本页最大字号、位于页面上半部、不是题注
        if (
            page_max_size > 0
            and size >= page_max_size * 0.85
            and rect is not None
            and rect.y0 < page_h * 0.5
            and not _CAPTION_RE.match(t)
            and len(t) <= 300
        ):
            return "title"
    return ""
# 行内引用：[12] / [12, 15] / [12-15]（用于自检「译文是否改动/丢失引用」）
_CITE_RE = re.compile(r"\[\s*\d+(?:\s*[-,–]\s*\d+)*\s*\]")


def _cite_count(s: str) -> int:
    return len(_CITE_RE.findall(s or ""))


# 图标字体/符号字符（私用区、装饰符号、箭头、emoji 等）。这些通常不是自然语言，
# 翻译会把图标「改坏」，应保持原样。
_ICON_CHAR_RE = re.compile(
    r"[\u2000-\u2bff\u3000-\u303f\ue000-\uf8ff\U0001f000-\U0001faff\u2190-\u21ff\u2600-\u27bf]"
)


def _looks_like_icon(raw: str) -> bool:
    """看起来像「图标/符号」而非自然语言文本：短、无字母数字/汉字、含符号或私用区字符。"""
    s = (raw or "").strip()
    if not s or len(s) > 24:
        return False
    if re.search(r"[A-Za-z0-9\u4e00-\u9fff\u3040-\u30ff\u0400-\u04ff\u0370-\u03ff]", s):
        return False
    return bool(_ICON_CHAR_RE.search(s))


# 抽不出正确字符的公式片段（替换字符 / 私用区 / 数学字母数字）
_GARBLED_RE = re.compile(r"[\ufffd\ue000-\uf8ff\U0001D400-\U0001D7FF]")


def _label_like_text(raw: str) -> bool:
    """像「标签」而不是句子：没有句末标点、词数少、没有长串正文。"""
    s = (raw or "").strip()
    if not s:
        return False
    if any(ch in s for ch in ".。!?！？；;"):
        return False
    return len(s.split()) <= 12


def _classify_block(
    f: dict, body_size: float, body_font: str = "", page_font: str = ""
) -> str:
    """把一个文本块分类为 margin/formula/reference/caption/heading/body（对应技能）。"""
    # 行级拆分出的独立公式岛：保留原文，不擦除（行内公式仍留在正文块里）
    if f.get("formulaOnly"):
        return "formula"
    # 位于矢量图形内部（如坐标轴标签、流程图文字）：保持原样，不翻译
    if f.get("fig_internal") or f.get("algo"):
        return "figure"
    # 元信息角色：DOI/URL/作者/单位/栏目 —— 原样保留（不翻译、不擦除）
    _hint = f.get("roleHint") or ""
    if _hint in ("doi", "url", "authors", "affiliation", "article-type"):
        return _hint
    raw = (f.get("raw") or "").strip()
    # **小字号 + 短标签**基本都是图内文字（坐标轴/流程框/图例/表格单元）。
    # 这些一旦翻译就会压在原图上 → 视觉重叠（Fig. 1 整页都是这个毛病）。
    # 判定不依赖「是否被矢量区域覆盖」（流程图内部常常检测不到区域）：
    #   - 字号明显小于正文；
    #   - 不像句子（没有句末标点、词数少）；
    #   - 不是图/表题注（题注要翻译）。
    # 图标/符号文本（图标字体、装饰符）：保持原样，避免把图标「翻译」坏
    # 纯编号/角标（8. / 12 / iv.）：原样保留。它们常被切成 1pt 高的独立块，
    # 送去翻译只会得到一个放不下的长串（进而回填原文/空白）。
    if (
        len(raw) <= 6
        and re.fullmatch(r"[\dIVXivx]+[.)、]?", raw)
        and f.get("rect") is not None
        and (
            float(f["rect"].width) <= 40.0 or float(f["rect"].height) <= 4.0
        )
        # 页边里的页码交给 margin 规则处理
        and float(f.get("ph") or 0) > 0
        and float(f["rect"].y0) > float(f["ph"]) * 0.06
        and float(f["rect"].y1) < float(f["ph"]) * 0.94
    ):
        return "figure"
    # 参考文献区：**整段**保留（编号条目 + 续行）。旧规则只认带编号的行，
    # 段落切分后续行丢了编号 → 被当正文翻译并压到未擦除的英文上。
    if f.get("refsec") and (f.get("roleHint") or "") != "heading" and not _CAP_RE.match(raw):
        return "reference"
    # 明显小于正文的整行/两行文字（6pt 参考文献、脚注、补充材料）：
    # 译成中文后必然放不进 6pt 的槽位，保留原文，避免回填失败导致空白。
    if (
        body_size
        and (f.get("size") or 0) > 0
        and float(f.get("size")) < min(7.5, body_size * 0.78)
        and int(f.get("nlines") or 1) <= 2
        and len(raw) >= 40
        and not f.get("cap")
    ):
        return "figure"
    if _looks_like_icon(raw):
        return "figure"
    # 首页署名列表（Nature 等常见多行作者）：逗号分隔、无句末标点。
    # 按 body 翻译会把人名和单位编号一起翻掉，也破坏版式。
    if (
        int(f.get("pno") or 0) == 0
        and int(f.get("nlines") or 1) >= 2
        and raw.count(",") >= 3
        and not re.search(r"[.!?。！？]", raw)
        # 编号段落（"1. Adaptive Weights Update: ..."）不是作者行；
        # 冒号也通常意味着解释性正文而非纯姓名列表。
        and not re.match(r"^\s*\d+(?:\.\d+)*[.)]?\s+\S", raw)
        and ":" not in raw
        and "：" not in raw
        and len(raw) <= 900
    ):
        return "authors"
    ph = f.get("ph") or 0
    r = f.get("rect")
    # 页眉 / 页脚 / 页码：位于上下页边区域、较短，且字号不大于正文（排除大标题）
    if (
        ph
        and r is not None
        and f.get("nlines", 1) <= 2
        and len(raw) <= 90
        and (f.get("size") or 0) <= (body_size or 12.0) * 1.3
    ):
        if r.y0 < ph * 0.06 or r.y1 > ph * 0.94:
            # **正文校验**：页边区域里也会出现正文（如页面第一行）。
            # 句子特征（够长 / 词够多 / 以句末标点结尾）+ 字号接近正文 + 不在极端页边
            # → 判为正文，避免「正文被当成页眉页脚而漏译」。
            sentence_like = (
                len(raw) >= 60
                or len(raw.split()) >= 8
                or bool(re.search(r"[.。!?！？][\"'”’)]?\s*$", raw))
            )
            body_size_ok = (f.get("size") or 0) >= (body_size or 12.0) * 0.9
            extreme_margin = r.y1 < ph * 0.03 or r.y0 > ph * 0.97
            if sentence_like and body_size_ok and not extreme_margin:
                return "body"
            return "margin"
    if _PAGE_NUM_RE.match(raw) or _ROMAN_RE.match(raw):
        return "margin"
    # 只有「整段都像公式」才保护；正文里夹一个等号不能把整段跳过
    if f.get("nlines", 1) <= 4 and _formula_text_only(raw.replace("\n", " ")):
        return "formula"
    # 公式/乱码占比高、但**没有成句正文**的块：整块保持原样（公式的视觉与语义都不能丢）。
    # 行内公式已经在翻译前替换成 ⟦n⟧，正文段即使符号占比高也应翻译；
    # 只有“几乎全是公式”的块才保护，否则会把整段解释性正文误判成公式。
    if (f.get("math_ratio") or 0.0) >= 0.12:
        return "body" if _text_has_prose(raw) else "formula"
    # 整页都使用该字体、且这一块是**成句/较长**的正文（如末页出版声明）→ 不当作图内文字。
    # 只对「短标签」保留图内保护，否则会把整页换字体的正文全部漏译。
    _page_font_body = bool(
        page_font
        and (f.get("font") or "") == page_font
        and not f.get("in_fig_loose")
        and (not _label_like_text(raw) or len(raw) >= 45)
    )
    # **字体家族**与正文不同 = 图/表内容（坐标轴、图例、表头…）。
    # 比字号可靠：很多论文的图例就是正文大小（这篇：正文 HardingText、图内 GraphikNaturel）。
    if (
        not f.get("cap")
        and body_font
        and (f.get("font") or "")
        and f.get("font") != body_font
        and not _page_font_body
        # 短标签（图例/面板编号）可以比正文大一些；长文本仍按正文字号上限判断
        and (
            (f.get("size") or 0) <= (body_size or 12.0) * 1.05
            or (len(raw) <= 60 and (f.get("size") or 0) <= (body_size or 12.0) * 1.4)
        )
        and len(raw) <= 240
    ):
        return "figure"
    # 小字号 + 短标签 = 图内文字（坐标轴/流程框/图例/表格单元）。
    # 这些一旦翻译就会压在原图上 → 视觉重叠（Fig. 1 整页都是这个毛病）。
    # 必须放在**公式判定之后**：公式块往往也是「短、无标点、字号偏小」。
    if (
        not f.get("cap")
        and len(raw) <= 140
        and (f.get("nlines") or 1) <= 4
        and _label_like_text(raw)
        and (
            (f.get("size") or 0) < (body_size or 12.0) * 0.92
            or f.get("in_fig_loose")
        )
    ):
        return "figure"
    # 参考文献：带 [n] 的条目；或（已进入参考文献段时）形如 “1. 作者 … 年份” 的条目
    if _REF_ITEM_RE.match(raw):
        return "reference"
    if f.get("refsec") and _NUM_REF_RE.match(raw) and re.search(r"(19|20)\d{2}", raw):
        return "reference"
    if len(raw) < 400 and _CAPTION_RE.match(raw):
        return "caption"
    if f.get("abhead") or f.get("absec"):
        return "abstract"
    if body_size and (f.get("size") or 0) >= body_size * 1.2:
        return "heading"
    return "body"


# 整块呈现的数学定界符（LaTeX）：$$...$$ / \(...\) / \[...\] / 独占一行的 $...$
_DISPLAY_MATH_RE = re.compile(
    r"^\s*(\$\$.+?\$\$|\\\(.+?\\\)|\\\[.+?\\\]|\$[^$\n]+\$)\s*$", re.S
)


def _looks_formula(t: str) -> bool:
    s = t.strip()
    if not s or len(s) > 120 or s.count("\n") > 2:
        return False
    # 源码直接给出 LaTeX：整块都是公式（含 $...$ 定界），按公式处理
    if _DISPLAY_MATH_RE.match(s):
        return True
    if any(ch in _FORMULA_HINT for ch in s):
        return True
    return len(s) < 48 and "=" in s and re.fullmatch(r"[\sA-Za-z0-9_^{}\[\]().,|+\-*/=<>&\\]+", s) is not None


def _esc(s: str) -> str:
    import html as _h

    return _h.escape(s or "")


_MATH_SYM: dict[str, str] = {
    "\\sum": "∑", "\\prod": "∏", "\\int": "∫", "\\oint": "∮", "\\sqrt": "√",
    "\\pm": "±", "\\mp": "∓", "\\times": "×", "\\cdot": "·", "\\leq": "≤", "\\le": "≤",
    "\\geq": "≥", "\\ge": "≥", "\\neq": "≠", "\\ne": "≠", "\\approx": "≈",
    "\\infty": "∞", "\\partial": "∂", "\\nabla": "∇", "\\rightarrow": "→", "\\to": "→",
    "\\leftarrow": "←", "\\in": "∈", "\\forall": "∀", "\\exists": "∃",
    "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ", "\\epsilon": "ε",
    "\\theta": "θ", "\\lambda": "λ", "\\mu": "μ", "\\nu": "ν", "\\pi": "π", "\\rho": "ρ",
    "\\sigma": "σ", "\\tau": "τ", "\\phi": "φ", "\\psi": "ψ", "\\omega": "ω",
    "\\Delta": "Δ", "\\Theta": "Θ", "\\Lambda": "Λ", "\\Sigma": "Σ", "\\Omega": "Ω",
}


def _latex_to_html(tex: str) -> str:
    """把（已 HTML 转义的）LaTeX 片段渲染成带上下标的 HTML（无外部依赖）。"""
    s = tex
    s = re.sub(r"\\frac\{([^{}]*)\}\{([^{}]*)\}", r"(\1)/(\2)", s)
    for k, v in _MATH_SYM.items():
        s = v.join(s.split(k))
    s = re.sub(r"\\[a-zA-Z]+", "", s)
    s = s.replace("{", "").replace("}", "")
    s = re.sub(r"_(\w+|\d)", r"<sub>\1</sub>", s)
    s = re.sub(r"\^(\w+|\d)", r"<sup>\1</sup>", s)
    return s


def _mathify(escaped_text: str) -> str:
    """把已转义文本里的 $...$ 渲染成 HTML 数学片段（对照页沿用，行为保持不变）。"""
    return re.sub(r"\$([^$\n]+)\$", lambda m: f'<span class="math">{_latex_to_html(m.group(1))}</span>', escaped_text)


# 阅读区行内数学：$...$ / $$...$$ / \(...\)（在已 HTML 转义的文本上匹配）
_INLINE_MATH_RE = re.compile(r"\$\$([^$\n]+?)\$\$|\$([^$\n]+?)\$|\\\(([^\n]+?)\\\)")


def _mathify_inline(escaped_text: str) -> str:
    """阅读区专用：把 $...$ / $$...$$ / \\(...\\) 渲染成 HTML 数学片段。

    仅做「展示层」替换：正文其余字符原样保留；匹配失败则不改动，避免破坏文本。
    """

    def _repl(m: "re.Match[str]") -> str:
        tex = m.group(1) or m.group(2) or m.group(3) or ""
        return f'<span class="math">{_latex_to_html(tex)}</span>'

    return _INLINE_MATH_RE.sub(_repl, escaped_text)


def _clean_para(t: str) -> str:
    """把块内多行合并成一段（去连字符换行、合并空白）。"""
    s = re.sub(r"-\n", "", t)  # 断词连字符
    s = re.sub(r"\s*\n\s*", " ", s)
    return re.sub(r"\s{2,}", " ", s).strip()


# 明确的 URL / DOI 形态（只匹配这些，**不猜测**）
_URL_RE = re.compile(
    r"(https?://[^\s<>'\"]+|www\.[^\s<>'\"]+|doi:\s*10\.\d{4,9}/[^\s<>'\"]+|10\.\d{4,9}/[^\s<>'\"]+)",
    re.IGNORECASE,
)


def _linkify_html(escaped: str) -> str:
    """把**已转义**文本里的 URL / DOI 变成可点击链接。

    只匹配明确的 URL 形态（http(s)://、www.、doi:10.x、裸 DOI），不做模糊猜测；
    保留 URL 末尾的标点（句号/逗号/括号）在链接之外。
    """
    def _repl(m: "re.Match[str]") -> str:
        raw = m.group(0)
        trail = ""
        while raw and raw[-1] in ".,;:)]}、。，；：）":
            trail = raw[-1] + trail
            raw = raw[:-1]
        if not raw:
            return m.group(0)
        low = raw.lower()
        if low.startswith("doi:"):
            href = "https://doi.org/" + raw[4:].strip()
        elif re.match(r"^10\.\d{4,9}/", raw):
            href = "https://doi.org/" + raw
        elif low.startswith("www."):
            href = "http://" + raw
        else:
            href = raw
        return (
            f'<a href="{href}" target="_blank" rel="noreferrer noopener" '
            f'class="ext-link">{raw}</a>{trail}'
        )

    return _URL_RE.sub(_repl, escaped)


def _link_for_rect(rect: "fitz.Rect", page_links: list) -> str | None:
    """返回与该文本块重叠面积最大的链接注解 URI（无则 None）。"""
    best: str | None = None
    best_area = 0.0
    for lr, uri in page_links:
        try:
            inter = lr & rect
        except Exception:  # noqa: BLE001
            continue
        if inter.is_empty:
            continue
        area = float(inter.get_area())
        if area > best_area:
            best_area = area
            best = uri
    return best


def _wrap_link(inner_html: str, href: str | None) -> str:
    """把一段 HTML 文本整体包成外链（用于 PDF 链接注解的锚文本，如「GitHub」）。"""
    if not href:
        return inner_html
    return (
        f'<a href="{_esc(href)}" target="_blank" rel="noreferrer noopener" '
        f'class="ext-link">{inner_html}</a>'
    )


def _render_figure_b64(
    page: "fitz.Page", rect: "fitz.Rect", max_w: float = 1200.0, base_scale: float = 1.2
) -> tuple[str | None, str | None]:
    """把页面上的一块区域渲染成 base64 内联图片（供 srcDoc 使用）。

    返回 (base64 字符串, MIME)，失败返回 (None, None)。优先 JPEG，其次 PNG。
    渲染宽度上限 max_w 像素，避免 HTML 体积爆炸。
    """
    try:
        w = float(rect.width)
        scale = base_scale if w <= 0 else min(base_scale, max_w / w)
        if scale <= 0:
            scale = base_scale
        pix = page.get_pixmap(clip=rect, matrix=fitz.Matrix(scale, scale), alpha=False)
        try:
            data = pix.tobytes("jpeg")
            return base64.b64encode(data).decode("ascii"), "image/jpeg"
        except Exception:  # noqa: BLE001
            data = pix.tobytes("png")
            return base64.b64encode(data).decode("ascii"), "image/png"
    except Exception:  # noqa: BLE001
        return None, None


def _write_translation_html(
    out: str,
    flat: list[dict],
    translated: list[str],
    figs: list[dict] | None = None,
    kinds: list[str] | None = None,
) -> None:
    """由译文直接生成结构化 HTML（按字号推断标题层级），比从 PDF 反解更整齐。

    **只放文本**：不内联任何图片/图标，也不包含「图形内部文字」与跳过类型
    （页眉/公式/参考文献/图形）的块，避免网页排版杂乱。
    每个文本块带 data-pid / data-page 锚点，页级带 id='pg-N'，供渲染器按页/段定位。
    """
    figs = figs or []
    sizes = [f["size"] for f in flat if f.get("size")]
    body = float(Counter(round(s) for s in sizes).most_common(1)[0][0]) if sizes else 12.0

    def _fmt(text: str, link: str | None) -> str:
        """转义 → 链接化（URL/DOI）→ 数学片段 → 若该块有链接注解则整体包成外链。"""
        return _wrap_link(_mathify_inline(_linkify_html(_esc(_clean_para(text)))), link)

    parts = [
        "<!doctype html><html lang='zh'><head><meta charset='utf-8'/>"
        '<meta name="viewport" content="width=device-width, initial-scale=1"/>'
        f"<title>译文</title><style>{_TR_CSS}</style></head><body>"
    ]

    # 按页组织：只放文本块（图形内部文字与跳过类型都不进网页）
    text_by_page: dict[int, list[int]] = {}
    for i, f in enumerate(flat):
        if kinds and kinds[i] == "figure":
            continue
        if f.get("mod_skip"):
            continue
        if f.get("fig_internal"):
            continue
        text_by_page.setdefault(f["pno"], []).append(i)

    for pno in sorted(text_by_page):
        entries: list[tuple[float, float, str, int]] = []
        for i in text_by_page.get(pno, []):
            r = flat[i]["rect"]
            entries.append((r.y0, r.x0, "t", i))
        entries.sort(key=lambda e: (round(e[0], 1), round(e[1], 1)))

        parts.append(
            f"<section class='pg' data-page='{pno + 1}' id='pg-{pno + 1}'>"
            f"<div class='pgno'>第 {pno + 1} 页</div>"
        )
        for _, _, _typ, k in entries:
            page_attr = f"data-page='{pno + 1}'"
            i = k
            f = flat[i]
            text = (translated[i] or f["raw"]).strip()
            if not text:
                continue
            s = f.get("size") or body
            # 公式优先：保留数学结构（$...$/$$...$$/\(...\) 渲染为 .math，其余逐字保留）
            if len(text) < 120 and _looks_formula(text):
                inner = _mathify_inline(_esc(text))
                tex = _esc(text).replace("'", "&#39;")
                parts.append(
                    f"<div class='formula' {page_attr} data-pid='{i}' data-tex='{tex}'>"
                    f"{inner}</div>"
                )
                continue
            # 图/表题注：专属 .caption 样式，不套用正文段落样式
            if f.get("cap"):
                parts.append(
                    f"<p class='caption' {page_attr} data-pid='{i}'>"
                    f"{_fmt(text, f.get('link'))}</p>"
                )
                continue
            attrs = f"class='para' {page_attr} data-pid='{i}'"
            if body and s >= body * 1.45 and len(text) < 160:
                parts.append(f"<h1 {attrs}>{_fmt(text, f.get('link'))}</h1>")
            elif body and s >= body * 1.2 and len(text) < 160:
                parts.append(f"<h2 {attrs}>{_fmt(text, f.get('link'))}</h2>")
            elif body and s >= body * 1.08 and len(text) < 160:
                parts.append(f"<h3 {attrs}>{_fmt(text, f.get('link'))}</h3>")
            else:
                parts.append(f"<p {attrs}>{_fmt(text, f.get('link'))}</p>")
        parts.append("</section>")

    parts.append("</body></html>")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))


_BI_CSS = """
:root { color-scheme: light dark; }
body { max-width: 1080px; margin: 0 auto; padding: 0 22px 64px; line-height: 1.85;
       font-family: -apple-system, 'Segoe UI', 'Noto Sans SC', sans-serif; color: #1c1f23; background: #fff; }
.sw { position: sticky; top: 0; background: #fff; padding: 10px 0; display: flex; gap: 6px;
      justify-content: center; border-bottom: 1px solid #ececec; margin-bottom: 16px; z-index: 5; }
.sw label { cursor: pointer; font-size: 12.5px; padding: 3px 14px; border: 1px solid #e2e2e2;
            border-radius: 999px; color: #333; }
input[name=m] { display: none; }
body:has(#m-src:checked) label[for=m-src],
body:has(#m-both:checked) label[for=m-both],
body:has(#m-dst:checked) label[for=m-dst] { background: #4a6cf7; color: #fff; border-color: #4a6cf7; }
.pg { margin-bottom: 28px; }
.pg + .pg { border-top: 1px solid #ececec; padding-top: 22px; }
.pgno { font-size: 11px; color: #9aa0a6; margin-bottom: 10px; letter-spacing: .5px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: .7em 0;
        padding-left: 10px; border-left: 3px solid #e6e8ec; }
.pair .src { color: #6b7280; font-size: 14px; }
.pair .dst { color: #111; font-size: 16.5px; }
.pair.head .dst { font-weight: 700; }
body:has(#m-src:checked) .dst, body:has(#m-dst:checked) .src { display: none; }
body:has(#m-src:checked) .pair, body:has(#m-dst:checked) .pair { grid-template-columns: 1fr; }
.math { font-family: 'Cambria Math', 'Latin Modern Math', 'STIX Two Math', Georgia, serif; }
.math sub, .math sup { font-size: .72em; }
mark.hit-mark { background: rgba(255, 214, 74, 0.32); color: inherit; border-radius: 3px; padding: 0 2px; }
@media (max-width: 1000px) { .pair { grid-template-columns: 1fr; gap: 4px; } }
"""


def _merge_paragraphs(flat: list[dict], translated: list[str], body_size: float) -> list[dict]:
    """把「同页、同栏、正文尺寸、块间距很小」的相邻块合并成一段（对照页读起来更顺）。"""
    merged: list[dict] = []
    for i, f in enumerate(flat):
        size = f.get("size") or body_size
        is_body = bool(body_size) and size <= body_size * 1.15
        dst = translated[i] or f["raw"]
        if f.get("mod_skip"):
            continue
        if merged and is_body and merged[-1]["is_body"] and merged[-1]["pno"] == f["pno"]:
            prev = merged[-1]
            gap = f["rect"].y0 - prev["rect"].y1
            overlap = min(prev["rect"].x1, f["rect"].x1) - max(prev["rect"].x0, f["rect"].x0)
            wmin = min(prev["rect"].width, f["rect"].width) or 1.0
            if -1.0 <= gap <= max(6.0, body_size * 0.9) and overlap > 0.5 * wmin:
                prev["raw"] = prev["raw"] + " " + f["raw"]
                prev["dst"] = prev["dst"] + " " + dst
                prev["rect"] = fitz.Rect(
                    prev["rect"].x0, prev["rect"].y0, min(prev["rect"].x1, f["rect"].x1), f["rect"].y1
                )
                continue
        merged.append(
            {
                "pno": f["pno"],
                "raw": f["raw"],
                "dst": dst,
                "size": size,
                "is_body": is_body,
                "rect": f["rect"],
            }
        )
    return merged


def _write_bilingual_html(out: str, flat: list[dict], translated: list[str]) -> None:
    """中英对照 HTML：每个文本块一行「原文 | 译文」。"""
    sizes = [f["size"] for f in flat if f.get("size")]
    body = float(Counter(round(s) for s in sizes).most_common(1)[0][0]) if sizes else 12.0
    parts = [
        "<!doctype html><html lang='zh'><head><meta charset='utf-8'/>"
        '<meta name="viewport" content="width=device-width, initial-scale=1"/>'
        f"<title>中英对照</title><style>{_BI_CSS}</style></head><body>",
        '<input type="radio" name="m" id="m-src"><input type="radio" name="m" id="m-both" checked>'
        '<input type="radio" name="m" id="m-dst">',
        '<div class="sw"><label for="m-src">原文</label><label for="m-both">对照</label>'
        '<label for="m-dst">译文</label></div>',
    ]
    cur = None
    merged = _merge_paragraphs(flat, translated, body)
    for m in merged:
        if m["pno"] != cur:
            if cur is not None:
                parts.append("</section>")
            parts.append(f"<section class='pg'><div class='pgno'>第 {m['pno'] + 1} 页</div>")
            cur = m["pno"]
        src = _clean_para(m["raw"])
        dst = _clean_para(m["dst"])
        if not src and not dst:
            continue
        head = " head" if (body and (m.get("size") or 0) >= body * 1.2) else ""
        parts.append(
            f"<div class='pair{head}'><div class='src'>{_mathify(_esc(src))}</div>"
            f"<div class='dst'>{_mathify(_esc(dst))}</div></div>"
        )
    if cur is not None:
        parts.append("</section>")
    parts.append("</body></html>")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))


def _pd_marker(f: dict, line_from: int, line_to: int) -> str:
    """段落原始位置标记：页码 / 页内行号区间 / 覆盖矩形（底部原点，pt）。

    渲染端（`src/shared/text-reflow.ts`）用它在段落重建后仍然保留原始行号与
    页内坐标，供对照视图双向联动定位。坐标系与 `shared/modules.ts` 的 Rect4 一致。
    """
    ph = float(f.get("ph") or 0.0)
    box = None
    for r in f.get("lineRects") or []:
        try:
            x0, y0, x1, y1 = (float(v) for v in r)
        except (TypeError, ValueError):
            continue
        loc = [x0, ph - y1, x1, ph - y0] if ph > 0 else [x0, y0, x1, y1]
        box = loc if box is None else [
            min(box[0], loc[0]),
            min(box[1], loc[1]),
            max(box[2], loc[2]),
            max(box[3], loc[3]),
        ]
    if box is None:
        try:
            r = fitz.Rect(f.get("rect"))
            box = [r.x0, ph - r.y1, r.x1, ph - r.y0] if ph > 0 else [r.x0, r.y0, r.x1, r.y1]
        except Exception:  # noqa: BLE001
            box = [0.0, 0.0, 0.0, 0.0]
    return "<!--pd p=%d l=%d-%d r=%.1f,%.1f,%.1f,%.1f-->" % (
        int(f.get("pno") or 0) + 1,
        line_from,
        line_to,
        box[0],
        box[1],
        box[2],
        box[3],
    )


def _write_translation_md(out: str, flat: list[dict], translated: list[str]) -> None:
    """译文 Markdown（便于放入自己的笔记体系）。

    每个段落行尾带一个 `<!--pd p=页码 l=起始行-结束行 r=矩形-->` 位置标记：
    它是 HTML 注释，Markdown 渲染不可见，供结构化文本重建保留原始行号与页内坐标。
    """
    sizes = [f["size"] for f in flat if f.get("size")]
    body = float(Counter(round(s) for s in sizes).most_common(1)[0][0]) if sizes else 12.0
    lines: list[str] = []
    cur = None
    # 页内物理行号（1 基，按抽取顺序）：被跳过的块同样占行，保证行号不跳号
    line_no: dict[int, int] = {}
    for i, f in enumerate(flat):
        pno = int(f.get("pno") or 0)
        nlines = len(f.get("lines") or [])
        start = line_no.get(pno, 0) + 1
        end = start + max(0, nlines - 1)
        if nlines:
            line_no[pno] = end
        if f.get("mod_skip"):
            continue
        text = (translated[i] or f["raw"]).strip()
        if not text:
            continue
        if f["pno"] != cur:
            lines.append(f"<!-- 第 {f['pno'] + 1} 页 -->")
            cur = f["pno"]
        marker = _pd_marker(f, start, end)
        if len(text) < 120 and _looks_formula(text):
            lines.append("```math\n" + text + "\n```")
        elif body and (f.get("size") or 0) >= body * 1.45 and len(text) < 160:
            lines.append("# " + _clean_para(text) + " " + marker)
        elif body and (f.get("size") or 0) >= body * 1.2 and len(text) < 160:
            lines.append("## " + _clean_para(text) + " " + marker)
        elif body and (f.get("size") or 0) >= body * 1.08 and len(text) < 160:
            lines.append("### " + _clean_para(text) + " " + marker)
        else:
            lines.append(_clean_para(text) + " " + marker)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n\n".join(lines).strip() + "\n")


def _write_bilingual_md(out: str, flat: list[dict], translated: list[str]) -> None:
    """中英对照 Markdown：每段「> 原文」+ 译文。"""
    sizes = [f["size"] for f in flat if f.get("size")]
    body = float(Counter(round(s) for s in sizes).most_common(1)[0][0]) if sizes else 12.0
    lines: list[str] = ["# 中英对照", ""]
    cur = None
    for m in _merge_paragraphs(flat, translated, body):
        src = _clean_para(m["raw"])
        dst = _clean_para(m["dst"])
        if not src and not dst:
            continue
        if m["pno"] != cur:
            lines.append(f"<!-- 第 {m['pno'] + 1} 页 -->")
            cur = m["pno"]
        lines.append(f"> {src}")
        lines.append("")
        lines.append(dst)
        lines.append("")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


# 算法/伪代码行（"1:" / "12:" 开头）：保持逐行，不合并成段落。
# 注意：行文本在对象构建时会被 strip()，所以**不能**要求冒号后还有空白。
_ALGO_LINE_RE = re.compile(r"^\s*\d{1,2}\s*[:：]")

# 「抽坏的数学片段」：替换字符 / 私用区 / 数学字母数字（𝒫 𝒟 𝒯 …）/ 字体里没有的括号
_MATH_JUNK_RE = re.compile(
    r"[\ufffd\ue000-\uf8ff\U0001D400-\U0001D7FF\u2100-\u214F\u2308\u2309\u230a\u230b\u27e8\u27e9]+[?]?"
)
# 有 Unicode 码位、**类别可确定**的数学变体（花体/双线体/粗体/斜体…）
_MATH_VARIANTS_RE = re.compile(r"[\U0001D400-\U0001D7FF\u2100-\u214F]")
# 类别**无法确定**的字符（没有 ToUnicode / 私用区）
_MATH_LOST_RE = re.compile(r"[\ufffd\ue000-\uf8ff]")

# 能画出完整数学变体的字体（Cambria Math 覆盖整个数学字母数字区）
_MATH_FONT_CACHE: dict = {"checked": False, "path": ""}


def math_fontfile() -> str:
    if _MATH_FONT_CACHE["checked"]:
        return _MATH_FONT_CACHE["path"]
    _MATH_FONT_CACHE["checked"] = True
    cands = [
        "C:/Windows/Fonts/cambria.ttc",
        "C:/Windows/Fonts/CAMBRIA.TTC",
        "C:/Windows/Fonts/seguisym.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/cambria.ttf",
        "/Library/Fonts/Cambria Math.ttf",
    ]
    for c in cands:
        if os.path.exists(c):
            _MATH_FONT_CACHE["path"] = c
            return c
    return ""


# 引用角标：[12] / [1, 2] / [3–5]。译文里去掉（原文保留），避免中文句子里夹着无意义编号。
_CITE_RE = re.compile(r"\s*\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]")

def _strip_citations(text: str) -> str:
    if not text:
        return text
    return re.sub(r"[ \t]{2,}", " ", _CITE_RE.sub("", text))


def clean_math_duplicates(text: str) -> str:
    """纯文本没有几何证据，保留合法的重复变量。"""
    return text or ""


# 行内公式里「有结构含义」的字符：一旦抽取时被丢掉，就不能假装公式还对得上
_MATH_STRUCT_RE = re.compile(r"[\^_(){}\[\]+=/<>\u2264\u2265\u00b1\u00b7]")
# 占位符条目带这个前缀 = 源里有结构字符、但转成文本时丢了 → 不允许当正常公式渲染
_MATH_LOSSY = "\u0001"

def _math_run_to_text(run: str) -> str:
    """把抽坏的公式片段还原成**可读且类别不丢**的文本。

    - Unicode 数学字母数字（𝒫、𝓟、ℙ…）保留原码位：花体仍是花体、双线体仍是
      双线体，画的时候用数学字体渲染（见 `_draw_math_box`）。
    - 私用区 / U+FFFD：**不知道是哪个类别**，不猜，直接丢弃（上层会计入
      `formulaApproximated` 并告警）。
    - 不凭文本重复去重：不同位置的相同变量可能具有数学含义。
    """
    chars = list(run)
    out: list[str] = []
    for ch in chars:
        o = ord(ch)
        if ch in "\ufffd?":
            continue
        if 0x1D400 <= o <= 0x1D7FF or 0x2100 <= o <= 0x214F:
            out.append(ch)  # 类别可确定：原样保留
        elif o in (0x2308, 0x2309, 0x230A, 0x230B, 0x27E8, 0x27E9):
            # ⌈ ⌉ ⌊ ⌋ ⟨ ⟩：合法数学符号，必须保留（否则取整/内积会变成裸变量）
            out.append(ch)
        elif 0xE000 <= o <= 0xF8FF:
            continue  # 类别未知：不猜
        elif ch.isalnum():
            out.append(ch)
    return "".join(out)


def _mask_math(text: str) -> tuple[str, list[str]]:
    """翻译前把抽坏的公式片段替换成占位符 `⟦n⟧`，译完再还原。

    直接送模型的话，`𝒫𝒫, 𝒟𝒟𝒯𝒯i₁, �?` 这种内容会被"翻译"成 `p(h???1)`。
    """
    items: list[str] = []

    def _repl(m) -> str:  # noqa: ANN001
        src = m.group(0)
        txt = _math_run_to_text(src)
        # 源片段带上下标/括号/运算符，但转成可读文本后这些结构没了：
        # 还原不出原公式形状，标记下来，写回时宁可保留原文也不画假公式。
        if _MATH_STRUCT_RE.search(src) and not _MATH_STRUCT_RE.search(txt):
            txt = _MATH_LOSSY + txt
        items.append(txt)
        return "⟦%d⟧" % (len(items) - 1)

    return _MATH_JUNK_RE.sub(_repl, text), items


def _restore_math(text: str, items: list[str]) -> str:
    """把译文里的占位符换回可读的公式符号（模型一般会原样保留 ⟦n⟧）。"""
    if not items or not text:
        return text
    for k, v in enumerate(items):
        text = text.replace("⟦%d⟧" % k, v)
    return text


def _restore_formula_placeholders(
    flat: list[dict], translated: list[str]
) -> tuple[int, int]:
    """还原行内公式占位符，并逐项校验是否被模型吞掉。

    返回 ``(缺符号的块数, 缺失符号总数)``。旧实现只在**全部**占位符都消失时
    才记账，模型只吞掉其中一个时会被误判为成功（译文静默少符号）。
    """
    dropped = 0
    missing_total = 0
    unreliable = 0
    for i, f in enumerate(flat):
        items = f.get("math") or []
        if not items:
            continue
        before = translated[i] or ""
        if before == (f.get("raw") or ""):
            continue  # 跳过类型：本来就保留原文
        missing = [k for k in range(len(items)) if before.count("⟦%d⟧" % k) != 1]
        if missing:
            dropped += 1
            missing_total += len(missing)
            # Missing/repeated placeholders cannot be repaired by guessing where a symbol
            # belongs. Leave the entire source paragraph intact and report the fallback.
            translated[i] = f.get("raw") or ""
            continue
        if any(str(v).startswith(_MATH_LOSSY) for v in items):
            # 公式结构还原不了：不假装还原成功。这里只记账并在整篇结束时告警；
            # 不退回原文——退回会让这块文字与矢量公式重叠，反而更糟。
            unreliable += 1
        restored = _restore_math(before, items)
        # 引用角标在译文里没有阅读价值：只有当**原文**含 [n] 时才清理，
        # 避免误删正文里合法的方括号内容（如 [a, b]）。
        if _CITE_RE.search(f.get("raw") or ""):
            restored = _strip_citations(restored)
        translated[i] = restored
    return dropped, missing_total, unreliable


def _join_flat_text(a: str, b: str) -> str:
    """拼接相邻两行：处理连字符断词；中文之间不插空格。"""
    a = (a or "").rstrip()
    b = (b or "").lstrip()
    if not a:
        return b
    if not b:
        return a
    if a.endswith("\u00ad"):  # soft hyphen（PDF 里的软连字符）
        return a[:-1] + b
    if (
        a.endswith("-")
        and len(a) >= 2
        and a[-2].isalpha()
        and a[-2].islower()
        and b[:1].islower()
    ):
        return a[:-1] + b
    if CJK_RE.search(a[-1]) or CJK_RE.search(b[0]):
        return a + b
    return a + " " + b



# ---- 文献角标：两阶段识别（局部字号/基线 → 编号形式与上下文）----
_CITE_NUM_RE = re.compile(r"^\[?\d{1,3}(?:[,;–—-]\d{1,3})*\]?$")


def _span_origin_y(s: dict) -> float:
    o = s.get("origin")
    if isinstance(o, (list, tuple)) and len(o) >= 2 and float(o[1]) > 0:
        return float(o[1])
    bb = s.get("bbox")
    if isinstance(bb, (list, tuple)) and len(bb) >= 4:
        return float(bb[3])
    return 0.0


def _sup_runs_in_line(spans: list[dict]) -> list[list[dict]]:
    """阶段 1：同一行内「字号更小 + 基线抬高」的连续 span。

    基准用**本行字符数最多**的 span（局部正文），不用全篇固定字号/坐标。
    允许多 span 组合：20 , 21 / 20 – 23（中间的标点若为正文大小也并入）。
    """
    if not spans:
        return []
    body = max(spans, key=lambda x: len((x.get("text") or "").strip()))
    bs = float(body.get("size") or 0.0)
    by = _span_origin_y(body)
    if bs <= 0 or by <= 0:
        return []
    sup: list[bool] = []
    for sp in spans:
        sz = float(sp.get("size") or 0.0)
        oy = _span_origin_y(sp)
        sup.append(sz > 0 and sz <= bs * 0.85 and (by - oy) >= max(0.15 * bs, 1.0))
    runs: list[list[dict]] = []
    i = 0
    while i < len(spans):
        if not sup[i]:
            i += 1
            continue
        idxs = [i]
        j = i + 1
        while j < len(spans):
            if sup[j]:
                idxs.append(j)
                j += 1
                continue
            punct = not (spans[j].get("text") or "").strip(" ,;–—-")
            if punct and j + 1 < len(spans) and sup[j + 1]:
                idxs.append(j)
                j += 1
                continue
            break
        runs.append([spans[k] for k in idxs])
        i = j
    return runs


def _apply_citation_filter(flat: list[dict], kinds: list[str], skips: list[bool]) -> int:
    """阶段 2：结合编号形式、参考文献范围、公式区域与上下文，只移除高置信度角标。

    结果只影响**翻译输入**（rawClean）；raw/原文、bbox 与偏移映射保留在元数据里。
    返回移除的角标数量。
    """
    max_ref = 0
    for f in flat:
        if not f.get("refsec"):
            continue
        raw0 = f.get("raw") or ""
        m = re.match(r"\s*\[?(\d{1,3})", raw0)
        if m and _NUM_REF_RE.match(raw0):
            max_ref = max(max_ref, int(m.group(1)))

    removed = 0
    for i, f in enumerate(flat):
        f.pop("rawClean", None)
        if skips[i]:
            continue
        line_spans = f.get("lineSpans") or []
        lines = f.get("lines") or []
        raw = f.get("raw") or ""
        if not line_spans or not lines or not raw:
            continue
        # 公式/图内区域：不做引用判定（数学上下标一律保留）
        if kinds[i] in ("formula", "figure") or (f.get("math_ratio") or 0) >= 0.12:
            continue
        citations: list[dict] = []
        search = 0
        for li, lt in enumerate(lines):
            if li >= len(line_spans) or not lt:
                continue
            lstart = raw.find(lt, search)
            if lstart < 0:
                continue
            search = lstart + len(lt)
            # 署名/单位行：逗号分隔的人名 + 无句末标点。这里的上标是单位编号，
            # 不是文献引用（1–8 往往也落在参考文献范围内，单靠编号无法区分）。
            _author_line = lt.count(",") >= 3 and not re.search(r"[.!?。！？]", lt)
            if lt.count("\u00a0") >= 2:
                _author_line = True
            if _author_line:
                continue
            for run in _sup_runs_in_line(line_spans[li]):
                rawtxt = "".join(sp.get("text") or "" for sp in run)
                txt = re.sub(r"\s+", "", rawtxt)
                if not txt or not _CITE_NUM_RE.match(txt):
                    continue
                nums = [int(x) for x in re.findall(r"\d{1,3}", txt)]
                if not nums:
                    continue
                # 编号必须落在本文参考文献范围内（未知范围时只靠几何+形式）
                if max_ref and any(n < 1 or n > max_ref for n in nums):
                    continue
                # Locate this exact span run, never the first matching number in the line.
                offset = 0
                positions = {}
                for span in line_spans[li]:
                    token_text = span.get("text") or ""
                    found = lt.find(token_text, offset)
                    if found < 0:
                        positions = {}
                        break
                    positions[id(span)] = found
                    offset = found + len(token_text)
                pos = positions.get(id(run[0]), -1)
                if pos >= 0:
                    pos += len(rawtxt) - len(rawtxt.lstrip())
                if pos < 0:
                    continue
                before = lt[:pos].rstrip()
                if before.endswith("^"):
                    continue  # 10^2
                mprev = re.search(r"([A-Za-z\u4e00-\u9fff]+|[.,;:)\]])$", before)
                if not mprev:
                    continue
                token = mprev.group(1)
                # 单个字母后的上标是数学幂次（x² / n²），不是文献引用
                if len(token) == 1 and token.isalpha():
                    continue
                after = lt[pos + len(rawtxt.strip()) :]
                if after[:1] in ("%", "‰", "°"):
                    continue
                # 角标后紧跟大写单词 → 作者单位标记（2Department / 3School），不是文献引用
                if kinds[i] in ("authors", "affiliation") and after.lstrip()[:1].isupper():
                    continue
                # 斜体 + 数学字体 → 变量上标，保留
                if all(bool(sp.get("italic")) for sp in run) and any(
                    "math" in (sp.get("font") or "").lower() for sp in run
                ):
                    continue
                bbs = [sp.get("bbox") or [0, 0, 0, 0] for sp in run]
                citations.append(
                    {
                        "text": txt,
                        "page": int(f.get("pno") or 0) + 1,
                        "bbox": [
                            min(float(b[0]) for b in bbs),
                            min(float(b[1]) for b in bbs),
                            max(float(b[2]) for b in bbs),
                            max(float(b[3]) for b in bbs),
                        ],
                        "origStart": lstart + pos,
                        "origEnd": lstart + pos + len(rawtxt.strip()),
                        # 便于人工复核命中：该行原文（截断）
                        "context": lt[:160],
                    }
                )
        if not citations:
            continue
        citations.sort(key=lambda c: c["origStart"])
        dedup: list[dict] = []
        for c in citations:
            if dedup and c["origStart"] < dedup[-1]["origEnd"]:
                continue
            dedup.append(c)
        parts: list[str] = []
        cur = 0
        clean_len = 0
        kept: list[dict] = []
        for c in dedup:
            if c["origStart"] < cur or c["origEnd"] > len(raw):
                continue
            seg = raw[cur : c["origStart"]]
            parts.append(seg)
            clean_len += len(seg)
            c["cleanPos"] = clean_len
            kept.append(c)
            cur = c["origEnd"]
        if not kept:
            continue
        parts.append(raw[cur:])
        clean = "".join(parts)
        if clean == raw:
            continue
        f["rawClean"] = clean
        f["citations"] = kept
        removed += len(kept)
    return removed



def _split_coarse_paragraph(f: dict, body_size: float = 0.0) -> list[dict]:
    """PyMuPDF 常把**整栏**正文返回成一个 block；按行距/首行缩进切成真正的段落。

    判据只用版面几何（行间距突增、首行缩进 + 上一行句末标点），不按字符数猜。
    切出来的片段各自保留 rect / lines / spans，后续排版与映射都以段落为单位。
    """
    if f.get("refsec"):
        return [f]
    rects = [fitz.Rect(x) for x in (f.get("lineRects") or [])]
    lts = list(f.get("lines") or [])
    if len(rects) < 2 or len(rects) != len(lts):
        return [f]
    size = float(f.get("size") or body_size or 10.0)
    gaps = [rects[i + 1].y0 - rects[i].y1 for i in range(len(rects) - 1)]
    pos = sorted(g for g in gaps if g > -2)
    # 用**下四分位**而不是中位数：行数少时中位数会被段间距带偏
    # （例如 [2, 14] 的中位数是 14，反而看不出 14 是“突增”）。
    med = pos[max(0, len(pos) // 4)] if pos else 0.0
    base_x0 = min(r.x0 for r in rects)
    col_right = max(r.x1 for r in rects)
    groups: list[list[int]] = [[0]]
    for i in range(1, len(rects)):
        g = gaps[i - 1]
        brk = g > max(med * 1.9, med + size * 0.5)
        if not brk:
            indent = rects[i].x0 - base_x0
            if (
                indent > max(3.0, size * 0.55)
                and lts[i - 1].rstrip().endswith((".", "。", "！", "？", "!", "?"))
            ):
                brk = True
        if not brk:
            # 上一行明显短于栏宽 + 句末标点 = 段落结束（两端对齐时只能靠这个判断）
            if (
                col_right - rects[i - 1].x1 > max(size * 2.5, 24.0)
                and lts[i - 1].rstrip().endswith((".", "。", "！", "？", "!", "?"))
            ):
                brk = True
        if brk:
            groups.append([i])
        else:
            groups[-1].append(i)
    if len(groups) == 1:
        return [f]
    out: list[dict] = []
    for gi, idxs in enumerate(groups):
        r = fitz.Rect(rects[idxs[0]])
        for j in idxs[1:]:
            r |= rects[j]
        txt = ""
        for j in idxs:
            txt = _join_flat_text(txt, lts[j]) if txt else lts[j]
        piece = dict(f)
        piece.update(
            {
                "id": f"{f.get('id')}-{gi}",
                "rect": r,
                "bbox": [r.x0, r.y0, r.x1, r.y1],
                "raw": txt.strip(),
                "text": txt.strip(),
                "lines": [lts[j] for j in idxs],
                "lineSpans": [
                    (f.get("lineSpans") or [])[j]
                    for j in idxs
                    if j < len(f.get("lineSpans") or [])
                ],
                "lineRects": [
                    [rects[j].x0, rects[j].y0, rects[j].x1, rects[j].y1] for j in idxs
                ],
                "nlines": len(idxs),
            }
        )
        out.append(piece)
    return out


_SENT_SPLIT_RE = re.compile(r"(?<=[.!?。！？])(?![.!?。！？])\s*")
_SENT_MARK_RE = re.compile(r"⟪PD-S(\d+)⟫")


def _marked_sentences(text: str) -> tuple[str, list[str]]:
    sentences = _split_sentences(text)
    if not sentences or _SENT_MARK_RE.search(text):
        return text, []
    return " ".join(f"⟪PD-S{i}⟫{s}" for i, s in enumerate(sentences)), sentences


def _unmark_sentences(text: str, count: int) -> tuple[str, list[str]]:
    matches = list(_SENT_MARK_RE.finditer(text))
    if count < 1 or [int(m.group(1)) for m in matches] != list(range(count)) or text[:matches[0].start()].strip():
        return _SENT_MARK_RE.sub("", text).strip(), []
    parts = [text[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(text)].strip() for i, m in enumerate(matches)]
    return " ".join(parts), parts if all(parts) else []


def _split_sentences(text: str) -> list[str]:
    """按句末标点切句（中英通用）。只用于「同页/同段」的句级映射，不做跨语言猜测。"""
    t = (text or "").strip()
    if not t:
        return []
    # Decimal points and common scientific abbreviations are not sentence boundaries.
    protected = re.sub(r"(?<=\d)\.(?=\d)", "\ue100", t)
    protected = re.sub(r"\b(?:e\.g|i\.e|Fig|Figs|Eq|Eqs|Dr|Prof|vs|et\s*al|No)\.",
                       lambda m: m.group(0).replace(".", "\ue100"), protected, flags=re.I)
    return [x.strip().replace("\ue100", ".") for x in _SENT_SPLIT_RE.split(protected) if x.strip()]


def _norm_nospace(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _segment_pieces(
    text: str, line_pairs: list[tuple[str, "fitz.Rect"]], sentence_parts: list[str] | None = None
) -> list[tuple[list[float], int, list[tuple[list[float], int]]]]:
    """按句子切分文本，返回 ``(并集矩形, 归一化字数, 行片段列表)``。

    行片段是这句落在**每个文本行**上的紧凑矩形（同行多句按字符占比切 x）。
    旧实现每句只给一个跨行并集框，共享行上相邻句必然重叠，客户端无法区分
    「选第一句」和「选第二句」；片段列表让映射能按真实交叠判定。
    """
    if not text or not line_pairs:
        return []
    norm_lines = [_norm_nospace(t) for t, _ in line_pairs]
    if not any(norm_lines):
        return []
    starts: list[int] = []
    total = 0
    for t in norm_lines:
        starts.append(total)
        total += len(t)
    norm = _norm_nospace(text)
    sents = [_norm_nospace(s) for s in sentence_parts] if sentence_parts else _split_sentences(norm)
    if sentence_parts and "".join(sents) != norm:
        return []
    out: list[tuple[list[float], int, list[tuple[list[float], int]]]] = []
    pos = 0
    for s in sents:
        end = pos + len(s)
        hit = [i for i, off in enumerate(starts) if off < end and off + len(norm_lines[i]) > pos]
        pieces: list[tuple[list[float], int]] = []
        for i in hit:
            line_len = len(norm_lines[i])
            if line_len <= 0:
                continue
            ls = max(0, pos - starts[i])
            le = min(line_len, end - starts[i])
            if le <= ls:
                continue
            lr = line_pairs[i][1]
            # 同一行内按字符占比切 x：不做跨语言比例，只在同一行内定位句子的横向范围
            f0 = ls / line_len
            f1 = le / line_len
            pieces.append(
                (
                    [
                        lr.x0 + lr.width * f0,
                        lr.y0,
                        lr.x0 + lr.width * f1,
                        lr.y1,
                    ],
                    le - ls,
                )
            )
        if pieces:
            r = fitz.Rect(pieces[0][0])
            for pr, _w in pieces[1:]:
                r |= fitz.Rect(pr)
            out.append(([r.x0, r.y0, r.x1, r.y1], max(1, len(s)), pieces))
        pos = end
    return out


def _segment_rects(text: str, line_pairs: list[tuple[str, "fitz.Rect"]]) -> list[list[float]]:
    """把一段文本按句子切分，并用「字符落在哪些行」求每句的矩形。

    同一行里有多句时按字符占比横向切分（否则整行都算给每一句，选区会多高亮）。
    """
    return [rect for rect, _w in _segments(text, line_pairs)]


def _segments(text: str, line_pairs: list[tuple[str, "fitz.Rect"]]) -> list[tuple[list[float], int]]:
    """按句子切分文本，返回 ``(矩形, 归一化字数)``。

    与 ``_segment_rects`` 的差别只是多带一个长度权重，供跨语言「按比例对齐」用。
    需要逐行紧凑片段时用 ``_segment_pieces``（多带第三个元素）。
    """
    return [(rect, weight) for rect, weight, _pieces in _segment_pieces(text, line_pairs)]


def _sentence_piece_pairs(
    src_pieces: list[tuple[list[float], int]],
    dst_pieces: list[tuple[list[float], int]],
) -> list[list[list[float]]]:
    """把一对已对齐的句子按**句内位置比例**配成紧凑片段。

    两句的行片段各按字符数占整句的比例切区间，区间有交叠即配对。这样一句跨两行时
    输出的是两个紧凑片段，而不是一个覆盖两行的并集框（相邻句因此不再共享 bbox）。
    """
    if not src_pieces or not dst_pieces:
        return []

    def spans(items: list[tuple[list[float], int]]) -> list[tuple[float, float, list[float]]]:
        total = float(sum(w for _r, w in items)) or 1.0
        out: list[tuple[float, float, list[float]]] = []
        acc = 0.0
        for r, w in items:
            out.append((acc / total, (acc + w) / total, r))
            acc += w
        return out

    pairs: list[list[list[float]]] = []
    for s0, s1, s_rect in spans(src_pieces):
        for d0, d1, d_rect in spans(dst_pieces):
            if min(s1, d1) - max(s0, d0) > 1e-9:
                pairs.append([s_rect, d_rect])
    return pairs


def _align_segments(src: list, dst: list) -> list[list[list[float]]]:
    """把源/译句按**长度比例**做单调多对多对齐，并尽量落到紧凑片段。

    入参每项是 ``(矩形, 字数)`` 或 ``(矩形, 字数, 行片段列表)``（``_segment_pieces``
    的产物）。两侧句数一致时直接一一对应；不一致时（模型合并/拆分句子很常见）按
    累计字数占比求重叠：源句覆盖到译文哪几句，就把这些句都记成同一组映射。返回
    ``[[srcRect, dstRect], …]``；两侧都带行片段时，每对句子再按句内比例细分成
    紧凑片段对，客户端按真实交叠即可区分相邻句。旋转块/行文本不可信时调用方不写
    ``segs``，客户端宁可不亮也不整块兜底。
    """
    if not src or not dst:
        return []
    src_rects = [item[0] for item in src]
    dst_rects = [item[0] for item in dst]
    src_pieces = [item[2] if len(item) > 2 else None for item in src]
    dst_pieces = [item[2] if len(item) > 2 else None for item in dst]

    if len(src) == len(dst):
        idx_pairs: list[tuple[int, int]] = [(i, i) for i in range(len(src))]
    else:

        def bounds(items: list) -> list[tuple[float, float]]:
            total = float(sum(item[1] for item in items)) or 1.0
            out: list[tuple[float, float]] = []
            acc = 0.0
            for item in items:
                out.append((acc / total, (acc + item[1]) / total))
                acc += item[1]
            return out

        sb, db = bounds(src), bounds(dst)

        def nearest(b: tuple[float, float], others: list[tuple[float, float]]) -> int:
            mid = (b[0] + b[1]) / 2.0
            return min(
                range(len(others)),
                key=lambda k: abs((others[k][0] + others[k][1]) / 2.0 - mid),
            )

        raw: list[tuple[int, int]] = []
        # 源 → 译：一个源句可能落在多个译句上（模型拆句）
        for i, (a, b) in enumerate(sb):
            hit = [j for j, (c, d) in enumerate(db) if min(b, d) - max(a, c) > 1e-9]
            if not hit:
                hit = [nearest((a, b), db)]
            raw.extend((i, j) for j in hit)
        # 译 → 源：一个译句可能对应多个源句（模型并句），反向也要能高亮
        for j, (c, d) in enumerate(db):
            hit = [i for i, (a, b) in enumerate(sb) if min(b, d) - max(a, c) > 1e-9]
            if not hit:
                hit = [nearest((c, d), sb)]
            raw.extend((i, j) for i in hit)
        idx_pairs = raw

    seen: set[tuple] = set()
    out: list[list[list[float]]] = []
    for i, j in idx_pairs:
        sub = (
            _sentence_piece_pairs(src_pieces[i], dst_pieces[j])
            if src_pieces[i] and dst_pieces[j]
            else []
        )
        if not sub:
            sub = [[src_rects[i], dst_rects[j]]]
        for s_rect, d_rect in sub:
            k = (
                tuple(round(v, 1) for v in s_rect),
                tuple(round(v, 1) for v in d_rect),
            )
            if k in seen:
                continue
            seen.add(k)
            out.append([s_rect, d_rect])
    return out


def _page_text_lines(page: "fitz.Page") -> list[tuple[str, "fitz.Rect"]]:
    """当前页所有文本行（text, bbox），阅读顺序。写回后用于句级映射。"""
    lines: list[tuple[str, fitz.Rect]] = []
    try:
        d = page.get_text("dict")
    except Exception:  # noqa: BLE001
        return lines
    for b in d.get("blocks", []):
        if b.get("type") != 0:
            continue
        for ln in b.get("lines", []):
            t = "".join(s.get("text", "") for s in ln.get("spans", []))
            if t.strip():
                lines.append((t, fitz.Rect(ln["bbox"])))
    lines.sort(key=lambda x: (round(x[1].y0, 1), x[1].x0))
    return lines


def _can_merge_flat(
    prev: dict,
    cur: dict,
    figs: list,
    body_size: float,
    col_right: float,
    max_gap: float,
    col_x0: float | None = None,
) -> bool:
    if prev.get("fig_internal") or cur.get("fig_internal"):
        return False
    # 公式岛与正文绝不合并，否则拆分后又会被重新并回同一个块
    if prev.get("formulaOnly") or cur.get("formulaOnly"):
        return False
    # 角色/颜色/字体不同的块绝不合并（DOI 蓝不能并进标题，作者不能并进摘要）
    if (prev.get("roleHint") or "") != (cur.get("roleHint") or ""):
        return False
    if int(prev.get("color") or 0) != int(cur.get("color") or 0):
        return False
    if (prev.get("font") or "") != (cur.get("font") or ""):
        return False
    # 题注可以合并（同一题注的续行），但题注不与正文合并
    if bool(prev.get("cap")) != bool(cur.get("cap")):
        return False
    # 参考文献逐条保留，不合并（合并会糊成一段）
    if prev.get("refsec") or cur.get("refsec"):
        return False
    # 算法/伪代码行（"1:"、"12:" 开头）保留逐行结构
    if _ALGO_LINE_RE.match(prev.get("raw") or "") or _ALGO_LINE_RE.match(cur.get("raw") or ""):
        return False
    if bool(prev.get("absec")) != bool(cur.get("absec")):
        return False
    # 文字方向不同的块绝不合并（横排正文 + 竖排轴标签挨在一起时会被并成一段）
    if abs(float(prev.get("angle") or 0.0) - float(cur.get("angle") or 0.0)) > 1.0:
        return False
    ps = float(prev.get("size") or 0.0)
    cs = float(cur.get("size") or 0.0)
    if ps and cs and abs(ps - cs) > max(0.6, ps * 0.08):
        return False
    # 标题/正文已在上面用「角色 + 字号」区分；这里不能再按 body_size 一刀切，
    # 否则标题的多行永远合不成一个标题对象。
    pr, cr = prev["rect"], cur["rect"]
    overlap = min(pr.x1, cr.x1) - max(pr.x0, cr.x0)
    if overlap <= 0.55 * min(pr.width or 1.0, cr.width or 1.0):
        return False
    gap = cr.y0 - pr.y1
    if gap < -1.5 or gap > max_gap:
        return False
    # 上一**行**明显短于栏宽 → 段末。
    # 注意必须用最后一行的右边缘，不能用合并后 union 的右边缘（union 一直是栏宽，
    # 判断永远不成立 → 整栏所有段落被并成一段，译文自然「挤在一起」）。
    tail_x1 = float(prev.get("_tail_x1") or pr.x1)
    if ps <= (body_size or 10.0) * 1.2 and tail_x1 < col_right - max(2.0, (body_size or 10.0) * 0.6):
        return False
    # 首行缩进 + 上一行以句末标点结束 → 新段落（两侧都对齐时靠缩进识别）
    if (
        ps <= (body_size or 10.0) * 1.2
        and col_x0 is not None
        and cr.x0 - col_x0 > max(4.0, ps * 0.6)
        and (prev.get("raw") or "").rstrip().endswith((".", "。", "！", "？", "!", "?"))
    ):
        return False
    # 中间夹了图/表区域 → 不合并
    for fr in figs:
        if (
            fr.y1 > pr.y1 + 1
            and fr.y0 < cr.y0 - 1
            and min(fr.x1, pr.x1) - max(fr.x0, pr.x0) > 0
        ):
            return False
    return True


def _merge_flat_paragraphs(
    flat: list[dict], figs_by_page: dict[int, list], body_size: float
) -> list[dict]:
    """把「同栏、上下紧邻、同字号」的行块合并成**段落**（翻译前做）。

    PyMuPDF 在双栏论文里经常给出「一行一个块」：
      - 逐行翻译 → 句子被切碎、标点丢失、上下文断裂；
      - 行块高度只有一行 → 译文稍长就只能缩到 4–5pt（看起来忽大忽小）。
    合并成段后按段落翻译、按整段高度排版，字号才能保持正文大小。
    """
    if len(flat) < 2:
        return flat

    pages: dict[int, list[dict]] = {}
    for f in flat:
        pages.setdefault(int(f.get("pno") or 0), []).append(f)

    max_gap = max(3.2, (body_size or 10.0) * 0.85)
    out: list[dict] = []
    for pno in sorted(pages):
        figs = figs_by_page.get(pno) or []
        # 按 x0 聚类成「栏」（左右栏的 x0 差很多）
        cols: list[list[dict]] = []
        for f in sorted(pages[pno], key=lambda x: (x["rect"].x0, x["rect"].y0)):
            for col in cols:
                if abs(col[0]["rect"].x0 - f["rect"].x0) <= 14:
                    col.append(f)
                    break
            else:
                cols.append([f])
        cols.sort(key=lambda c: min(x["rect"].y0 for x in c))
        for col in cols:
            col.sort(key=lambda x: (x["rect"].y0, x["rect"].x0))
            col_right = max(x["rect"].x1 for x in col)
            # 栏内正文的左边界（取中位/最小值，避免首行缩进把基准带偏）
            col_x0 = min(x["rect"].x0 for x in col)
            cur: dict | None = None
            for f in col:
                if cur is None:
                    cur = f
                    continue
                if _can_merge_flat(cur, f, figs, body_size, col_right, max_gap, col_x0):
                    cur["raw"] = _join_flat_text(cur["raw"], f["raw"])
                    # 段落结束判定要用「最后一行」的右边缘，不能用 union
                    cur["_tail_x1"] = f["rect"].x1
                    cur["rect"] = fitz.Rect(
                        min(cur["rect"].x0, f["rect"].x0),
                        cur["rect"].y0,
                        max(cur["rect"].x1, f["rect"].x1),
                        f["rect"].y1,
                    )
                    cur["nlines"] = int(cur.get("nlines") or 1) + int(f.get("nlines") or 1)
                    # 段落内部保留每个 span 的样式（粗体/斜体/链接），
                    # 但**不**改变整段的主导样式（按字符数重新投票，避免继承第一个 span）
                    cur["spans"] = list(cur.get("spans") or []) + list(f.get("spans") or [])
                    cur["lines"] = list(cur.get("lines") or []) + list(f.get("lines") or [])
                    cur["lineSpans"] = list(cur.get("lineSpans") or []) + list(
                        f.get("lineSpans") or []
                    )
                    _cnt: dict[tuple, int] = {}
                    for st in cur["spans"]:
                        k = (
                            st.get("family") or "",
                            round(float(st.get("size") or 0.0), 1),
                            int(st.get("color") or 0),
                            bool(st.get("bold")),
                        )
                        _cnt[k] = _cnt.get(k, 0) + len(st.get("text") or "")
                    if _cnt:
                        _dom = max(_cnt, key=_cnt.get)
                        cur["size"] = cur["fontSize"] = float(_dom[1])
                        cur["font"] = cur["fontFamily"] = _dom[0]
                        cur["color"] = int(_dom[2])
                        cur["bold"] = bool(_dom[3])
                    if not cur.get("link"):
                        cur["link"] = f.get("link")
                else:
                    out.append(cur)
                    cur = f
            if cur is not None:
                out.append(cur)
    return out


def simple_translate(
    src: str,
    out: str,
    target_lang: str = "zh",
    backend: str = "mock",
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    headers: dict | None = None,
    on_progress=None,
    is_cancelled=None,
    html_out: str | None = None,
    bilingual_out: str | None = None,
    md_out: str | None = None,
    bilingual_md_out: str | None = None,
    skills_dir: str | None = None,
    doc_title: str | None = None,
    doc_authors: str | None = None,
    max_workers: int = 4,
    retries: int = 2,
    skip_rects: dict | None = None,
    batch_size: int | None = None,
    mode: str = "fine",
    # 版式：reflow=可读优先（允许页内上下推挤/回收空白）；strict=严格保版式
    layout: str = "reflow",
    # 用户自定义术语表（每行 `英文=中文`）；与自动抽取的术语合并，用户优先
    glossary: str | None = None,
    terminology: str = "",
    # 是否自动抽取术语表（默认开）；关掉可省一次模型请求
    auto_glossary: bool = True,
    # 翻译时关闭模型「思考」（默认开：论文段落翻译不需要推理，开着会让单请求多等几十秒）
    no_think: bool = True,
    # 保存后按页验收，并对「正文没有正常落版」的页自动打回重译（默认开）。
    # 重译时会用单页临时 PDF 再调一次本函数；递归调用必须传 False，避免无限递归。
    verify: bool = True,
    # 用户显式“重译本页”时置 True：即使该页图元很多也强制走擦除/回填，
    # 否则 heavy_pages 会把整页保留原文，单页重译永远修不好。
    heavy_page_override: bool = False,
    # 译文正文字号增量（pt）：0 = 与原文同字号；默认 +1.5，用户可在设置里调整
    font_delta: float = DEFAULT_FONT_DELTA,
) -> dict:
    """mode=fine：精译（逐段重排、按底色选字色、论文级样式）；coarse：粗译（个人阅读为主）。

    粗译不做「逐页位图取底色」这类重活，优先把标题/摘要/正文/结论/题注翻出来，
    允许少量排版瑕疵；公式/图表内部/作者/DOI/参考文献仍然原样保留。
    """
    MODE = (mode or "fine").strip().lower()
    COARSE = MODE == "coarse"
    def report(stage: str, done: int, total: int) -> None:
        if on_progress is not None:
            try:
                on_progress(stage, done, total)
            except Exception:  # noqa: BLE001
                pass

    def cancelled() -> bool:
        return bool(is_cancelled and is_cancelled())

    BATCH = max(1, min(64, int(batch_size or 24)))
    report("analyzing", 0, 0)
    doc = fitz.open(src)
    pages = doc.page_count
    blocks = 0
    warnings: list[str] = []

    # ---- 第一遍：收集所有待翻译块（记录字号，供 HTML 推断标题层级） ----
    flat: list[dict] = []
    figs: list[dict] = []  # 图片块（不翻译；供可重排阅读区按阅读顺序内嵌原图）
    fig_regions_by_page: dict[int, list] = {}  # 矢量图形区域（其内部文本不翻译）
    table_gate: dict[int, bool] = {}  # 该页是否值得跑昂贵的 find_tables
    draw_count_by_page: dict[int, int] = {}  # 每页矢量图元数（写回阶段用来规避病态页）
    draws_by_page: dict[int, list] = {}  # 每页矢量图元（表格线聚类复用，避免重复解析）
    page_texts: list[str] = []  # 每页纯文本（页角色判定：正文/参考文献/附录）
    by_page: dict[int, list[int]] = {}
    in_refs = False
    in_abstract = False
    abs_head = False
    stage_t: dict[str, float] = {"extract": 0.0, "analyze": 0.0, "translate": 0.0, "write": 0.0}
    _t0 = time.time()
    for pno, page in enumerate(doc):
        # 分析阶段也要能取消：矢量大图页面单页可能要数秒，用户点了取消必须立刻停
        if cancelled():
            raise RuntimeError("已取消")
        report("analyzing", pno + 1, pages)
        data = page.get_text("dict")
        # 矢量图只解析**一次**：图形区域聚类和「是否可能含表格」的闸门共用同一份，
        # 否则 30 页论文里光是重复 get_drawings() 就要多花十几秒。
        try:
            _draws = page.get_drawings()
        except Exception:  # noqa: BLE001
            _draws = []
        page_regions = _figure_regions(page, _draws)
        fig_regions_by_page[pno] = page_regions
        draw_count_by_page[pno] = len(_draws)
        draws_by_page[pno] = _draws
        # 整页纯文本：供「正文/参考文献/附录」判定；比验收阶段逐页重开 PDF 便宜
        try:
            page_texts.append(page.get_text("text") or "")
        except Exception:  # noqa: BLE001
            page_texts.append("")
        _h = _v = 0
        for _d in _draws:
            _dr = _d.get("rect")
            if _dr is None:
                continue
            if _dr.width > 40 and _dr.height < 3:
                _h += 1
            elif _dr.height > 40 and _dr.width < 3:
                _v += 1
        # 保守闸门：没有任何像表格的线条就跳过昂贵的 find_tables（宁可多扫也不漏）。
        # 图元极多的页面（3.7 万个）find_tables 会退化到分钟级，直接放弃检测：
        # 这类页面是矢量大图，表格正文本来也不翻译，模块层的保护区仍会生效。
        table_gate[pno] = (
            (_h >= 5 or _v >= 2 or len(_draws) >= 60) and len(_draws) <= 4000
        )
        # 页面链接注解（URI）：把目标地址绑到落在其矩形内的文本块，供译文保留链接
        page_links: list[tuple["fitz.Rect", str]] = []
        try:
            for lk in page.get_links():
                uri = lk.get("uri")
                if uri:
                    page_links.append((fitz.Rect(lk.get("from")), str(uri)))
        except Exception:  # noqa: BLE001
            page_links = []
        # 页面位图（1pt≈1px）用于采样每块的背景色：译文按原底色回填、并据此选可读的字色，
        # 避免「译文颜色与背景相同 → 看不见」（如深色标题条、右侧引用栏）。
        # 粗译跳过：逐页渲染 + 采样是纯开销，白底论文上收益很小。
        if COARSE:
            page_pix = None
        else:
            try:
                page_pix = page.get_pixmap(dpi=72, colorspace=fitz.csRGB)
            except Exception:  # noqa: BLE001
                page_pix = None
        # ---- 结构化文本对象：以「行」为单位收集 span，再按**样式突变**切段 ----
        # PyMuPDF 常把 DOI、栏目名、标题塞进同一个 block。直接用 block 的 bbox +
        # 「第一个 span 的颜色/字号」，就会出现「DOI 蓝 + 标题字号」污染整块译文。
        # 这里以行为单位保留 span 样式，按 字号/字色/字体家族 的突变切段；段内
        # 粗体/斜体/链接仍作为 span 保留（不拆成多个翻译片段）。
        page_objs: list[dict] = []
        for bi, b in enumerate(data.get("blocks", [])):
            if b.get("type") != 0:  # 非文本块：图片单独收集
                if b.get("type") == 1:  # 图片块
                    bb = b.get("bbox") or (0, 0, 0, 0)
                    rect = fitz.Rect(bb)
                    if rect.width >= 24 and rect.height >= 24:  # 跳过 <24x24pt 的小图
                        fig = {"pno": pno, "rect": rect, "kind": "image", "order": bb[1]}
                        figs.append(fig)
                continue
            seg_lines: list[dict] = []
            for ln in b.get("lines", []):
                spans: list[dict] = []
                for s in ln.get("spans", []):
                    st = s.get("text", "")
                    if not st:
                        continue
                    fam = str(s.get("font") or "")
                    flags = int(s.get("flags") or 0)
                    spans.append(
                        {
                            "text": st,
                            "font": fam,
                            "family": fam.split("-")[0],
                            "size": float(s.get("size") or 0.0),
                            "color": int(s.get("color") or 0),
                            "bold": ("bold" in fam.lower()) or bool(flags & 16),
                            "italic": ("italic" in fam.lower())
                            or ("oblique" in fam.lower())
                            or bool(flags & 2),
                            # 上标识别/公式回填需要：字形的 bbox 与基线 origin
                            "bbox": [float(v) for v in (s.get("bbox") or (0, 0, 0, 0))],
                            "origin": [float(v) for v in (s.get("origin") or (0, 0))],
                        }
                    )
                if spans:
                    # dir 是文字基线方向（单位向量）。倾斜文本（图轴标签、竖排标题、
                    # 旋转表格头）必须保留，否则译文被强行摆平，和原图/表格对不上。
                    try:
                        _dx, _dy = ln.get("dir", (1.0, 0.0))
                    except Exception:  # noqa: BLE001
                        _dx, _dy = 1.0, 0.0
                    seg_lines.append(
                        {
                            "rect": fitz.Rect(ln["bbox"]),
                            "spans": spans,
                            "dir": (float(_dx), float(_dy)),
                        }
                    )
            if not seg_lines:
                continue
            _grouped: list[tuple[bool, list[dict]]] = []
            for _g in _group_lines_by_style(seg_lines):
                _grouped.extend(_split_formula_lines(_g))
            for part_formula, group in _grouped:
                raw = ""
                line_texts: list[str] = []
                line_spans: list[list[dict]] = []
                for g in group:
                    lt = "".join(s["text"] for s in g["spans"]).strip()
                    if not lt:
                        continue
                    line_texts.append(lt)
                    line_spans.append(g["spans"])
                    raw = _join_flat_text(raw, lt) if raw else lt
                raw = raw.strip()
                if not raw:
                    continue
                brect = fitz.Rect(group[0]["rect"])
                for g in group[1:]:
                    brect |= g["rect"]
                spans_all = [s for g in group for s in g["spans"]]
                # 主导样式按**字符数**投票（不是取第一个 span）
                _cnt: dict[tuple, int] = {}
                for st in spans_all:
                    k = (st["family"], round(st["size"], 1), st["color"], bool(st["bold"]))
                    _cnt[k] = _cnt.get(k, 0) + len(st["text"])
                dom = max(_cnt, key=_cnt.get)
                _label_like = (
                    not any(ch in raw for ch in ".。!?！？；;") and len(raw.split()) <= 10
                )
                _in_fig = _inside_figure(brect, page_regions)
                _fig_ratio = 0.0
                if brect.get_area() > 0:
                    for _rg in page_regions:
                        _it = _rg & brect
                        if _it.is_valid:
                            _fig_ratio = max(_fig_ratio, _it.get_area() / brect.get_area())
                _algo_lines = sum(1 for lt in line_texts if _ALGO_LINE_RE.match(lt))
                if re.match(r"^\s*Algorithm\s*\d+\s*[:：]", raw):
                    _algo_lines = max(_algo_lines, 3)
                # 旋转角：存成「可直接传给 fitz.Matrix 的角度」。
                # PyMuPDF 里 Matrix(θ) 把文字方向映射为 (cosθ, -sinθ)，故 θ = atan2(-dy, dx)。
                # <1° 视为水平（扫描件的微倾斜不重排，避免译文整体发虚）。
                _dir = group[0].get("dir") or (1.0, 0.0)
                _angle = math.degrees(math.atan2(-float(_dir[1]), float(_dir[0])))
                if _angle <= -179.5:
                    _angle += 360.0
                if abs(_angle) < 1.0:
                    _angle = 0.0
                page_objs.append(
                    {
                        "id": f"p{pno}-o{len(page_objs)}",
                        "blockId": f"p{pno}-b{bi}",
                        "pno": pno,
                        "page": pno,
                        "rect": brect,
                        "bbox": [brect.x0, brect.y0, brect.x1, brect.y1],
                        "raw": raw,
                        "text": raw,
                        "lines": line_texts,
                        "lineSpans": line_spans,
                        # 每行的矩形：用于按「行距/缩进」把过粗的块切成真正段落
                        "lineRects": [
                            [g["rect"].x0, g["rect"].y0, g["rect"].x1, g["rect"].y1]
                            for g in group
                        ],
                        # 原文文字方向 / 可直接用于 fitz.Matrix 的旋转角（0 = 水平）
                        "dir": [float(_dir[0]), float(_dir[1])],
                        "angle": round(float(_angle), 2),
                        "nlines": max(1, len(group)),
                        "size": float(dom[1]),
                        "fontSize": float(dom[1]),
                        "font": dom[0],
                        "fontFamily": dom[0],
                        "color": int(dom[2]),
                        "bold": bool(dom[3]),
                        "spans": spans_all,  # 段内多样式：供后续按 span 还原样式
                        "ph": page.rect.height,
                        "cap": bool(_CAP_RE.match(raw)),  # 图/表题注（仍按普通文本翻译）
                        "fig_internal": bool(
                            _in_fig and len(raw) <= 80 and len(group) <= 3 and _label_like
                        ),
                        "in_fig": _in_fig,
                        "in_fig_loose": _fig_ratio >= 0.6,
                        "math_ratio": (
                            len(_GARBLED_RE.findall(raw)) / max(1, len(raw)) if raw else 0.0
                        ),
                        # 行级拆分：这些行是独立公式岛，保留原文、不擦除
                        "formulaOnly": bool(part_formula),
                        "algo": _algo_lines >= 3,
                        "bg": _sample_bg(page_pix, brect, page.rect),
                        "link": _link_for_rect(brect, page_links),
                        "columnId": "",
                        "paragraphId": "",
                        "roleHint": "",
                    }
                )

        # 阅读顺序（先栏、再 y）+ 栏编号；参考文献/摘要状态也按这个顺序推进
        if page_objs:
            _maxsz = max(o["size"] for o in page_objs)
            _cols: list[list[dict]] = []
            for o in sorted(page_objs, key=lambda x: (x["rect"].x0, x["rect"].y0)):
                for c in _cols:
                    if abs(c[0]["rect"].x0 - o["rect"].x0) <= 14:
                        c.append(o)
                        break
                else:
                    _cols.append([o])
            _cols.sort(key=lambda c: min(x["rect"].y0 for x in c))
            for ci, col in enumerate(_cols):
                col.sort(key=lambda x: (x["rect"].y0, x["rect"].x0))
                for o in col:
                    o["columnId"] = f"p{pno}-c{ci}"
            # 状态机（摘要/参考文献）按**抽取顺序**推进：几何顺序会把「References」
            # 标题后面的条目排到标题之前，导致漏判。
            for o in page_objs:
                o["pageMaxSize"] = _maxsz
                raw = o["raw"]
                # 附录/补充材料是正文：遇到就结束 refsec，否则附录公式/证明会被整段跳过
                if _is_appendix_heading(raw):
                    in_refs = False
                elif _REF_HEADING_RE.match(raw):
                    in_refs = True
                elif _BACK_MATTER_RE.match(raw):
                    in_refs = False
                if _ABSTRACT_RE.match(raw):
                    in_abstract = True
                    abs_head = True
                elif in_abstract and _SECTION_START_RE.match(raw):
                    in_abstract = False
                    abs_head = False
                else:
                    abs_head = False
                o["refsec"] = in_refs
                o["absec"] = in_abstract
                o["abhead"] = abs_head
                # 过粗的 block（整栏正文）先按行距/缩进切成段落，再进入翻译/排版
                for _piece in _split_coarse_paragraph(o, float(o.get("size") or 0.0)):
                    idx = len(flat)
                    flat.append(_piece)
                    by_page.setdefault(pno, []).append(idx)
    stage_t["extract"] = time.time() - _t0
    _t0 = time.time()
    raws = [f["raw"] for f in flat]
    total = len(raws)

    if not raws:
        warnings.append("未检测到文本层（可能是扫描件）——建议改用「视觉识别」翻译引擎")

    # ---- 分类 + 技能（每种内容类型对应一个可配置 skill） ----
    # 正文字号：取「**较长文本块**」的众数。
    # 图注/坐标轴标签通常只有几个字、字号更小，按全部块统计会把正文挤掉 ——
    # 之前这篇论文就被判成 6.0，于是 8.3pt 的正文全被当成「标题」，
    # 标题技能要求「短、不加标点」→ 译文碎句、丢标点。
    _long_sizes = [
        float(f.get("size") or 0.0)
        for f in flat
        if (f.get("size") or 0.0) > 0
        and len((f.get("raw") or "").strip()) >= 80
        and not f.get("fig_internal")
    ]
    _all_sizes = [float(f.get("size") or 0.0) for f in flat if (f.get("size") or 0.0) > 0]
    _pool = _long_sizes or _all_sizes
    body_size = (
        float(Counter(round(s, 1) for s in _pool).most_common(1)[0][0]) if _pool else 12.0
    )

    # 病态页：矢量图元极多时 `apply_redactions` 会退化到分钟级（实测 37,711 个图元的
    # 单页要 249s，MuPDF 需重写整页内容流）。这类页**保留原文**：既不送模型，
    # 也不擦除/回填，只记一条告警，避免整篇翻译被一页卡死。
    if heavy_page_override:
        max_draws = 1_000_000_000
    else:
        try:
            max_draws = int(os.environ.get("PAPERDESK_MAX_PAGE_DRAWINGS", "2000"))
        except ValueError:
            max_draws = 2000
    heavy_pages = {p for p, c in draw_count_by_page.items() if c > max_draws}

    # ---- 表格/带框区域：必须在「合段」之前检测 ----
    # 以前检测发生在合段之后，且只接受「内部字号明显小于正文」的框：
    #   * 与正文同字号的表格被当成正文整表翻译，长译文直接压坏表格；
    #   * 没有竖线的三线表（booktabs）被 find_tables 默认策略漏掉，单元格还会与
    #     上下正文合并成一段，擦除/回填后表格内容消失或错位。
    # 现在：先检测再合段。表格区域既是「合段屏障」也是「不擦除/不覆盖」的保护区；
    # 表格内文字保留原排版，表格之外的正文照常翻译。
    def _table_regions(
        page, body: float, draws: list | None = None, want_find: bool = True
    ) -> list[fitz.Rect]:
        """检测表格/带框区域（不依赖「内部字号更小」）。

        两类证据：
        1) 线条聚类：>=2 条横线 + >=2 条竖线，或 >=3 条同宽横线；
           覆盖三线表/无竖线表格（find_tables 默认策略只认竖线网格会漏）。
        2) find_tables 网格（row_count>=2 且 col_count>=2）：单元格文字通常短，
           借此与「分栏正文」区分，允许单元格字号等于正文。
        """
        out: list[fitz.Rect] = []
        try:
            _pr = fitz.Rect(page.rect)
        except Exception:  # noqa: BLE001
            return out
        _page_area = max(1.0, _pr.get_area())

        def _add(rr: fitz.Rect) -> None:
            if rr.is_empty or rr.get_area() < 1200 or rr.get_area() > 0.85 * _page_area:
                return
            for _old in out:
                if (_old & rr).get_area() >= 0.7 * rr.get_area():
                    return
            out.append(rr)

        # ---- 1) 线条聚类 ----
        _hs: list[fitz.Rect] = []
        _vs: list[fitz.Rect] = []
        for _d in draws or []:
            _dr = _d.get("rect")
            if _dr is None:
                continue
            try:
                _rr = fitz.Rect(_dr)
            except Exception:  # noqa: BLE001
                continue
            if _rr.width >= 30 and _rr.height <= 3.0:
                _hs.append(_rr)
            elif _rr.height >= 30 and _rr.width <= 3.0:
                _vs.append(_rr)
        _hs.sort(key=lambda r: (round(r.x0, 1), r.y0))
        _groups: list[list[fitz.Rect]] = []
        for _r in _hs:
            for _g in _groups:
                if abs(_r.x0 - _g[0].x0) <= 8 and abs(_r.x1 - _g[0].x1) <= 8:
                    _g.append(_r)
                    break
            else:
                _groups.append([_r])
        for _g in _groups:
            _g.sort(key=lambda r: r.y0)
            _x0 = min(r.x0 for r in _g)
            _x1 = max(r.x1 for r in _g)
            if _x1 - _x0 < 100:
                continue
            _runs: list[list[float]] = []
            _run: list[float] = []
            for _r in _g:
                if _run and _r.y0 - _run[-1] > 60:
                    _runs.append(_run)
                    _run = []
                _run.append(_r.y0)
            if _run:
                _runs.append(_run)
            for _run in _runs:
                if len(_run) < 2:
                    continue
                _vcount = sum(
                    1
                    for r in _vs
                    if r.x0 >= _x0 - 10
                    and r.x1 <= _x1 + 10
                    and r.y0 <= _run[0] + 40
                    and r.y1 >= _run[-1] - 40
                )
                if len(_run) >= 2 and _vcount >= 2:
                    pass  # 横竖线网格
                elif len(_run) >= 3:
                    pass  # 三线表/只有横线的表格
                else:
                    continue
                _rr = fitz.Rect(
                    max(_pr.x0, _x0 - 3.0),
                    max(_pr.y0, _run[0] - 3.0),
                    min(_pr.x1, _x1 + 3.0),
                    min(_pr.y1, _run[-1] + 3.0),
                )
                if _rr.height < 24:
                    continue
                _add(_rr)

        # ---- 2) find_tables 网格（只在闸门命中时跑，避免全篇昂贵检测）----
        if not want_find:
            return out
        try:
            import contextlib
            import io as _io

            with contextlib.redirect_stdout(_io.StringIO()):
                found = page.find_tables()
        except Exception:  # noqa: BLE001
            return out
        for _t in getattr(found, "tables", []):
            try:
                _rr = fitz.Rect(_t.bbox)
            except Exception:  # noqa: BLE001
                continue
            _nr = int(getattr(_t, "row_count", 0) or 0)
            _nc = int(getattr(_t, "col_count", 0) or 0)
            if _nr < 2 or _nc < 2:
                continue
            if _rr.get_area() < 1200 or _rr.get_area() > 0.85 * _page_area:
                continue
            try:
                _inner = page.get_text("dict", clip=_rr)
            except Exception:  # noqa: BLE001
                continue
            # 单元格文字通常短；整框都是长句 → 更像“带框的两栏正文”，不保护
            _spans = 0
            _short = 0
            for _bb in _inner.get("blocks", []):
                if _bb.get("type") != 0:
                    continue
                for _ln in _bb.get("lines", []):
                    for _sp in _ln.get("spans", []):
                        _tx = (_sp.get("text") or "").strip()
                        if not _tx:
                            continue
                        _spans += 1
                        if len(_tx) <= 40:
                            _short += 1
            if _spans < 3 or _short < max(2, int(_spans * 0.5)):
                continue
            _add(_rr)
        return out

    # 表格检测：先按「线条/题注闸门」决定是否跑 find_tables；规则聚类始终可用（便宜）
    _tbl_caption_re = re.compile(r"(?i)^\s*(?:table|tab\.)\s*\d|^\s*表\s*\d")
    table_rects_by_page: dict[int, list[fitz.Rect]] = {}
    for _p in range(doc.page_count):
        if cancelled():
            raise RuntimeError("已取消")
        if _p in heavy_pages:
            table_rects_by_page[_p] = []
            continue
        _lines = (page_texts[_p] if _p < len(page_texts) else "").splitlines()
        _want_find = (not skip_rects) and (
            bool(table_gate.get(_p)) or any(_tbl_caption_re.match(_ln) for _ln in _lines)
        )
        table_rects_by_page[_p] = _table_regions(
            doc[_p], body_size, draws_by_page.get(_p, []), _want_find
        )

    # 角色判定要在 body_size 之后（作者/栏目的判定依赖它）
    for _f in flat:
        _f["roleHint"] = _role_hint(
            _f.get("raw") or "",
            float(_f.get("size") or 0.0),
            body_size,
            int(_f.get("pno") or 0),
            _f.get("rect"),
            float(_f.get("ph") or 0.0),
            float(_f.get("pageMaxSize") or 0.0),
        )

    # ---- 行块 → 段落（翻译前合并）----
    # 双栏论文里 PyMuPDF 常给「一行一个块」：逐行翻译会切碎句子/丢标点，
    # 而且行块只有一行高，译文稍长就被压到 4–5pt。合并成段后再翻译与排版。
    figs_by_page: dict[int, list] = {}
    for fg in figs:
        figs_by_page.setdefault(int(fg["pno"]), []).append(fg["rect"])
    for _p, _regs in fig_regions_by_page.items():
        figs_by_page.setdefault(int(_p), []).extend(_regs)
    # 表格区域也是「合段屏障」：防止单元格文字被并进表格上下的正文段落
    for _p, _regs in table_rects_by_page.items():
        if _regs:
            figs_by_page.setdefault(int(_p), []).extend(_regs)
    _merged = _merge_flat_paragraphs(flat, figs_by_page, body_size)
    if len(_merged) != len(flat):
        flat = _merged
        by_page = {}
        for _i, _f in enumerate(flat):
            by_page.setdefault(_f["pno"], []).append(_i)
        raws = [f["raw"] for f in flat]
        total = len(raws)

    # ---- 术语表：尽早发出请求，与后面的保护/引用清洗**重叠** ----
    # 术语抽取本身要一次 5~8s 的模型请求。串行放在翻译前，等于每篇论文白等一次；
    # 这里在分析阶段（合段完成、正文文本已定稿）就发出，翻译前只等它剩余的部分。
    # 失败时保持原行为：不加术语约束，也绝不阻断翻译。
    _gloss_terms: list[tuple[str, str]] = []
    _gloss_thread: threading.Thread | None = None
    _gloss_error: list[str] = []
    if backend == "openai" and raws and auto_glossary and base_url and api_key:
        _gloss_sample = "\n".join(t for t in raws[:48] if t)

        def _gloss_worker() -> None:
            try:
                _gloss_terms.extend(
                    extract_glossary(
                        _gloss_sample,
                        target_lang,
                        base_url,
                        api_key,
                        model,
                        headers,
                        cache_dir=os.path.dirname(out) or None,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                _gloss_error.append(str(exc)[:120])

        _gloss_thread = threading.Thread(
            target=_gloss_worker, name="pd-glossary", daemon=True
        )
        _gloss_thread.start()

    # 段落编号（栏内顺序）：翻译只带 id/role/text，排版信息留在本地
    for _p in sorted(by_page):
        _seq = 0
        for _i in sorted(by_page[_p], key=lambda k: (flat[k].get("columnId") or "", flat[k]["rect"].y0)):
            flat[_i]["paragraphId"] = f"p{_p}-g{_seq}"
            _seq += 1

    # 行内公式（抽取已损坏）→ 占位符；译完还原，避免被模型编成 `p(h???1)`
    for _f in flat:
        _f["masked"], _f["math"] = _mask_math(_f.get("rawClean") or _f["raw"])
    tin = [f.get("masked") or f["raw"] for f in flat]

    # 正文所用字体家族（长文本块的众数）：与它不同的字体基本就是图/表内容
    _long_fonts = [
        f.get("font") or ""
        for f in flat
        if len((f.get("raw") or "").strip()) >= 80 and not f.get("fig_internal") and f.get("font")
    ]
    body_font = Counter(_long_fonts).most_common(1)[0][0] if _long_fonts else ""

    # 每页的主导字体：用于区分「图内文字（与正文不同）」和「整页换字体的正文」
    page_font: dict[int, str] = {}
    for _p, _idx in by_page.items():
        _cnt: Counter = Counter()
        for _i in _idx:
            _f = flat[_i]
            if (_f.get("raw") or "").strip() and _f.get("font"):
                _cnt[_f["font"]] += len(_f["raw"])
        page_font[_p] = _cnt.most_common(1)[0][0] if _cnt else ""

    kind: list[str] = [
        _classify_block(f, body_size, body_font, page_font.get(f.get("pno", 0), ""))
        for f in flat
    ]

    skills = load_skills(skills_dir)
    default_skill: dict = skills.get("body", {})

    def _skill_for(k: str) -> dict:
        # 图形内部文本：内置「保持原样」策略（用户不可配置，规则要求图形不得改动）
        if k == "figure":
            return {"match": "figure", "skip": True, "scope": "all"}
        # 元信息类角色（DOI/URL/作者/单位/栏目）：默认原样保留
        if k in ("doi", "url", "authors", "affiliation", "article-type"):
            return {"match": k, "skip": True, "scope": "all"}
        return skills.get(k) or default_skill

    # 应用 scope（全文 / 仅首页 / 第 2 页起）：超出 scope 的类型回退为 body
    eff_kind: list[str] = []
    for i, f in enumerate(flat):
        sk = _skill_for(kind[i])
        scope = sk.get("scope") or "all"
        in_scope = (
            scope == "all"
            or (scope == "first" and f.get("pno") == 0)
            or (scope == "rest" and (f.get("pno") or 0) > 0)
        )
        eff_kind.append(kind[i] if in_scope else "body")

    # 角色/动作：写入对象（供调试、HTML 与上层核对）
    for _i, _f in enumerate(flat):
        _f["role"] = eff_kind[_i]
        _f["action"] = "preserve" if _skill_for(eff_kind[_i]).get("skip") else "translate"

    # 当前章节名（供 {section} 变量）
    sections: list[str] = []
    cur_sec = ""
    for i, f in enumerate(flat):
        if eff_kind[i] == "heading" and len(f["raw"]) <= 80:
            cur_sec = _clean_para(f["raw"])
        sections.append(cur_sec)

    # ---- 统一保护层：保护规则**不依赖调用方是否传 skipRects** ----
    # 模块层只是保护区域的其中一个来源。任何入口（送模型 / 擦除 / 重绘）都读同一份
    # skip_mask：缺少模块信息时**不能**解释为「没有需要保护的区域」。

    # 模块层给出的「不翻译区域」（底边原点）→ 先折算成 PDF 坐标，供下面统一使用
    for _f in flat:
        _f["mod_skip"] = False
        _ph0 = float(_f.get("ph") or 0.0)
        for _r in (skip_rects or {}).get(str(_f["pno"])) or []:
            try:
                x0, y0, x1, y1 = (float(v) for v in _r)
            except Exception:  # noqa: BLE001
                continue
            _rr = fitz.Rect(x0, _ph0 - y1, x1, _ph0 - y0)
            _inter = _rr & _f["rect"]
            if _inter.is_empty:
                continue
            if _inter.get_area() >= 0.6 * max(1.0, _f["rect"].get_area()):
                _f["mod_skip"] = True
                break

    # 病态页在合段前已按 draw_count_by_page 算好（heavy_pages），写回阶段复用同一份集合。
    protect_by_page: dict[int, list[fitz.Rect]] = {}
    for _p in range(doc.page_count):
        if cancelled():
            raise RuntimeError("已取消")
        _rects: list[fitz.Rect] = []
        _ph = float(doc[_p].rect.height)
        # 模块层（底边原点）→ PDF 坐标
        for _r in (skip_rects or {}).get(str(_p)) or []:
            try:
                x0, y0, x1, y1 = (float(v) for v in _r)
            except Exception:  # noqa: BLE001
                continue
            _rects.append(fitz.Rect(x0, _ph - y1, x1, _ph - y0))
        for _fg in figs:
            if _fg["pno"] == _p:
                _rects.append(_fg["rect"])
        _rects.extend(fig_regions_by_page.get(_p, []))
        protect_by_page[_p] = _rects

    def _table_overlap(f: dict) -> float:
        """块落在表格区域内的面积比例（表格区域在合段前已检测，见 table_rects_by_page）。"""
        area = f["rect"].get_area()
        if area <= 0:
            return 0.0
        best = 0.0
        for _r in table_rects_by_page.get(int(f.get("pno") or 0), []):
            _it = _r & f["rect"]
            if _it.is_valid:
                best = max(best, _it.get_area() / area)
        return best

    def _protected(f: dict, kind_i: str) -> bool:
        if f.get("cap"):  # 图注/表题：单独翻译
            return False
        if kind_i in ("figure", "formula", "margin"):
            return True
        # 表格单元格：字号等于正文也要保护，否则整张表会被译文覆盖/重排挤坏。
        # 表题/图注（cap）已在上面排除，继续按普通文本翻译。
        if _table_overlap(f) >= 0.5:
            return True
        area = f["rect"].get_area()
        if area <= 0:
            return False
        best = 0.0
        for _r in protect_by_page.get(int(f.get("pno") or 0), []):
            _it = _r & f["rect"]
            if _it.is_valid:
                best = max(best, _it.get_area() / area)
        if best < 0.6:
            return False
        # 图/表内部的小字、标签 → 保护；正文尺寸的句子即使压线也照常翻译
        return (f.get("size") or 0.0) < (body_size or 12.0) * 0.92 or _label_like_text(
            f.get("raw") or ""
        )

    skip_mask: list[bool] = []
    for _i, _f in enumerate(flat):
        skip_mask.append(
            bool(_skill_for(eff_kind[_i]).get("skip"))
            or bool(_f.get("fig_internal"))
            or bool(_f.get("mod_skip"))
            or int(_f.get("pno") or 0) in heavy_pages
            or _protected(_f, eff_kind[_i])
        )
    citations_removed = _apply_citation_filter(flat, eff_kind, skip_mask)
    formula_preserved = sum(
        1 for _i, _f in enumerate(flat) if skip_mask[_i] and (_f.get("math_ratio") or 0) >= 0.12
    )
    # 只有「类别无法确定」的字符（U+FFFD / 私用区）才算近似；
    # 花体/双线体等有码位的变体现在会原样保留，不再计入。
    formula_approx = sum(
        1
        for _i, _f in enumerate(flat)
        if not skip_mask[_i] and bool(_MATH_LOST_RE.search(_f.get("raw") or ""))
    )

    stage_t["analyze"] = time.time() - _t0
    _t0 = time.time()
    translated: list[str] = [f["raw"] for f in flat]  # 默认保留原文
    report("translating", 0, total)

    prog_done = 0
    req_total_s = 0.0
    req_count = 0
    failed_batches = 0
    retry_count = 0
    plan: list = []  # 仅在 openai 分支填充；timing 统计需要它不未定义
    glossary_terms: list[tuple[str, str]] = []  # 术语表（用户 + 自动），供 QA 展示
    if backend == "openai" and raws:
        # 分组：默认只按内容类型（同类型的 system prompt 相同）。以前按 (类型, 章节)
        # 分组，导致请求数被「章节数 × 类型数」放大：30 页论文会从 20 多个请求膨胀到
        # 100 多个，每个请求都要白付一次单请求延迟（开思考时 40s+）。
        # 仅当用户自定义 prompt 真的用到 {section} 时才按章节拆组（行为保持）。
        _uses_section = any("{section}" in str(sk.get("system") or "") for sk in skills.values())
        groups: dict[tuple[str, str], list[int]] = dict(
            group_translation_items(eff_kind, sections, skip_mask, _uses_section)
        )

        # ---- 术语表：先定全篇译法，再翻译（一次请求 + 落盘缓存）----
        # 用户自定义条目优先，自动抽取的补在后面；两者都注入每个 system prompt。
        if cancelled():
            raise RuntimeError("已取消")
        _user_terms = parse_glossary(glossary)
        _auto_terms: list[tuple[str, str]] = []
        if auto_glossary:
            if _gloss_thread is not None:
                # 只等它剩余的部分（前面的分析阶段已经与请求重叠）
                while _gloss_thread.is_alive():
                    if cancelled():
                        raise RuntimeError("已取消")
                    _gloss_thread.join(timeout=0.2)
                _auto_terms = list(_gloss_terms)
                if _gloss_error:
                    try:
                        sys.stderr.write(f"[translate] 术语抽取失败（忽略）：{_gloss_error[0]}\n")
                    except Exception:  # noqa: BLE001
                        pass
            else:
                _sample = "\n".join(t for t in raws[:48] if t)
                _auto_terms = extract_glossary(
                    _sample,
                    target_lang,
                    base_url,
                    api_key,
                    model,
                    headers,
                    cache_dir=os.path.dirname(out) or None,
                )
        glossary_terms: list[tuple[str, str]] = []
        _seen_terms: set[str] = set()
        for _en, _zh in list(_user_terms) + list(_auto_terms):
            _k = _en.lower()
            if _k in _seen_terms:
                continue
            _seen_terms.add(_k)
            glossary_terms.append((_en, _zh))
        _gloss_line = ""
        if glossary_terms:
            _gloss_line = (
                " Use these EXACT translations for technical terms so the whole paper stays "
                "consistent: " + "; ".join(f"{en}={zh}" for en, zh in glossary_terms) + "."
            )

        # 每个 (kind, section) 组只做一次 system 变量替换，供各分块共享
        system_by_group: dict[tuple[str, str], str] = {}
        for k, sec in groups:
            system_by_group[(k, sec)] = (
                str(_skill_for(k).get("system") or "")
                .replace("{lang}", target_lang)
                .replace("{title}", doc_title or "")
                .replace("{authors}", doc_authors or "")
                .replace("{section}", sec if _uses_section else "")
                # 译文过长是「重叠/溢出」的主因：统一要求简洁，不扩写
                + " Keep the translation concise and faithful; do not expand or add explanations."
                + _gloss_line
                + terminology
            )

        # 全局展开：所有组的全部块进入同一个线程池并行
        # ---- 自适应批大小 ----
        # 单请求耗时随段数增长远快于线性（实测 4 段≈42s、8 段≈61s、16 段≈127s），
        # 而并发近乎免费。最优策略是「请求数不超过并发数（一波打完），且批尽量小」：
        # 批越小单请求越快，一波打完则总耗时≈单个请求耗时。
        if batch_size is None:
            BATCH = pick_batch_size(
                [len(v) for v in groups.values()], max(1, int(max_workers or 4)), cap=16
            )
        else:
            BATCH = max(1, min(64, int(batch_size)))
        plan = build_chunk_plan(
            [(k, system_by_group[(k, sec)], idxs) for (k, sec), idxs in groups.items()],
            BATCH,
        )
        # 粗译：**先交摘要/标题，再交结论**，让读者最早看到最关心的内容
        if COARSE and plan:

            def _prio(item: dict) -> int:
                _idx = item["indices"]
                if any(flat[i].get("pno") == 0 for i in _idx):
                    return 0
                _sec = (sections[_idx[0]] or "").lower() if _idx else ""
                if any(w in _sec for w in ("conclusion", "conclusions", "discussion", "结论")):
                    return 1
                return 2

            plan.sort(key=_prio)

        def _do_item(item: dict) -> list[str]:
            nonlocal req_total_s, req_count
            t0 = time.time()
            try:
                marked = [_marked_sentences(tin[i]) for i in item["indices"]]
                values = _openai_translate_many(
                    [text for text, _sentences in marked],
                    target_lang,
                    base_url,
                    api_key,
                    model,
                    headers,
                    system=(item["system"] or "") + " Preserve every ⟪PD-Sn⟫ sentence marker exactly once in its original order. Translate each marked sentence using the full paragraph context, but do not merge or move text across markers. Never add these markers yourself.",
                    ids=[flat[i]["id"] for i in item["indices"]],
                    no_think=no_think,
                )
                cleaned = []
                for idx, value, (_marked, source_parts) in zip(item["indices"], values, marked):
                    if not source_parts:
                        cleaned.append(value)
                        continue
                    text, parts = _unmark_sentences(value, len(source_parts))
                    if parts:
                        flat[idx]["translatedSentences"] = parts
                    cleaned.append(text)
                return cleaned
            finally:
                req_total_s += time.time() - t0
                req_count += 1

        ok = 0
        # 配置类错误（鉴权/地址/连不上）：重试没有意义，直接快速失败。
        # 以前靠一个**串行预检请求**承担这个职责，但开思考时它自己要等 20~40s，
        # 等于每篇论文白付一次整请求延迟；现在改为「第一个失败结果即判定」。
        _FATAL_RE = re.compile(
            r"HTTP (?:401|403|404)\b|Invalid credential|未配置翻译密钥|未配置模型服务|"
            r"Name or service not known|getaddrinfo|ConnectError|SSLError|"
            r"missing x-opencode-session",
            re.IGNORECASE,
        )

        def _fatal_message(msg: str) -> str | None:
            return msg if _FATAL_RE.search(msg or "") else None

        if plan:
            workers = max(1, min(int(max_workers or 4), len(plan)))
            # 粗译：异常段落最多补试一次（不阻塞整篇）
            n_retries = 1 if COARSE else max(0, int(retries))
            # 不用 with：卡死/取消时不能用 wait=True 把整篇拖住（在途 HTTP 最长 60s/个）
            pool = ThreadPoolExecutor(max_workers=workers)
            try:
                # value: [work item, attempts already done]
                pending: dict = {pool.submit(_do_item, item): [item, 0] for item in plan}
                # 真正的「无进展」超时：每 5s 醒来检查一次取消/进展，
                # 而不是 as_completed(timeout=) 的「总时长」上限（长任务会被误杀）。
                STALL_S = 240.0
                last_progress = time.monotonic()
                while pending:
                    if cancelled():
                        raise RuntimeError("已取消")
                    done, _ = wait(pending, timeout=5.0, return_when=FIRST_COMPLETED)
                    if not done:
                        if time.monotonic() - last_progress <= STALL_S:
                            continue
                        # 连续 STALL_S 秒没有任何分块完成 → 判定卡死：保留原文并结束
                        for fut, pair in list(pending.items()):
                            item = pair[0]
                            fut.cancel()
                            warnings.append(
                                "翻译空闲超时（%ds 无进展），已保留原文：%s"
                                % (int(STALL_S), item.get("key", ""))
                            )
                            prog_done += len(item["indices"])
                            report(
                                "translating:%s" % item.get("key", ""),
                                min(prog_done, total),
                                total,
                            )
                        pending.clear()
                        break
                    last_progress = time.monotonic()
                    for fut in done:
                        item, attempt = pending.pop(fut)
                        if cancelled():
                            raise RuntimeError("已取消")
                        ch = item["indices"]
                        try:
                            vals = fut.result()
                            for i, v in zip(ch, vals):
                                translated[i] = v
                            ok += 1
                            prog_done += len(ch)
                            report(
                                f"translating:{item['key']}",
                                min(prog_done, total),
                                total,
                            )
                        except Exception as exc:  # noqa: BLE001
                            msg = str(exc)[:200]
                            fatal = _fatal_message(msg)
                            # 只在「还没有任何成功」时判定为配置错误并中止：
                            # 跑到一半偶发的连接抖动不应该让整篇失败。
                            if fatal and ok == 0:
                                raise RuntimeError(
                                    f"模型服务不可用：{fatal}。请检查「设置」里的 "
                                    "Base URL / API Key / 模型名，或网络/代理。"
                                ) from exc
                            if attempt < n_retries:
                                if cancelled():
                                    raise RuntimeError("已取消")
                                retry_count += 1
                                # 指数退避：0.8s, 1.6s, 3.2s ...
                                time.sleep(0.8 * (2**attempt))
                                pending[pool.submit(_do_item, item)] = [item, attempt + 1]
                            elif len(ch) > 1:
                                # 兜底：**整批失败/段数不符 -> 对半拆开再试**（16→8→4…），
                                # 而不是拆成单段：拆成单段会让一次抖动变成 N 次串行请求，
                                # 每段都要重新等一次完整延迟（开思考时尤其致命）。
                                if cancelled():
                                    raise RuntimeError("已取消")
                                retry_count += 1
                                mid = len(ch) // 2
                                for part in (ch[:mid], ch[mid:]):
                                    sub = dict(item)
                                    sub["indices"] = part
                                    pending[pool.submit(_do_item, sub)] = [sub, attempt + 1]
                            else:
                                failed_batches += 1
                                warnings.append(f"批量翻译失败：{msg[:180]}")
                                prog_done += len(ch)
                                report(
                                    f"translating:{item['key']}",
                                    min(prog_done, total),
                                    total,
                                )
            finally:
                # 不等待在途请求：它们可能各自卡到 60s；卡死/取消必须能尽快返回。
                try:
                    pool.shutdown(wait=False, cancel_futures=True)
                except TypeError:  # Python < 3.9
                    pool.shutdown(wait=False)

        if ok == 0 and groups:
            raise RuntimeError(warnings[-1] if warnings else "模型服务调用失败")
    else:
        cache: dict[str, str] = {}
        for i, t in enumerate(tin):
            if skip_mask[i]:
                continue
            if cancelled():
                raise RuntimeError("已取消")
            if t in cache:
                translated[i] = cache[t]
            else:
                try:
                    v = translate_text(
                        t, backend, target_lang, base_url, api_key, model, headers, no_think=no_think
                    )
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"翻译失败，保留原文: {str(exc)[:100]}")
                    v = raws[i]
                cache[t] = v
                translated[i] = v
            report(f"translating:{eff_kind[i]}", i + 1, total)

    stage_t["translate"] = time.time() - _t0
    _t0 = time.time()

    # ---- 还原行内公式占位符（⟦n⟧ → 可读符号）----
    # 同时校验：模型可能把占位符吞掉 → 数学符号丢失，必须记账（不静默）。
    formula_dropped, formula_missing, formula_unreliable = _restore_formula_placeholders(
        flat, translated
    )

    # ---- 第三遍：覆盖原文并回填译文（跳过类型的块完全不动） ----
    report("writing", 0, total)
    stuck_pages = 0
    write_stats: dict = {}
    empty_tr = 0
    # 译文 4pt 仍放不下 → 回填原文（不空白、但未落译文）的块数
    fell_back = 0
    fallback_failed = 0
    # 放不下的译文按**源页**归档（不追加到文末，保证页数 1:1）
    overflow_by_page: dict[int, list[dict]] = {}
    # 块级映射：源矩形 -> 实际落版矩形（跨窗高亮/定位用；页内重排后仍能对上）
    layout_map: list[dict] = []
    # ---- 按页验收：只针对「应翻译的正文块」 ----
    # 放不下的译文/被保护的块会保留原文 → 用户看到「有的页面没翻译」。写回阶段按页
    # 记账（应写 / 实际写入 / 原文未覆盖），保存后逐页核对并自动打回重译（见下方验收段）。
    VERIFY_KINDS = ("body", "abstract", "caption", "heading")
    VERIFY_MIN_LEN = 30

    def _verify_idx(i: int) -> bool:
        """该块是否属于「必须翻译的正文」：正文类、未跳过、原文长度足够。"""
        if skip_mask[i]:
            return False
        if kind[i] not in VERIFY_KINDS:
            return False
        return len((flat[i].get("raw") or "").strip()) >= VERIFY_MIN_LEN

    # ---- 回填：单页一个函数，累加器走 acc，便于按页分片并行 ----
    def _new_acc() -> dict:
        return {
            "overflow": {},
            "layout": [],
            "stuck": 0,
            "stats": {},
            "blocks": 0,
            "empty": 0,
            "fell_back": 0,
            "fallback_failed": 0,
            # 按页验收计数：页号(1-based) -> 应翻译正文块 / 成功写入块 / 原文未覆盖
            "page_expected": {},
            "page_written": {},
            "page_stuck": {},
            # 行内公式：未能可靠还原的 LaTeX 命令（去重），用于报告「公式存在限制」
            "math_unmapped": [],
        }

    def _write_page(page, pno, acc: dict) -> None:
        """单页：障碍计算 + 擦除 + 回填。只碰本页对象，故可按页并行。"""
        if cancelled():
            raise RuntimeError("已取消")
        idxs = by_page.get(pno, [])
        if not idxs:
            return
        keep = [i for i in idxs if not skip_mask[i]]
        if not keep:
            return
        # 本页「应翻译的正文块」：验收分母。keep 里本来就没有被跳过的块。
        _body_keep = [i for i in keep if _verify_idx(i)]
        if _body_keep:
            acc["page_expected"][pno + 1] = len(_body_keep)
        # 严格模式：段顶固定、宽度不越过原段、不回收空白
        _strict = layout == "strict"
        # 固定障碍：跳过块（页眉/公式/参考文献/图形内部文本）、图片、矢量图形区域
        # 硬障碍：跳过块（页眉/公式/图内文字/参考文献）→ 只要求译文**别往下压到它**
        hard_obstacles: list = []
        for i in idxs:
            if skip_mask[i]:
                hard_obstacles.append(flat[i]["rect"])
        # 「强障碍」：参考文献/标题。即使它们的顶边落在正文块 bbox 内部（常见于
        # 段落末尾带了空白行、标题被并进同一个 block），也不能把译文画上去。
        strong_obstacles: list = []
        for i in idxs:
            if not skip_mask[i]:
                continue
            if kind[i] in ("heading", "reference", "formula") or flat[i].get("refsec"):
                strong_obstacles.append(flat[i]["rect"])
        # 待写块：PyMuPDF 偶尔给出**纵向重叠**的两块（算法/公式旁的正文），
        # 对它们要用更严格的限制，否则译文会直接压上去。
        text_obstacles: list = []
        for i in keep:
            if flat[i]["rect"] is not None:
                text_obstacles.append(flat[i]["rect"])
        obstacles: list = hard_obstacles + text_obstacles
        for fig in figs:
            if fig.get("pno") == pno:
                obstacles.append(fig["rect"])
        obstacles.extend(fig_regions_by_page.get(pno, []))
        # 表格整框也参与避让：正文回填/压缩时不得伸进表格，否则会压住单元格文字
        obstacles.extend(table_rects_by_page.get(pno, []))
        page_bottom = page.rect.height - 8.0
        all_rects = [flat[i]["rect"] for i in idxs] + obstacles

        # 页内压缩时要避开的区域：图/公式/保留块。不能把正文上移进这些区域。
        image_rects = [fg["rect"] for fg in figs if fg.get("pno") == pno]
        fig_rects = list(fig_regions_by_page.get(pno, [])) + list(
            table_rects_by_page.get(pno, [])
        )
        page_blockers = list(hard_obstacles) + image_rects + fig_rects
        # 再兜一层：矢量绘制（线/框/箭头）也算障碍，避免上移时压到图里。
        # `_figure_regions` 只识别「像图」的聚合区域，细线图可能漏检。
        # 但整页背景矩形不算（很多 PDF 会画一层白色底，否则会禁止整页压缩）。
        _page_area = max(1.0, page.rect.width * page.rect.height)
        try:
            for _d in page.get_drawings():
                _dr = _d.get("rect")
                if _dr is None:
                    continue
                _r2 = fitz.Rect(_dr)
                if _r2.width * _r2.height > 0.8 * _page_area:
                    continue
                page_blockers.append(_r2)
        except Exception:  # noqa: BLE001
            pass
        # **向下扩展**的边界：图片、图表区域、保留块。
        # 之前只用了 hard_obstacles（仅含被跳过的文本块），
        # 图片没有文字 → 不在其中，译文变长时会直接压到图上。
        # 这里不加入原始 drawings：正文下的分隔线/下划线会把可用高度压回原框，反而制造截断。
        bottom_blockers = list(hard_obstacles) + image_rects + fig_rects

        # 严格模式：**先测量再擦除**。在临时页面试排，放不下的段落不擦除（保留原文），
        # 完整译文按源页进 overflow；避免"擦掉后发现排不进去"导致正文消失。
        plan_ok: set[int] = set()
        if _strict:
            _plan_doc = fitz.open()
            _plan_page = _plan_doc.new_page(width=page.rect.width, height=page.rect.height)
            for idx in keep:
                _f = flat[idx]
                _r = _f["rect"]
                _top = _r.y0
                _bottom = page_bottom
                for _o in bottom_blockers:
                    if _o == _r:
                        continue
                    if _o.y0 >= _r.y1 - 1.0 and _x_overlap(_o, _r) > 0.25 * min(
                        _r.width or 1.0, _o.width or 1.0
                    ):
                        _bottom = min(_bottom, _o.y0 - 3.0)
                for _o in text_obstacles:
                    if _o == _r:
                        continue
                    if _o.y0 > _r.y0 + 2.0 and _x_overlap(_o, _r) > 0.25 * min(
                        _r.width or 1.0, _o.width or 1.0
                    ):
                        _bottom = min(_bottom, _o.y0 - 3.0)
                for _o in strong_obstacles:
                    if _o == _r:
                        continue
                    if _o.y0 > _r.y0 + 2.0 and _x_overlap(_o, _r) > 0.25 * min(
                        _r.width or 1.0, _o.width or 1.0
                    ):
                        _bottom = min(
                            _bottom,
                            _o.y0 - max(4.0, float(_f.get("size") or 8.0) * 0.55),
                        )
                _right = page.rect.width - 6.0
                for _o in all_rects:
                    if _o == _r:
                        continue
                    if _o.x0 >= _r.x1 - 1.0 and (
                        min(_o.y1, _r.y1) - max(_o.y0, _r.y0)
                    ) > 0.25 * min(_r.height or 1.0, _o.height or 1.0):
                        _right = min(_right, _o.x0 - 4.0)
                _right = min(_right, float(_r.x1) + 6.0)
                _txt = _latex_to_plain(translated[idx] or _f["raw"])
                _col = _pick_text_color(_f.get("color"), _f.get("bg"))
                _box = fitz.Rect(_r.x0, _top, _r.x1, _top + max(_r.height, 1.0))
                if (
                    _MATH_VARIANTS_RE.search(_txt) or any(ch in _txt for ch in "⌈⌉⌊⌋⟨⟩")
                ) and abs(float(_f.get("angle") or 0.0)) < 1.0:
                    _, _, _ovf = _draw_math_box(
                        _plan_page,
                        fitz.Rect(_r.x0, _top, max(_r.x1, _right), _bottom),
                        _txt,
                        float(_f.get("size") or 10.0),
                        _col,
                    )
                    if not _ovf:
                        plan_ok.add(idx)
                else:
                    _ps: dict = {}
                    _fit_text(
                        _plan_page,
                        _box,
                        _txt,
                        _f["nlines"],
                        max_h=_bottom,
                        orig_size=_f.get("size"),
                        max_w=_right,
                        color=_col,
                        stats=_ps,
                        min_size=6.5,
                        angle=float(_f.get("angle") or 0.0),
                        size_delta=float(font_delta or 0.0),
                    )
                    if _ps.get("last_ok", True):
                        plan_ok.add(idx)
            _plan_doc.close()

        # 覆盖检测只针对「本页要覆盖的块」，避免把保留的页眉/参考文献算进去（旧版误报）
        _to_redact = [i for i in keep if (not _strict or i in plan_ok)]

        # 覆盖检测：`get_text(clip=rect)` 每次都会**重建整页 TextPage**，在矢量大页面上
        # 单次要几十毫秒；逐块调用 = 每页几十次重建（30 页论文能拖到 100s+）。
        # 这里每页只建一次 TextPage，所有 clip 复用，擦除后再建一次。
        def _clip_len(tp) -> int:
            total = 0
            for idx in _to_redact:
                try:
                    total += len(
                        page.get_text("text", clip=flat[idx]["rect"], textpage=tp)
                        if tp is not None
                        else page.get_text("text", clip=flat[idx]["rect"])
                    )
                except Exception:  # noqa: BLE001
                    pass
            return total

        try:
            _tp = page.get_textpage()
        except Exception:  # noqa: BLE001
            _tp = None
        before = _clip_len(_tp) if _to_redact else 0
        for idx in _to_redact:
            # fill=None：只擦除文字，不刷底色。旧实现用采样色填充整块矩形，
            # 近白被量化成 0.97 灰 → 译文页上每段都是一块灰色矩形，且空白处也被涂灰。
            # 保留原页面自身的底色/矢量背景，灰块随之消失。
            page.add_redact_annot(flat[idx]["rect"], fill=None)
        if _to_redact:
            _apply_redactions(page)
        if _to_redact:
            try:
                _tp = page.get_textpage()
            except Exception:  # noqa: BLE001
                _tp = None
        after = _clip_len(_tp) if _to_redact else 0
        if before > 60 and after > before * 0.7:
            acc["stuck"] += 1
            # 该页原文没被覆盖 → 本页验收直接判失败（译文会与原文重叠）
            acc["page_stuck"][pno + 1] = True


        # 自上而下回填；与「已写块」水平重叠时按游标重排：
        #   - 上一块写得更长 → 下推（不重叠）
        #   - 上一块写得更短 → **上移回收空白**（中文通常比英文短，否则整页大片空）
        # 上移不能越过图/公式/保留块，否则会盖住它们。
        written: list[tuple[float, float, float]] = []  # (x0, x1, bottom)
        for idx in sorted(keep, key=lambda i: (round(flat[i]["rect"].y0, 1), flat[i]["rect"].x0)):
            if _strict and idx not in plan_ok:
                # 试排放不下：保留原文（未擦除），完整译文进 overflow
                acc["overflow"].setdefault(pno + 1, []).append(
                    {
                        "id": flat[idx].get("id"),
                        "blockId": flat[idx].get("blockId"),
                        "text": _latex_to_plain(translated[idx] or flat[idx]["raw"]),
                    }
                )
                acc["fell_back"] += 1
                continue
            f = flat[idx]
            r = f["rect"]
            cursor: float | None = None
            for wx0, wx1, wb in written:
                if _x_overlap(fitz.Rect(wx0, 0, wx1, 1), r) > 0.25 * min(wx1 - wx0, r.width or 1.0):
                    cursor = wb + 2.0 if cursor is None else max(cursor, wb + 2.0)
            top = r.y0 if (_strict or cursor is None) else cursor
            if (not _strict) and top < r.y0 - 0.5:
                # 上移：若 [top, r.y0] 里有图/公式/保留块，就停在它下面
                for o in page_blockers:
                    if o is r:
                        continue
                    if (
                        o.y1 > top + 0.5
                        and o.y0 < r.y0 - 0.5
                        and _x_overlap(o, r) > 0.25 * min(r.width or 1.0, o.width or 1.0)
                    ):
                        # 与图/公式之间留一点空隙（6pt），避免译文贴着图边
                        top = max(top, min(o.y1 + 6.0, r.y0))
            # 允许的底部：同栏最近的固定障碍物（图片/图表区域/公式/保留块）之上
            bottom = page_bottom
            for o in bottom_blockers:
                if o == r:
                    continue
                # 硬障碍：只有**完全在本块下方**时才限制（图内小标签常落在正文块内部，
                # 不能因此把整段正文压成 4pt 小字）
                if o.y0 >= r.y1 - 1.0 and _x_overlap(o, r) > 0.25 * min(r.width or 1.0, o.width or 1.0):
                    bottom = min(bottom, o.y0 - 3.0)
            # 后续可翻译块也是硬边界：段顶保持原位，不允许被前一段的下推吃掉。
            # 否则前一段很长时，后一段会被推到只剩 1pt（回填失败 → 正文消失）。
            for o in text_obstacles:
                if o == r:
                    continue
                if o.y0 > r.y0 + 2.0 and _x_overlap(o, r) > 0.25 * min(
                    r.width or 1.0, o.width or 1.0
                ):
                    bottom = min(bottom, o.y0 - 3.0)
            # 参考文献/标题：顶边落在块内部也要让开（多留半个字高，
            # 否则最后一行的字形下缘仍可能压到标题上）
            for o in strong_obstacles:
                if o == r:
                    continue
                if o.y0 > r.y0 + 2.0 and _x_overlap(o, r) > 0.25 * min(r.width or 1.0, o.width or 1.0):
                    bottom = min(bottom, o.y0 - max(4.0, float(f.get("size") or 8.0) * 0.55))
            # 待写块（text_obstacles）**不**作为底部硬限界：
            # 它会在下面按 cursor 被下推（页内重排）。旧实现把它当硬障碍，
            # 于是短段落/单行块的译文放不下 → 掉到 4pt 或回填原文。
            # 只有图/公式/跳过块/图表区域这类固定内容才限制底部。
            # 连一行都放不下（标题/公式紧贴正文）：保留原文，不硬挤进去压住它
            if bottom < top + MIN_FONT_SIZE * 1.15:
                acc["stats"]["truncated"] = int(acc["stats"].get("truncated", 0)) + 1
                acc["overflow"].setdefault(f["pno"] + 1, []).append(
                    {"id": f.get("id"), "blockId": f.get("blockId"), "text": translated[idx] or f["raw"]}
                )
                restored = _write_original_back(
                    page,
                    fitz.Rect(r.x0, top, r.x1, max(r.y1, top + 1.0)),
                    f.get("raw") or "",
                    f.get("size"),
                )
                acc["fell_back"] += int(restored)
                acc["fallback_failed"] += int(not restored)
                written.append((r.x0, r.x1, max(r.y1, top + 1.0)))
                continue
            bottom = max(bottom, top + MIN_FONT_SIZE * 1.24)
            # 允许的右侧：同排（y 重叠）右侧最近块的左边（供单行标题/标签使用）
            right = page.rect.width - 6.0
            if _strict:
                # 严格：只用原文段落自己的宽度（+6pt 余量），绝不跨栏/跨区
                right = min(right, float(r.x1) + 6.0)
            for o in all_rects:
                if o == r:
                    continue
                if o.x0 >= r.x1 - 1.0 and (min(o.y1, r.y1) - max(o.y0, r.y0)) > 0.25 * min(r.height or 1.0, o.height or 1.0):
                    right = min(right, o.x0 - 4.0)
            box = fitz.Rect(r.x0, top, r.x1, top + max(r.height, 1.0))
            # 模型有时会把公式写成 LaTeX：画进 PDF 前转成可读符号
            _raw_txt = translated[idx] or f["raw"]
            _draw_txt = _latex_to_plain(_raw_txt)
            _color = _pick_text_color(f.get("color"), f.get("bg"))
            acc["stats"]["last_ok"] = True
            _math_variant = bool(_MATH_VARIANTS_RE.search(_raw_txt)) or any(
                ch in _raw_txt for ch in "⌈⌉⌊⌋⟨⟩"
            )
            _inline_math = (not _math_variant) and has_inline_math(_raw_txt)
            if (
                _math_variant
            ) and math_fontfile() and abs(float(f.get("angle") or 0.0)) < 1.0:
                # 含数学变体（𝒫/ℙ/𝓟…）：用 HTML 混排，中文走 CJK 字体、数学走数学字体，
                # 保证花体/双线体/粗体**类别不混**。代价是排版由 MuPDF 的 HTML 引擎完成。
                _size, used_bottom, _ovf = _draw_math_box(
                    page,
                    fitz.Rect(r.x0, top, max(r.x1, right), bottom),
                    _draw_txt,
                    float(f.get("size") or 10.0) + float(font_delta or 0.0),
                    _color,
                )
                acc["stats"]["last_ok"] = not _ovf
                acc["stats"]["last_truncated"] = bool(_ovf)
                if _ovf:
                    acc["stats"]["truncated"] = int(acc["stats"].get("truncated", 0)) + 1
            elif _inline_math and math_fontfile() and abs(float(f.get("angle") or 0.0)) < 1.0:
                # 行内公式：用 <sup>/<sub> 保留上下标，希腊字母/运算符换成真符号；
                # 仍然放不下不缩字，交给下面的溢出记账（宁可多占一版，不糊成一片）。
                _size, used_bottom, _ovf, _unrep = _draw_inline_math_box(
                    page,
                    fitz.Rect(r.x0, top, max(r.x1, right), bottom),
                    _raw_txt,
                    float(f.get("size") or 10.0) + float(font_delta or 0.0),
                    _color,
                )
                acc["stats"]["math_html"] = int(acc["stats"].get("math_html", 0)) + 1
                if _unrep:
                    for _cmd in _unrep:
                        acc.setdefault("math_unmapped", [])
                        if _cmd not in acc["math_unmapped"]:
                            acc["math_unmapped"].append(_cmd)
                acc["stats"]["last_ok"] = not _ovf
                acc["stats"]["last_truncated"] = bool(_ovf)
                if _ovf:
                    acc["stats"]["truncated"] = int(acc["stats"].get("truncated", 0)) + 1
            else:
                _size, used_bottom = _fit_text(
                    page,
                    box,
                    _draw_txt,
                    f["nlines"],
                    max_h=bottom,
                    orig_size=f.get("size"),
                    max_w=right,
                    color=_color,
                    stats=acc["stats"],
                    # 严格模式的可读下限：不为塞进原框压到 4–5pt
                    min_size=6.5 if _strict else 4.0,
                    angle=float(f.get("angle") or 0.0),
                    size_delta=float(font_delta or 0.0),
                )
            if not (translated[idx] or "").strip():
                acc["empty"] += 1
            if acc["stats"].get("last_truncated"):
                acc["overflow"].setdefault(f["pno"] + 1, []).append(
                    {"id": f.get("id"), "blockId": f.get("blockId"), "text": _draw_txt}
                )
            if acc["stats"].get("last_ok", True):
                acc["blocks"] += 1
                # 按页验收：只有「正文块 + 真的落了非空译文」才计为写入
                if _verify_idx(idx) and (translated[idx] or "").strip():
                    acc["page_written"][pno + 1] = (
                        int(acc["page_written"].get(pno + 1, 0)) + 1
                    )
                written.append((r.x0, r.x1, used_bottom))
                _H = float(page.rect.height)
                # 逐句**行片段**（同句跨行时拆开）：segs 用片段配对，不用并集框
                _src_detail = _segment_pieces(
                    f.get("raw") or "",
                    [
                        (t, fitz.Rect(rr))
                        for t, rr in zip(f.get("lines") or [], f.get("lineRects") or [])
                    ],
                    _split_sentences(f.get("raw") or "") if f.get("translatedSentences") else None,
                )
                _src_info = [(rect, weight) for rect, weight, _ps in _src_detail]
                acc["layout"].append(
                    {
                        "id": f.get("id"),
                        "_sentenceParts": [_restore_math(s, f.get("math") or []) for s in f.get("translatedSentences") or []],
                        "page": f["pno"] + 1,
                        # 与阅读器选区/批注一致：PDF 坐标、**左下原点**
                        "src": [
                            round(r.x0, 2),
                            round(_H - r.y1, 2),
                            round(r.x1, 2),
                            round(_H - r.y0, 2),
                        ],
                        "dst": [
                            round(r.x0, 2),
                            round(_H - used_bottom, 2),
                            round(max(r.x1, right), 2),
                            round(_H - top, 2),
                        ],
                        # 原文文字方向（0=水平）；译文按同一角度落版
                        "angle": round(float(f.get("angle") or 0.0), 2),
                        # 句级片段（同段内按句子切分）。旧字段仅在两侧句数一致时提供；
                        # 新的 segs 用「按长度比例对齐」支持多对多，避免整段高亮。
                        "srcSegs": [
                            [
                                round(x0, 2),
                                round(_H - y1, 2),
                                round(x1, 2),
                                round(_H - y0, 2),
                            ]
                            for (x0, y0, x1, y1), _w in _src_info
                        ],
                        "citations": [
                            {
                                **c,
                                "bbox": [
                                    c["bbox"][0],
                                    _H - c["bbox"][3],
                                    c["bbox"][2],
                                    _H - c["bbox"][1],
                                ],
                            }
                            for c in (f.get("citations") or [])
                        ],
                        "_srcDetail": _src_detail,
                        "_targetText": _draw_txt,
                        "_box": [r.x0, top, max(r.x1, right), used_bottom],
                    }
                )
            else:
                # 译文在此版面放不下（4pt 也溢出）：把**原文**回填同一区域，
                # 页面不会出现无解释的空白；完整译文在 overflow（按源页）。
                restored = _write_original_back(
                    page,
                    fitz.Rect(r.x0, top, r.x1, max(r.y1, top + 1.0)),
                    f.get("raw") or "",
                    f.get("size"),
                )
                acc["fell_back"] += int(restored)
                acc["fallback_failed"] += int(not restored)
                written.append((r.x0, r.x1, max(r.y1, top + 1.0)))

        # 写完后按「译文实际占用的行」生成句级片段：
        # - srcSegs/dstSegs：两侧句数一致时的严格一一对应（旧客户端兼容）；
        # - segs：源/译两侧都拆到**行片段**后按句内比例配对，一句跨两行时给两个紧凑
        #   片段，而不是覆盖两行的并集块（相邻句不再共享 bbox）。旋转块不写 segs：
        #   行序不可靠，「源句→整段译文」正是用户报的整段高亮，此时客户端宁可不亮。
        if acc["layout"]:
            _lines = _page_text_lines(page)
            _H = float(page.rect.height)
            for _ent in acc["layout"]:
                _box = _ent.get("_box")
                if not _box:
                    continue
                _src_detail = _ent.pop("_srcDetail", [])
                _src_info = [(rect, weight) for rect, weight, _ps in _src_detail]
                _target_text = _ent.pop("_targetText", "")
                _sentence_parts = _ent.pop("_sentenceParts", [])
                _ent.pop("_box", None)
                if abs(float(_ent.get("angle") or 0.0)) < 1.0:
                    _bx = fitz.Rect(_box)
                    _lines_in = [p for p in _lines if _bx.intersects(p[1])]
                    _dst_detail = _segment_pieces(_target_text or "", _lines_in, _sentence_parts or None)
                    # 行文本校验：译文在框内被截断、或框里混进邻块的行时，句框会和
                    # 实际文字错位（高亮跳到别的句子）。宁可这次不写 segs（客户端
                    # 不高亮），也不写一份不可信的映射。
                    _trusted = bool(_dst_detail) and _norm_nospace(
                        "".join(t for t, _r in _lines_in)
                    ) == _norm_nospace(_target_text or "")
                    if _trusted:
                        _dst_info = [(rect, weight) for rect, weight, _ps in _dst_detail]
                        if len(_dst_info) == len(_src_info):
                            _ent["dstSegs"] = [
                                [
                                    round(x0, 2),
                                    round(_H - y1, 2),
                                    round(x1, 2),
                                    round(_H - y0, 2),
                                ]
                                for (x0, y0, x1, y1), _w in _dst_info
                            ]
                        # Across languages, character fractions do not establish word meaning.
                        # Keep a whole sentence's line pieces together when boundaries were
                        # explicitly retained by the translator.
                        if _sentence_parts and len(_src_detail) == len(_dst_detail):
                            _pairs = [[s_rect, d_rect] for s, d in zip(_src_detail, _dst_detail)
                                      for s_rect, _sw in s[2] for d_rect, _dw in d[2]]
                        elif backend == "openai":
                            _pairs = []  # unverified boundaries: paragraph mapping only
                            _ent.pop("dstSegs", None)
                            _ent.pop("srcSegs", None)
                        else:
                            _pairs = _align_segments(_src_detail, _dst_detail)
                        if _pairs:
                            _ent["segs"] = [
                                [
                                    [
                                        round(s_rect[0], 2),
                                        round(_H - s_rect[3], 2),
                                        round(s_rect[2], 2),
                                        round(_H - s_rect[1], 2),
                                    ],
                                    [
                                        round(d_rect[0], 2),
                                        round(_H - d_rect[3], 2),
                                        round(d_rect[2], 2),
                                        round(_H - d_rect[1], 2),
                                    ],
                                ]
                                for s_rect, d_rect in _pairs
                            ]
    # ---- 调度：按页串行 ----
    # 试过「按页分片 + 各自 Document + insert_pdf 合并」：结果一致，但**更慢**
    # （5.4s→8.7s）、文件还翻倍（2.2MB→4.5MB，每页各带一份字体子集、合并不去重），
    # 所以保持串行。PyMuPDF 也不是线程安全的，并行只有这一个可行姿势。
    acc_total = _new_acc()
    for _pno in range(doc.page_count):
        if not by_page.get(_pno):
            continue
        _write_page(doc[_pno], _pno, acc_total)
    write_doc = doc

    overflow_by_page = acc_total["overflow"]
    layout_map = acc_total["layout"]
    stuck_pages = acc_total["stuck"]
    empty_tr = acc_total["empty"]
    fell_back = acc_total["fell_back"]
    fallback_failed = acc_total["fallback_failed"]
    write_stats = acc_total["stats"]
    blocks += acc_total["blocks"]
    report("writing", min(blocks, total), total)

    if req_count:
        warnings.append(
            "翻译耗时：%d 个请求，平均 %.1f 秒/请求、%.2f 秒/块（每批 %d 块，并发 %d）"
            % (
                req_count,
                req_total_s / max(1, req_count),
                req_total_s / max(1, prog_done),
                BATCH,
                max(1, min(int(max_workers or 4), len(plan) or 1)),
            )
        )
    if failed_batches:
        warnings.append(f"有 {failed_batches} 个批次失败（已重试），可考虑降低并发或调大批量")
    if empty_tr:
        warnings.append(f"有 {empty_tr} 处译文为空，已保留原文（未丢失，但未翻译）")
    if formula_preserved:
        warnings.append(
            f"有 {formula_preserved} 处公式/公式密集段落按原样保留（未翻译、未擦除），以保证符号正确"
        )
    if formula_approx:
        warnings.append(
            f"有 {formula_approx} 处行内公式的字符类别无法从源 PDF 还原（无 ToUnicode），"
            "已跳过这些符号，请对照原文核对"
        )
    if formula_dropped:
        warnings.append(
            f"有 {formula_dropped} 处行内公式的占位符被模型丢弃（共 {formula_missing} 个符号），"
            "相关段落已保留原文，可使用重译本页或阅读 AI 解释"
        )
    if formula_unreliable:
        warnings.append(
            f"有 {formula_unreliable} 处行内公式的上下标/结构无法可靠还原，"
            "已按近似文本排版——请对照原文核对这几处符号"
        )
    truncated = int(write_stats.get("truncated", 0))
    if truncated:
        warnings.append(
            f"有 {truncated} 处译文在当前版面放不下；成功回填原文 {fell_back} 处，"
            "完整译文按源页写入同名 .overflow.json / Markdown"
        )
    if fallback_failed:
        warnings.append(f"有 {fallback_failed} 处原文回填失败，页面可能缺少正文；请对照原文和 overflow 文件核对")
    if stuck_pages:
        warnings.append(
            f"有 {stuck_pages} 页的原文未能被覆盖（文本可能在嵌套对象里）——"
            "译文会与原文重叠，建议改用「视觉识别」翻译引擎"
        )
    if glossary_terms:
        warnings.append(
            f"术语表：已对 {len(glossary_terms)} 个术语统一译法（"
            + "、".join(f"{en}={zh}" for en, zh in glossary_terms[:6])
            + ("…" if len(glossary_terms) > 6 else "")
            + "）"
        )
    if heavy_pages:
        warnings.append(
            f"有 {len(heavy_pages)} 页图形对象过多（>{max_draws} 个），已保留原文："
            f"第 {'、'.join(str(p + 1) for p in sorted(heavy_pages)[:12])} 页。"
            "这些页面擦除/回填会退化到分钟级，保留原文可避免整篇卡死。"
        )

    # ---- 质量自检（启发式） ----
    qa_skip = [bool(_skill_for(k).get("skip")) for k in eff_kind]
    unchanged = 0
    suspicious = 0
    cite_mismatch = 0
    cjk_target = target_lang.lower().startswith("zh") or target_lang.lower().startswith("z")
    qa_items: list[dict] = []
    for i, t in enumerate(translated):
        if qa_skip[i]:
            continue
        dst = (t or "").strip()
        if _cite_count(raws[i]) != _cite_count(t or ""):
            cite_mismatch += 1
        bad = dst == raws[i].strip()
        if bad:
            unchanged += 1
        if not bad and cjk_target and len(dst) > 30:
            cjk = sum(1 for ch in dst if "\u4e00" <= ch <= "\u9fff")
            if cjk / len(dst) < 0.08:
                bad = True
        if bad and not dst == raws[i].strip():
            suspicious += 1
        if (bad) and len(qa_items) < 40:
            qa_items.append({"page": int(flat[i].get("pno", 0)) + 1, "text": raws[i][:120]})
    qa = {
        "engine": "simple",
        "targetLang": target_lang,
        "total": total,
        "translated": total - sum(qa_skip),
        "skipped": sum(qa_skip),
        "unchanged": unchanged,
        "suspicious": suspicious,
        "citationMismatch": cite_mismatch,
        "items": qa_items,
        "glossary": [list(t) for t in glossary_terms],
    }

    # 放不下的译文**不再追加到文末**（那会改变页数、破坏原文/译文页对应）。
    # 内容按源页写进同名 sidecar，页面数保持 1:1；正常论文经过页内压缩后应为 0。
    # sidecar 在「按页验收/自动重译」之后写：重译成功的页不该再出现在溢出清单里。
    overflow_path = None

    # 块级映射 sidecar 在「按页验收/自动重译」之后再写：重译页的映射要合并进来。
    # 页数必须与原文 1:1（对照阅读按源页对齐；任何新增页都会让后续页整体错位）
    if write_doc.page_count != pages:
        warnings.append(f"页数不一致：原文 {pages} 页 / 译文 {write_doc.page_count} 页（应保持 1:1）")
    try:
        write_doc.subset_fonts()
    except Exception:  # noqa: BLE001
        pass
    # clean=True 会重写每一页的内容流；garbage=3 会做全量对象重编号。两者在普通论文上
    # 只多花 <1s，但在矢量大页面上会退化到分钟级（实测一篇 32MB / 3.7 万图元的文档：
    # clean+garbage3 >400s，而 garbage1+deflate 只要 3.5s）。复杂文档因此降级保存参数。
    _complex_doc = bool(heavy_pages) or sum(draw_count_by_page.values()) > 20000
    write_doc.save(
        out,
        garbage=1 if _complex_doc else 3,
        deflate=True,
        clean=not _complex_doc,
    )
    if write_doc is not doc:
        doc.close()
    write_doc.close()
    stage_t["write"] = time.time() - _t0

    # ---- 按页验收：逐页核对「应翻译的正文块」是否真的落了译文 ----
    # 写回阶段已按页记账（page_expected / page_written / page_stuck）；这里只做计数与
    # 比例判断（便宜），每页一个任务并行。通过条件：正文写入比例 >= 阈值 且 原文已被覆盖。
    # heavy_pages（图形对象过多的整页保留页）不算失败，标注 skipped。
    # 未通过的页自动「打回重译」：最多 N 页，单页临时 PDF 重新翻译后按原页号替换回来。
    _t_verify = time.time()
    try:
        _v_ratio = float(os.environ.get("PAPERDESK_TRANSLATE_VERIFY_RATIO", "0.6"))
    except ValueError:
        _v_ratio = 0.6
    try:
        _v_retry = max(0, int(os.environ.get("PAPERDESK_TRANSLATE_RETRY_PAGES", "3")))
    except ValueError:
        _v_retry = 3
    try:
        _v_workers = max(
            1, min(3, int(os.environ.get("PAPERDESK_TRANSLATE_RETRY_WORKERS", "2")))
        )
    except ValueError:
        _v_workers = 2

    # 页角色（正文/参考文献/附录/首页前言）：只判一次，验收与 UI 共用同一份结论
    _page_roles = _page_roles_from_texts(page_texts)

    def _reference_like_page(page_no: int) -> bool:
        """参考文献页常没有标题（跨页续排），用「编号条目 + 年份」密度识别。

        这类页的红线框覆盖检测容易把嵌套文本/链接算成未覆盖，进而误报
        「正文未正常翻译」；只对已判定 stuck 的页面跳过验收，避免掩盖真正的正文失败。
        """
        _txt = (
            page_texts[page_no - 1][:1600]
            if 0 <= page_no - 1 < len(page_texts)
            else ""
        )
        return _looks_like_reference_page(_txt)

    def _verify_one_page(page_no: int) -> dict:
        # page_no 为 1-based 页号（与 acc 里的记账键、heavy_pages+1 一致）
        _pno0 = page_no - 1
        _exp = int(acc_total["page_expected"].get(page_no, 0))
        _wrt = int(acc_total["page_written"].get(page_no, 0))
        _stuck = bool(acc_total["page_stuck"].get(page_no))
        _role = _page_roles[_pno0] if 0 <= _pno0 < len(_page_roles) else "body"
        _verdict = _page_verdict(
            _role,
            _exp,
            _wrt,
            _stuck,
            _v_ratio,
            heavy=_pno0 in heavy_pages,
            # 页角色没判成参考文献、但内容明显是条目列表时，stuck 也不报正文失败
            ref_like_stuck=bool(
                _stuck and _role == "body" and _reference_like_page(page_no)
            ),
        )
        return {"page": page_no, **_verdict}

    # 参考文献页也要进验收清单：不是为了重译，而是为了让 UI 拿到
    # status=skipped / role=references 的逐页结论（不能算正文失败）。
    _ref_pages = {i + 1 for i, _r in enumerate(_page_roles) if _r == "references"}
    _v_targets = sorted(
        set(acc_total["page_expected"]) | {p + 1 for p in heavy_pages} | _ref_pages
    )
    if _v_targets:
        _v_pool = ThreadPoolExecutor(max_workers=min(4, len(_v_targets)))
        try:
            _v_pages = list(_v_pool.map(_verify_one_page, _v_targets))
        finally:
            try:
                _v_pool.shutdown(wait=False, cancel_futures=True)
            except TypeError:  # Python < 3.9
                _v_pool.shutdown(wait=False)
    else:
        _v_pages = []
    _v_failed = [p["page"] for p in _v_pages if p["status"] == "fail"]
    verification: dict = {
        "threshold": _v_ratio,
        "retryLimit": _v_retry,
        "retryWorkers": _v_workers,
        "pages": _v_pages,
        # 全篇页角色（1-based 页号字符串 -> body|references|appendix|front_matter），
        # 无文本层的页也会给一个 body，UI 可据此区分「参考文献未翻译」与「正文失败」。
        "pageRoles": {str(i + 1): _r for i, _r in enumerate(_page_roles)},
        "preRetryFailedPages": list(_v_failed),
        "failedPages": list(_v_failed),
        "retriedPages": [],
        "passed": not _v_failed,
    }
    # 重译页的新块级映射（页号 -> blocks），替换后合并进 .map.json
    _retried_blocks: dict[int, list] = {}

    if verify and _v_failed and _v_retry > 0 and backend not in ("none", "echo"):
        _retry_cands = _v_failed[:_v_retry]
        # 复用第一遍的术语表（不再重新抽取，省一次模型请求；全篇译法保持一致）
        _retry_gloss = glossary
        if glossary_terms:
            _retry_gloss = "\n".join(f"{en}={zh}" for en, zh in glossary_terms)

        def _retry_one_page(page_no: int) -> dict:
            """把一页单独抽成临时 PDF，用同一引擎/术语表重译一遍（verify=False 防递归）。"""
            _pno = page_no - 1
            _dir = tempfile.mkdtemp(prefix=f"pd-retry-{page_no}-")
            try:
                _tsrc = os.path.join(_dir, "page-src.pdf")
                _tout = os.path.join(_dir, "page-out.pdf")
                _sd = fitz.open(src)
                try:
                    _one = fitz.open()
                    _one.insert_pdf(_sd, from_page=_pno, to_page=_pno)
                    _one.save(_tsrc)
                    _one.close()
                finally:
                    _sd.close()
                # 模块层保护区按页传入（单页 PDF 里页号是 0）
                _skip1 = None
                if skip_rects:
                    _rects0 = skip_rects.get(str(_pno)) or skip_rects.get(_pno)
                    if _rects0:
                        _skip1 = {"0": _rects0}
                _res = simple_translate(
                    _tsrc,
                    _tout,
                    target_lang=target_lang,
                    backend=backend,
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    headers=headers,
                    is_cancelled=is_cancelled,
                    skills_dir=skills_dir,
                    doc_title=doc_title,
                    doc_authors=doc_authors,
                    max_workers=max_workers,
                    retries=retries,
                    skip_rects=_skip1,
                    batch_size=batch_size,
                    mode=mode,
                    layout=layout,
                    glossary=_retry_gloss,
                    terminology=terminology,
                    auto_glossary=False,
                    no_think=no_think,
                    verify=False,
                )
                _vp = ((_res.get("qa") or {}).get("verification") or {}).get("pages") or []
                _mine = next((p for p in _vp if int(p.get("page") or 0) == 1), None)
                return {
                    "page": page_no,
                    "pno": _pno,
                    "dir": _dir,
                    "out": _tout,
                    "ok": bool(_mine and _mine.get("ok")),
                    "pageStat": _mine,
                    "mapPath": _res.get("mapPath"),
                }
            except Exception:
                shutil.rmtree(_dir, ignore_errors=True)
                raise

        _retry_results: list[dict] = []
        _rpool = ThreadPoolExecutor(max_workers=max(1, min(_v_workers, len(_retry_cands))))
        try:
            _rfuts = {_rpool.submit(_retry_one_page, p): p for p in _retry_cands}
            for _rfut in as_completed(_rfuts):
                _rpage = _rfuts[_rfut]
                try:
                    _retry_results.append(_rfut.result())
                except Exception as _rexc:  # noqa: BLE001
                    warnings.append(f"第 {_rpage} 页自动重译失败（保留原页）：{str(_rexc)[:140]}")
        finally:
            try:
                _rpool.shutdown(wait=True, cancel_futures=True)
            except TypeError:  # Python < 3.9
                _rpool.shutdown(wait=True)

        # 替换必须串行（同一份 PDF）：delete_page + insert_pdf(start_at=页号) 保持 1:1；
        # 保存先写临时文件再 os.replace，避免替换中途失败留下半截译文。
        for _item in sorted(_retry_results, key=lambda r: r["page"]):
            _page_no = int(_item["page"])
            _pno = int(_item["pno"])
            _dir = str(_item["dir"])
            _spill = out + ".retry.tmp"
            try:
                if not _item["ok"]:
                    warnings.append(f"第 {_page_no} 页重译后正文仍未正常落版（保留原页）")
                    continue
                if cancelled():
                    warnings.append(f"已取消：第 {_page_no} 页重译结果未替换（保留原页）")
                    continue
                _main = fitz.open(out)
                _tmp_doc = fitz.open(_item["out"])
                try:
                    if _main.page_count != pages or _tmp_doc.page_count != 1:
                        raise RuntimeError(
                            f"页数异常（主 {_main.page_count}/{pages}，临时 {_tmp_doc.page_count}）"
                        )
                    _main.delete_page(_pno)
                    _main.insert_pdf(_tmp_doc, from_page=0, to_page=0, start_at=_pno)
                    if _main.page_count != pages:
                        raise RuntimeError(f"替换后页数 {_main.page_count} != {pages}")
                    _main.save(_spill, garbage=1, deflate=True)
                finally:
                    _tmp_doc.close()
                    _main.close()
                os.replace(_spill, out)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"第 {_page_no} 页重译结果替换失败（保留原页）：{str(exc)[:140]}")
                try:
                    if os.path.exists(_spill):
                        os.remove(_spill)
                except OSError:
                    pass
            else:
                verification["retriedPages"].append(_page_no)
                _stat = _item.get("pageStat") or {}
                for _ent in verification["pages"]:
                    if _ent["page"] == _page_no:
                        _ent.update(
                            {
                                "expected": int(_stat.get("expected") or 0),
                                "written": int(_stat.get("written") or 0),
                                "ratio": float(_stat.get("ratio") or 0.0),
                                "ok": True,
                                "status": "retried",
                                "reason": "已自动重译并替换",
                            }
                        )
                        break
                _mp = _item.get("mapPath")
                if _mp:
                    try:
                        with open(_mp, encoding="utf-8") as _mfh:
                            _tm = json.load(_mfh)
                        _retried_blocks[_page_no] = [
                            {**b, "page": _page_no} for b in (_tm.get("blocks") or [])
                        ]
                    except Exception as exc:  # noqa: BLE001
                        warnings.append(
                            f"第 {_page_no} 页重译后的块级映射合并失败（高亮可能偏移）：{str(exc)[:100]}"
                        )
            finally:
                shutil.rmtree(_dir, ignore_errors=True)

        verification["failedPages"] = [
            p["page"] for p in verification["pages"] if not p.get("ok")
        ]
        verification["passed"] = not verification["failedPages"]

    # 验收结论落到 warnings（面板同时会解析 qa.verification；这里保证日志/历史可见）
    _v_pre = verification.get("preRetryFailedPages") or []
    _v_still = verification.get("failedPages") or []
    _v_done = verification.get("retriedPages") or []
    if _v_pre:
        _msg = "按页验收：第 %s 页正文未正常翻译" % "、".join(str(p) for p in _v_pre)
        if _v_done:
            _msg += "；已自动重译并替换 %d 页（第 %s 页）" % (
                len(_v_done),
                "、".join(str(p) for p in _v_done),
            )
        elif _v_retry <= 0:
            _msg += "（自动重译已关闭）"
        if _v_still:
            _msg += "；仍有 %s 页未通过（已保留原页，请对照原文核对）" % "、".join(
                str(p) for p in _v_still
            )
        warnings.append(_msg)
    qa["verification"] = verification
    stage_t["verify"] = time.time() - _t_verify

    # 重译成功的页已正常落版 → 从「放不下」清单里剔除，避免 sidecar 留下过期条目
    for _p_ok in verification.get("retriedPages") or []:
        overflow_by_page.pop(_p_ok, None)
    if overflow_by_page:
        try:
            overflow_path = str(Path(out).with_suffix(".overflow.json"))
            with open(overflow_path, "w", encoding="utf-8") as fh:
                json.dump(
                    {
                        "pageCount": pages,
                        "pages": overflow_by_page,
                    },
                    fh,
                    ensure_ascii=False,
                    indent=2,
                )
            _n = sum(len(v) for v in overflow_by_page.values())
            warnings.append(
                f"有 {_n} 处译文在当前版面放不下：完整内容已按**源页**写入 {os.path.basename(overflow_path)}，"
                f"页面数保持与原文一致（未追加文末页）；其中 {fell_back} 处已在原位置回填原文（不留空白）"
            )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"写入溢出译文 sidecar 失败：{str(exc)[:120]}")

    # 块级映射 sidecar：对照视图据此把「原文选区」映射到译文的**实际落版位置**。
    # 没有它时，页内重排后只能按原坐标高亮 → 译文空白处出现高亮。
    map_path = None
    try:
        map_path = str(Path(out).with_suffix(".map.json"))
        if _retried_blocks:
            _map_blocks = [
                b for b in layout_map if b.get("page") not in _retried_blocks
            ]
            for _pno_key in sorted(_retried_blocks):
                _map_blocks.extend(_retried_blocks[_pno_key])
        else:
            _map_blocks = layout_map
        with open(map_path, "w", encoding="utf-8") as fh:
            json.dump(
                {"pageCount": pages, "blocks": _map_blocks},
                fh,
                ensure_ascii=False,
            )
    except Exception as exc:  # noqa: BLE001
        map_path = None
        warnings.append(f"写入块级映射失败（跨窗高亮将退化为按页）：{str(exc)[:120]}")

    report("done", total, total)

    # HTML 译文已从产品中移除（AI 侧可直接产出 LaTeX / 结构化内容）：
    # 不再生成「网页译文」与「中英对照 HTML」，只保留 PDF 与 Markdown。
    html_path = None
    bilingual_path = None

    md_path = None
    bilingual_md_path = None
    if md_out:
        try:
            _write_translation_md(md_out, flat, translated)
            md_path = md_out
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Markdown 生成失败: {str(exc)[:150]}")
    if bilingual_md_out:
        try:
            _write_bilingual_md(bilingual_md_out, flat, translated)
            bilingual_md_path = bilingual_md_out
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"对照 Markdown 生成失败: {str(exc)[:150]}")

    # 行内公式里存在无法确定含义的 LaTeX 命令：这些位置保持原样，明确告知（不猜）
    _unmapped = list(acc_total.get("math_unmapped") or [])
    if _unmapped:
        warnings.append(
            "以下行内公式命令未能可靠还原，已按原样保留，请对照原文核对："
            + "、".join(_unmapped[:8])
            + ("…" if len(_unmapped) > 8 else "")
        )

    return {
        "engine": "simple",
        "backend": backend,
        "mode": MODE,
        "targetLang": target_lang,
        "pages": pages,
        "pageCount": pages,  # 与译文页数 1:1（不再追加文末补注页）
        "blocks": blocks,
        "outPath": out,
        "htmlPath": html_path,
        "bilingualPath": bilingual_path,
        "mdPath": md_path,
        "bilingualMdPath": bilingual_md_path,
        "overflowPath": overflow_path,
        "mapPath": map_path,
        "counts": dict(Counter(eff_kind)),
        "qa": qa,
        "timing": {
            "mode": MODE,
            "totalSeconds": round(sum(stage_t.values()), 1),
            "stages": {k: round(v, 2) for k, v in stage_t.items()},
            "requests": req_count,
            "requestSeconds": round(req_total_s, 1),
            "avgRequestSeconds": round(req_total_s / max(1, req_count), 1),
            "avgSecondsPerBlock": round(req_total_s / max(1, prog_done), 2),
            "failedBatches": failed_batches,
            "retries": retry_count,
            "batchSize": BATCH,
            "workers": max(1, min(int(max_workers or 4), len(plan) or 1)),
            "planRequests": len(plan),
            "groups": len(groups) if (backend == "openai" and raws) else 0,
            # 是否请求关闭了模型思考（服务端拒绝该参数时会自动降级，见 _post_chat）
            "noThink": bool(
                no_think and backend == "openai" and not _NO_THINK_UNSUPPORTED
            ),
        },
        "coverage": {
            "expected": total - sum(skip_mask),
            "written": blocks,
            "emptyTranslations": empty_tr,
            "truncatedBlocks": int(write_stats.get("truncated", 0)),
            # 译文放不下、已回填原文（不空白；完整译文在 overflow，按源页）
            "fellBackToOriginal": fell_back,
            "fallbackFailed": fallback_failed,
            # 高置信度移除的文献角标（仅从翻译输入/译文移除，原文保留）
            "citationsRemoved": citations_removed,
            # 公式：整块原样保留 / 只能字母近似（不是静默替换，见 warnings）
            "formulaPreserved": formula_preserved,
            "formulaApproximated": formula_approx,
            # 模型把占位符吞掉 → 该段行内公式没能放回译文
            "formulaDropped": formula_dropped,
            # 缺失的占位符个数（一段里可能只丢一部分）
            "formulaMissing": formula_missing,
            # 行内公式用 HTML 上下标重排的块数 / 未能识别、原样保留的 LaTeX 命令
            "mathHtml": int(write_stats.get("math_html", 0)),
            "mathUnmapped": list(acc_total.get("math_unmapped") or []),
            # 结构还原不了、整块退回原文的块数（不画假公式）
            "mathUnreliable": formula_unreliable,
            # 未翻译/失败（保留原文）：粗译要求「不阻塞整篇」，这里单独记账
            "failedBlocks": unchanged,
        },
        "warnings": warnings,
        "fontDelta": float(font_delta or 0.0),
    }


def retranslate_page(
    src: str,
    out: str,
    page: int,
    target_lang: str = "zh",
    backend: str = "mock",
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    headers: dict | None = None,
    max_workers: int = 4,
    mode: str = "fine",
    layout: str = "reflow",
    glossary: str | None = None,
    terminology: str = "",
    auto_glossary: bool = True,
    no_think: bool = True,
    font_delta: float = DEFAULT_FONT_DELTA,
) -> dict:
    """只重译译文 PDF 的第 page 页（1 基），其余页原样保留。

    单页抽成临时 PDF 后走与整篇相同的 simple_translate；再把新页替换回目标
    PDF，并合并块级映射。这样不会重新翻译整篇，也不会改动别的页。
    """
    page_no = int(page)
    if page_no < 1:
        raise RuntimeError(f"页码必须从 1 开始: {page}")
    if not os.path.exists(out):
        raise RuntimeError(f"译文不存在: {out}")
    src_doc = fitz.open(src)
    try:
        total = src_doc.page_count
        if page_no > total:
            raise RuntimeError(f"页码超出范围: {page_no}/{total}")
        with tempfile.TemporaryDirectory(prefix=f"pd-page-{page_no}-") as tmp:
            one_src = os.path.join(tmp, "page-src.pdf")
            one_out = os.path.join(tmp, "page-out.pdf")
            one_md = os.path.join(tmp, "page.md")
            one_bi = os.path.join(tmp, "page.bilingual.md")
            one_doc = fitz.open()
            try:
                one_doc.insert_pdf(src_doc, from_page=page_no - 1, to_page=page_no - 1)
                one_doc.save(one_src)
            finally:
                one_doc.close()
            # 显式“重译本页”时，用户已经接受了这一页可能较慢，不能再按
            # heavy_pages 整页保留原文，否则图形/算法密集页永远无法被修复。
            result = simple_translate(
                one_src,
                one_out,
                target_lang,
                backend,
                base_url,
                api_key,
                model,
                headers,
                md_out=one_md,
                bilingual_md_out=one_bi,
                max_workers=max(1, min(int(max_workers or 2), 4)),
                mode=mode,
                layout=layout,
                glossary=glossary,
                terminology=terminology,
                auto_glossary=auto_glossary,
                no_think=no_think,
                verify=False,
                heavy_page_override=True,
                font_delta=font_delta,
            )
            if not os.path.exists(one_out):
                raise RuntimeError("单页翻译没有生成 PDF")
            new_doc = fitz.open(one_out)
            target = fitz.open(out)
            tmp_target = os.path.join(os.path.dirname(out), f".{os.path.basename(out)}.page.tmp.pdf")
            try:
                if target.page_count != total:
                    raise RuntimeError(
                        f"译文页数异常（{target.page_count} != 原文 {total}），已拒绝替换"
                    )
                target.delete_page(page_no - 1)
                target.insert_pdf(new_doc, from_page=0, to_page=0, start_at=page_no - 1)
                if target.page_count != total:
                    raise RuntimeError(
                        f"替换后页数异常（{target.page_count} != 原文 {total}），已拒绝覆盖"
                    )
                target.save(tmp_target, garbage=3, deflate=True)
            finally:
                target.close()
                new_doc.close()
            os.replace(tmp_target, out)

            # 合并这一页的块级映射，保证跨窗高亮仍可用。
            map_path = Path(out).with_suffix(".map.json")
            tmp_map = Path(one_out).with_suffix(".map.json")
            map_updated = False
            if map_path.exists() and tmp_map.exists():
                try:
                    target_map = json.loads(map_path.read_text("utf-8"))
                    one_map = json.loads(tmp_map.read_text("utf-8"))
                    blocks = [
                        b
                        for b in (target_map.get("blocks") or [])
                        if int(b.get("page") or 0) != page_no
                    ]
                    for b in one_map.get("blocks") or []:
                        item = dict(b)
                        item["page"] = page_no
                        blocks.append(item)
                    target_map["blocks"] = blocks
                    target_map["pageCount"] = total
                    map_path.write_text(
                        json.dumps(target_map, ensure_ascii=False, separators=(",", ":")),
                        "utf-8",
                    )
                    map_updated = True
                except Exception:  # noqa: BLE001
                    # 映射失败不影响 PDF 页替换；保留旧映射，但明确告知。
                    result.setdefault("warnings", []).append("块级映射合并失败，本页高亮可能偏移")
            return {
                **result,
                "page": page_no,
                "pageCount": total,
                "mapUpdated": map_updated,
                "pageMarkdown": Path(one_md).read_text("utf-8") if Path(one_md).exists() else None,
                "pageBilingualMarkdown": Path(one_bi).read_text("utf-8") if Path(one_bi).exists() else None,
                "warnings": list(result.get("warnings") or []),
            }
    finally:
        src_doc.close()
