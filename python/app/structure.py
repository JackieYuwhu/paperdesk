"""快速结构提取：公式（equations）与定理类环境（theorem/lemma/definition…）。

不追求 LaTeX 级精度，目标是从 PDF 文本层**快速**给出：
  * 公式候选行（含编号），便于复制/排版
  * 定理类条目（Theorem/Lemma/Definition/… 及其陈述）

纯本地、无外部依赖（PyMuPDF）。GROBID/MinerU 可用时可另行增强。
"""

from __future__ import annotations

import re

import fitz  # PyMuPDF

# 数学符号（含常见希腊字母）
MATH_CHARS = set(
    "=∑∏∫∮∂√±×÷·⋅≈≠≤≥≡∈∉⊂⊆∪∩∀∃∇∞→←↔⇒⇔"
    "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ"
)
MATH_FUNCS_RE = re.compile(
    r"\b(sin|cos|tan|log|ln|exp|lim|sup|inf|max|min|argmax|argmin|softmax|sigma|sum|prod|grad|div|det)\b",
    re.IGNORECASE,
)
# 单独成行的公式编号，如 "(1)"、"(2.3)"、"（3）"
EQ_NUMBER_ONLY_RE = re.compile(r"^[（(]\s*(\d+(?:\.\d+)?|[A-Za-z]?\d+)\s*[)）]$")
# 行尾编号
EQ_TRAILING_NUM_RE = re.compile(r"[（(]\s*(\d+(?:\.\d+)?)\s*[)）]\s*$")
# 定理类环境
ENV_RE = re.compile(
    r"\b(Theorem|Lemma|Corollary|Proposition|Definition|Remark|Assumption|Claim|"
    r"Example|Axiom|Property|Notation|Proof|Algorithm)\b\s*[.:]?\s*([\d]+(?:\.[\d]+)*)?",
    re.IGNORECASE,
)
ENV_CANON = {
    "theorem": "Theorem",
    "lemma": "Lemma",
    "corollary": "Corollary",
    "proposition": "Proposition",
    "definition": "Definition",
    "remark": "Remark",
    "assumption": "Assumption",
    "claim": "Claim",
    "example": "Example",
    "axiom": "Axiom",
    "property": "Property",
    "notation": "Notation",
    "proof": "Proof",
    "algorithm": "Algorithm",
}

MAX_EQUATIONS = 80
MAX_THEOREMS = 60
MAX_STMT = 800


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _is_equation_line(text: str) -> bool:
    t = _norm(text)
    if len(t) < 3 or len(t) > 240:
        return False
    if EQ_NUMBER_ONLY_RE.match(t):
        return False
    words = t.split()
    if len(words) > 34:
        return False
    math_hits = sum(t.count(ch) for ch in MATH_CHARS)
    has_eq = "=" in t or "≡" in t or "≈" in t or "≤" in t or "≥" in t
    has_op = any(ch in t for ch in "∑∫∂∏√±→")
    if math_hits == 0 and not has_op and not has_eq and not MATH_FUNCS_RE.search(t):
        return False
    # 纯文字句子（以句号结尾、含较多词、无强数学符号）排除
    if t.endswith(".") and len(words) > 12 and math_hits == 0 and not has_op:
        return False
    return has_eq or has_op or math_hits >= 2 or bool(MATH_FUNCS_RE.search(t))


def _extract_page_equations(page_no: int, text: str) -> list[dict]:
    out: list[dict] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        m_num = EQ_TRAILING_NUM_RE.search(line)
        if _is_equation_line(line):
            number = m_num.group(1) if m_num else None
            out.append({"page": page_no, "text": _norm(line), "number": number})
            i += 1
            continue
        # 行式编号单独一行：上一行可能是公式、当前是编号
        if EQ_NUMBER_ONLY_RE.match(_norm(line)) and i > 0 and _is_equation_line(lines[i - 1]):
            number = EQ_NUMBER_ONLY_RE.match(_norm(line)).group(1)  # type: ignore[union-attr]
            if out and out[-1]["page"] == page_no and out[-1]["number"] is None:
                out[-1]["number"] = number
            i += 1
            continue
        i += 1
    return out


def _extract_page_theorems(page_no: int, text: str) -> list[dict]:
    flat = _norm(text.replace("\n", " "))
    matches = list(ENV_RE.finditer(flat))
    out: list[dict] = []
    for idx, m in enumerate(matches):
        kind_raw = (m.group(1) or "").lower()
        kind = ENV_CANON.get(kind_raw, m.group(1).capitalize())
        number = m.group(2) or None
        start = m.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(flat)
        statement = flat[start:end].strip(" :.·-")
        if len(statement) > MAX_STMT:
            # 截到最近的句子边界
            cut = statement.rfind(". ", 0, MAX_STMT)
            statement = statement[: cut + 1] if cut > 200 else statement[:MAX_STMT]
        if len(statement) < 8:
            continue
        out.append({"page": page_no, "kind": kind, "number": number, "statement": statement})
    return out


def extract_structure(path: str) -> dict:
    doc = fitz.open(path)
    equations: list[dict] = []
    theorems: list[dict] = []
    page_count = 0
    try:
        page_count = doc.page_count
        for pno in range(page_count):
            text = doc[pno].get_text("text")
            if not text.strip():
                continue
            if len(equations) < MAX_EQUATIONS:
                for eq in _extract_page_equations(pno + 1, text):
                    equations.append(eq)
                    if len(equations) >= MAX_EQUATIONS:
                        break
            if len(theorems) < MAX_THEOREMS:
                for th in _extract_page_theorems(pno + 1, text):
                    theorems.append(th)
                    if len(theorems) >= MAX_THEOREMS:
                        break
    finally:
        doc.close()

    warnings: list[str] = []
    if not equations and not theorems:
        warnings.append('未识别到公式/定理（可能扫描件无文本层，或该文不含此类内容）')

    return {
        "pageCount": page_count,
        "equations": equations,
        "theorems": theorems,
        "counts": {"equations": len(equations), "theorems": len(theorems)},
        "warnings": warnings,
    }
