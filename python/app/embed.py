"""文本向量（embedding）生成。

后端可插拔：
  * mock   : 本地确定性哈希向量（token 哈希 + 符号，L2 归一化），离线可用、可复现
  * openai : 任意 OpenAI 兼容 /embeddings 服务
  * none   : 关闭
"""

from __future__ import annotations

import hashlib
import math
import re

DIM = 64
TOKEN_RE = re.compile(r"[a-z0-9]+")


def mock_embed(text: str, dim: int = DIM) -> list[float]:
    vec = [0.0] * dim
    for tok in TOKEN_RE.findall((text or "").lower()):
        h = hashlib.md5(tok.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "little") % dim
        sign = 1.0 if h[4] % 2 == 0 else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        vec[0] = 1.0
        return vec
    return [v / norm for v in vec]


def openai_embed(
    texts: list[str],
    base_url: str | None,
    api_key: str | None,
    model: str | None,
    headers: dict | None = None,
) -> list[list[float]]:
    from . import _http as http
    from .model_auth import auth_headers

    if not base_url or not api_key:
        raise RuntimeError("openai 向量后端需要 baseUrl 与 apiKey")
    url = base_url.rstrip("/") + "/embeddings"
    r = http.post(
        url,
        json={"model": model or "text-embedding-3-small", "input": texts},
        headers=auth_headers(url, api_key, headers),
        timeout=60.0,
    )
    r.raise_for_status()
    data = r.json().get("data") or []
    return [item["embedding"] for item in data]


def embed_texts(
    texts: list[str],
    backend: str = "local",
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    headers: dict | None = None,
) -> dict:
    # local / mock 等价：本地确定性哈希向量（离线、可复现）
    if backend in ("local", "mock"):
        return {
            "backend": "local",
            "model": "local-hash-64",
            "dim": DIM,
            "vectors": [mock_embed(t) for t in texts],
        }
    if backend == "none":
        return {"backend": "none", "model": "none", "dim": 0, "vectors": []}
    if backend == "openai":
        vectors = openai_embed(texts, base_url, api_key, model, headers)
        return {
            "backend": "openai",
            "model": model or "text-embedding-3-small",
            "dim": len(vectors[0]) if vectors else 0,
            "vectors": vectors,
        }
    # 未知后端：退回本地，避免调用方因配置问题整体失败
    return {
        "backend": "local",
        "model": "local-hash-64",
        "dim": DIM,
        "vectors": [mock_embed(t) for t in texts],
    }
