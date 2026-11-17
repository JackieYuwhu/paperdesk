"""可配置的「翻译技能」（按内容类型分策略）。

每种内容类型一个 JSON 文件，放在 `data/skills/translate/<id>.json`：
  { "label": 中文名, "match": 匹配键(body/heading/caption/formula/reference),
    "skip": 是否跳过翻译(保持原样), "system": system prompt（可用 {lang} 占位） }

用户可自行编辑这些文件以调整不同区域的翻译策略；改完下次翻译即生效。
"""

from __future__ import annotations

import json
import os

# 默认技能（首次自动写入磁盘）
DEFAULTS: dict[str, dict] = {
    "body": {
        "label": "正文",
        "match": "body",
        "skip": False,
        "system": (
            "Translate each numbered segment of the paper body into {lang}. "
            "Use precise academic terminology; keep citations like [1], numbers, units and symbols unchanged. "
            "Return ONLY a JSON array of strings, same order and same count. Do not merge or split."
        ),
    },
    "heading": {
        "label": "标题 / 小标题（可用 {section} 引用当前章节）",
        "match": "heading",
        "skip": False,
        "system": (
            "Translate each numbered segment (section titles/headings) into {lang}. "
            "Keep them short; do not add punctuation. "
            "Return ONLY a JSON array of strings, same order and count."
        ),
    },
    "caption": {
        "label": "图表题注",
        "match": "caption",
        "skip": False,
        "system": (
            "Translate each numbered segment (figure/table captions) into {lang}. "
            "Keep the label such as 'Figure 1' and any symbols; translate the description precisely. "
            "Return ONLY a JSON array of strings, same order and count."
        ),
    },
    "abstract": {
        "label": "摘要 / 标题区",
        "match": "abstract",
        "skip": False,
        "system": (
            "Translate each numbered segment (part of the paper's abstract/title area) into {lang}, "
            "in fluent, concise academic style; keep terminology precise. "
            "Return ONLY a JSON array of strings, same order and count."
        ),
    },
    "formula": {
        "label": "公式（默认不翻译；可在 prompt 里要求转 LaTeX）",
        "match": "formula",
        "skip": True,
        "system": (
            "Each numbered segment is an equation. Convert it to LaTeX (inline, wrapped in $...$), "
            "keeping symbols faithful; if it is not an equation, return it unchanged. "
            "Return ONLY a JSON array of strings, same order and count."
        ),
    },
    "reference": {
        "label": "参考文献（默认不翻译）",
        "match": "reference",
        "skip": True,
        "system": "Translate each numbered segment (a reference) into {lang}; keep author names and DOIs unchanged.",
    },
    "margin": {
        "label": "页眉/页脚/页码（默认不翻译）",
        "match": "margin",
        "skip": True,
        "system": "Translate each numbered segment into {lang}.",
    },
}


def ensure_defaults(dir_path: str) -> None:
    os.makedirs(dir_path, exist_ok=True)
    for sid, sk in DEFAULTS.items():
        p = os.path.join(dir_path, f"{sid}.json")
        if not os.path.exists(p):
            try:
                d = dict(sk)
                d.setdefault("version", 1)
                d.setdefault("updated_at", "")
                with open(p, "w", encoding="utf-8") as fh:
                    json.dump(d, fh, ensure_ascii=False, indent=2)
            except Exception:  # noqa: BLE001
                pass


def load_skills(dir_path: str | None) -> dict[str, dict]:
    """读取某个目录下的技能；目录为空/缺失时用默认值补全。返回 {match: skill}。"""
    out: dict[str, dict] = {}
    if dir_path:
        ensure_defaults(dir_path)
        try:
            for fn in os.listdir(dir_path):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(dir_path, fn), encoding="utf-8") as fh:
                        sk = json.load(fh)
                    if isinstance(sk, dict):
                        out[sk.get("match") or fn[:-5]] = sk
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001
            pass
    for match, sk in DEFAULTS.items():
        out.setdefault(match, dict(sk))
    for sk in out.values():
        sk.setdefault("scope", "all")
        sk.setdefault("version", 1)
        sk.setdefault("updated_at", "")
    return out


