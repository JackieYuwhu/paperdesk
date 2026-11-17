"""httpx 本地代理绕过自测。

回归：某些机器有系统/环境代理，httpx 默认 trust_env=True 会把连 127.0.0.1 的
请求也走代理 → 502，本地 sidecar/端点全挂。`app/_http.py` 对本地地址禁用 trust_env。

运行：python tests/test_http.py
"""

import http.server
import os
import socketserver
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import _http  # noqa: E402

failed = 0


def check(name, cond, extra=""):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name} {extra}")


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        self.rfile.read(n)
        out = b'{"ok":true}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


srv = socketserver.TCPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

print("_http 测试")
check("_is_local 判定 127.0.0.1", _http._is_local(f"http://127.0.0.1:{port}/x"))
check("_is_local 判定 localhost", _http._is_local("http://localhost:9/x"))
check("_is_local 判定远程为 False", not _http._is_local("https://api.example.com/x"))

try:
    r = _http.post(f"http://127.0.0.1:{port}/chat/completions", json={"a": 1}, timeout=8)
    check("本地请求绕开代理成功", r.status_code == 200, f"status={r.status_code}")
except Exception as exc:  # noqa: BLE001
    check("本地请求绕开代理成功", False, f"{type(exc).__name__}: {exc}")

srv.shutdown()
print("HTTP_OK" if failed == 0 else f"HTTP_FAIL ({failed})")
sys.exit(0 if failed == 0 else 1)
