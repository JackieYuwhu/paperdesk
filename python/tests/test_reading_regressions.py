"""Offline regressions for formula integrity and explicit sentence alignment."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.inline_math import inline_math_html, to_unicode_math
from app.translate import _marked_sentences, _unmark_sentences, _restore_formula_placeholders
from app.translate import _split_sentences

assert inline_math_html("x^{ij}+y_{kl}") == "x<sup>ij</sup>+y<sub>kl</sub>"
assert to_unicode_math("x^{12}") == "x¹²"
assert "^{ij}" in to_unicode_math("x^{ij}")  # unsupported Unicode scripts retain grouping
source = "First sentence. Second sentence."
marked, sentences = _marked_sentences(source)
assert len(sentences) == 2 and "⟪PD-S1⟫" in marked
assert len(_split_sentences("See Eq. (3) with x=1.25. Next sentence.")) == 2
text, parts = _unmark_sentences("⟪PD-S0⟫第一句。⟪PD-S1⟫第二句。", 2)
assert parts == ["第一句。", "第二句。"] and "PD-S" not in text
for invalid in ["⟪PD-S1⟫第二句。⟪PD-S0⟫第一句。", "⟪PD-S0⟫只有一句。", "⟪PD-S0⟫重复。⟪PD-S0⟫重复。"]:
    assert not _unmark_sentences(invalid, 2)[1]
for invalid in ["译文 ⟦0⟧ 缺第二个公式", "译文 ⟦0⟧⟦0⟧⟦1⟧"]:
    flat = [{"raw": "Source α and β", "math": ["α", "β"]}]
    translated = [invalid]
    dropped, missing, _ = _restore_formula_placeholders(flat, translated)
    assert dropped == 1 and missing == 1 and translated[0] == flat[0]["raw"]
print("READING_REGRESSIONS_PY_OK")