def list_skills(dir_path: str) -> list[dict]:
    ensure_defaults(dir_path)
    skills = load_skills(dir_path)
    items: list[dict] = []
    for match, sk in skills.items():
        items.append(
            {
                "id": match,
                "match": match,
                "label": sk.get("label") or match,
                "skip": bool(sk.get("skip")),
                "system": sk.get("system") or "",
                "scope": sk.get("scope") or "all",
                "version": int(sk.get("version") or 1),
                "updated_at": sk.get("updated_at") or "",
                "path": os.path.join(dir_path, f"{match}.json"),
            }
        )
    # 稳定顺序：与默认顺序一致
    order = list(DEFAULTS.keys())
    items.sort(key=lambda x: order.index(x["match"]) if x["match"] in order else 99)
    return items


def save_skill(
    dir_path: str,
    match: str,
    system: str | None,
    skip: bool | None,
    scope: str | None = None,
    version: int | None = None,
) -> dict:
    ensure_defaults(dir_path)
    p = os.path.join(dir_path, f"{match}.json")
    cur: dict = {}
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as fh:
                cur = json.load(fh) or {}
        except Exception:  # noqa: BLE001
            cur = {}
    cur.setdefault("label", DEFAULTS.get(match, {}).get("label", match))
    cur["match"] = match
    if system is not None:
        cur["system"] = system
    if skip is not None:
        cur["skip"] = bool(skip)
    if scope is not None:
        cur["scope"] = scope
    cur.setdefault("scope", "all")
    # 版本：显式给出则采用，否则自增
    if version is not None:
        cur["version"] = int(version)
    else:
        cur["version"] = int(cur.get("version") or 0) + 1
    from datetime import datetime, timezone

    cur["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(cur, fh, ensure_ascii=False, indent=2)
    return cur


def reset_skills(dir_path: str) -> None:
    os.makedirs(dir_path, exist_ok=True)
    for sid, sk in DEFAULTS.items():
        with open(os.path.join(dir_path, f"{sid}.json"), "w", encoding="utf-8") as fh:
            json.dump(sk, fh, ensure_ascii=False, indent=2)


def import_skills(dir_path: str, skills_list: list, force: bool = False, only: list | None = None) -> dict:
    """从给定技能列表导入（逐个写入）。返回 {imported, conflicts, updates}。

    - conflicts：本地同类型技能 version 更高（且未 force）→ 跳过，待用户选择是否覆盖。
    - updates：导入方 version 更高（正常覆盖，属「升级」）。
    - only：仅处理这些 match（用于对冲突项逐项采用）；为空则处理全部。
    """
    ensure_defaults(dir_path)
    existing = load_skills(dir_path)
    imported = 0
    conflicts: list[str] = []
    updates: list[str] = []
    only_set = {str(x) for x in only} if only else None
    for sk in skills_list or []:
        if not isinstance(sk, dict):
            continue
        match = sk.get("match") or sk.get("id")
        if not match:
            continue
        match = str(match)
        if only_set is not None and match not in only_set:
            continue
        cur_ver = int((existing.get(match) or {}).get("version") or 0)
        in_ver = int(sk.get("version") or 0)
        if not force and cur_ver > in_ver and in_ver > 0:
            conflicts.append(match)
            continue
        try:
            save_skill(
                dir_path,
                match,
                sk.get("system"),
                sk.get("skip"),
                sk.get("scope"),
                version=in_ver or None,
            )
            imported += 1
            if in_ver > cur_ver and in_ver > 0:
                updates.append(match)
        except Exception:  # noqa: BLE001
            continue
    return {"imported": imported, "conflicts": conflicts, "updates": updates}
