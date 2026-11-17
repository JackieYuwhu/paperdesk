# 2026-11-13 鉴权修正：按接口协议选凭据头，单段翻译补鉴权

## 背景（2026-11-09 的误判）

2026-11-09 为修划词翻译 401，曾按**域名**判定：`opencode.ai` 或路径含 `/zen/go`
一律发 `x-api-key`，其它发 `Authorization: Bearer`。这个结论是错的。

## 实测证据（2026-11-13）

用真实 profile 的 Key 对 `https://opencode.ai/zen/go/v1/chat/completions` 发两种头：

| 鉴权头 | 结果 |
| --- | --- |
| `Authorization: Bearer <oc_…>` | HTTP 400 `MissingSessionID`（**鉴权已通过**，缺的是 `x-opencode-session`） |
| `x-api-key: <oc_…>` | 需要同时带会话头才可用 |

结论：OpenCode Go 的 `/chat/completions` 接受 Bearer；它额外要求的是
`x-opencode-session`（由 `settings.ts::modelHeaders` 按用途附加），与鉴权头无关。
按域名选头还会把挂在同一域名下的其它协议端点一起带错。

## 现在的规则：按接口协议

| 接口协议 | 判定 | 鉴权头 |
| --- | --- | --- |
| OpenAI 兼容 | 默认；`/chat/completions`、`/embeddings`、`/responses` | `Authorization: Bearer <key>` |
| Anthropic Messages | `api.anthropic.com` 或路径含 `/messages` | `x-api-key: <key>` |

- `src/shared/model-auth.ts`：`authProtocolForUrl(url)` + `modelAuthHeaders(url, key, protocol?)`；
  `isOpenCodeBaseUrl()` 保留，但只用于「是否附加 `x-opencode-session`」，不再参与鉴权。
- `python/app/model_auth.py`：同一规则（`auth_protocol_for_url` / `auth_headers(url, key, headers, protocol=None)`），
  只保留一种鉴权头，避免同一请求同时带 Bearer 与 x-api-key。
- 调用方一律传**完整请求 URL**（`.../chat/completions`），不要只传 base URL：
  `translate.py`（批量、术语、单段）、`embed.py`、`vision.py` 已改。

## 单段翻译路径漏鉴权（本次一并修复）

`python/app/translate.py::_openai_translate_plain` 走纯文本单段请求（划词翻译），
此前 `_post_chat(url, body, headers, 120.0)` 只带 UA/会话头，**没有鉴权头**，
真模型下必然 401；批量路径自己拼过 `auth_headers`，所以只有划词会挂。

修复：`_post_chat(url, body, auth_headers(url, api_key, headers), 120.0)`。

## 测试

- `scripts/test-unit.ts`：鉴权用例改为协议口径（opencode 域名的 `/chat/completions` → Bearer；
  `/messages` 与 `api.anthropic.com` → x-api-key；协议可显式覆盖；空 key 不生成头）。
- `python/tests/test_translate.py`：同口径 9 条断言。
- `npm run test:unit` → `UNIT_OK`；`npm run test:py` → 全绿（`TRANSLATE_OK`）。
