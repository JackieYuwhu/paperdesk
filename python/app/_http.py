"""统一的 httpx 辅助：对**本地回环地址**禁用环境代理（trust_env）。

背景：某些机器设置了系统/环境代理，httpx 默认 `trust_env=True` 会把连
`127.0.0.1` 的请求也走代理，导致 502（本地 sidecar / 本地 mock 模型端点全挂）。
对远程地址仍保持默认行为（企业代理可用）。

另外：这里复用**连接池**。原来每次 `httpx.post` 都新建 client，翻译一次论文
就是几十次 TCP/TLS 握手；对延迟主导的网关是纯浪费。
"""

from __future__ import annotations

import threading
from urllib.parse import urlparse

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}

_client_lock = threading.Lock()
_clients: dict = {}


def _is_local(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return False
    return host in _LOCAL_HOSTS


def _client(local: bool):
    """本地/远程各留一个长连接池（trust_env 是 client 级设置，不能混用）。"""
    client = _clients.get(local)
    if client is not None:
        return client
    import httpx

    with _client_lock:
        client = _clients.get(local)
        if client is None:
            client = httpx.Client(
                trust_env=not local,
                timeout=httpx.Timeout(120.0, connect=15.0),
                limits=httpx.Limits(max_connections=64, max_keepalive_connections=32),
            )
            _clients[local] = client
    return client


def post(url: str, **kwargs):
    return _client(_is_local(url)).post(url, **kwargs)


def get(url: str, **kwargs):
    return _client(_is_local(url)).get(url, **kwargs)
