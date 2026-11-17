"""模型服务鉴权头：按**接口协议**选择 `Authorization: Bearer` 或 `x-api-key`。

判定依据是请求地址的协议形状，而不是网关域名：

- OpenAI 兼容协议（`/chat/completions`）→ `Authorization: Bearer <key>`
- Anthropic Messages 协议（`/messages`、`api.anthropic.com`）→ `x-api-key: <key>`

历史误判：早期版本把 `opencode.ai` / `/zen/go` 域名一律当作需要 `x-api-key`。
实测 OpenCode Go 的 `/chat/completions` 接受 Bearer，它额外要求的是
`x-opencode-session`（由 Node 侧 `settings.ts::modelHeaders` 附加），与鉴权头无关。
按域名判定还会把挂在同一域名下的其它协议端点带错。

与 `src/shared/model-auth.ts` 保持同一判定规则（Node 主进程 -> Python sidecar
传的是 baseUrl/apiKey，鉴权头统一在 sidecar 里拼）。
"""

from __future__ import annotations

import re

_ANTHROPIC_HOST_RE = re.compile(r"^https?://api\.anthropic\.com(?::\d+)?(?:[/?#]|$)", re.IGNORECASE)
_ANTHROPIC_PATH_RE = re.compile(r"/messages(?:[/?#]|$)", re.IGNORECASE)
_OPENCODE_HOST_RE = re.compile(r"opencode\.ai", re.IGNORECASE)
_OPENCODE_PATH_RE = re.compile(r"/zen/go(/|$)", re.IGNORECASE)


def is_opencode_base(base_url: str | None) -> bool:
    """是否 OpenCode 端点（只用于附加会话头，与鉴权无关）。"""
    b = base_url or ""
    return bool(_OPENCODE_HOST_RE.search(b) or _OPENCODE_PATH_RE.search(b))


def auth_protocol_for_url(url: str | None) -> str:
    """由请求地址判定接口协议：`anthropic` 或 `openai`。"""
    u = (url or "").strip()
    if not u:
        return "openai"
    if re.search(r"/chat/completions(?:[/?#]|$)", u, re.IGNORECASE):
        return "openai"
    if _ANTHROPIC_HOST_RE.search(u) or _ANTHROPIC_PATH_RE.search(u):
        return "anthropic"
    return "openai"


def auth_headers(
    url: str | None,
    api_key: str | None,
    headers: dict | None = None,
    protocol: str | None = None,
) -> dict:
    """在已有头（UA / 会话头等）之上追加正确的鉴权头。

    `url` 传完整请求地址（含 `/chat/completions`）或 base URL 均可。
    只保留一种鉴权方式，避免同一个请求同时带 Bearer 与 x-api-key
    导致部分网关按错误的头校验。
    """
    out = dict(headers or {})
    key = (api_key or "").strip()
    if not key:
        return out
    p = protocol or auth_protocol_for_url(url)
    if p == "anthropic":
        out.pop("Authorization", None)
        out.pop("authorization", None)
        out["x-api-key"] = key
    else:
        out.pop("x-api-key", None)
        out.pop("X-Api-Key", None)
        out["Authorization"] = f"Bearer {key}"
    return out
