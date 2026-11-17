"""OpenAI Chat Completions and Anthropic Messages wire adapters."""
from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit
from .model_auth import auth_protocol_for_url


def chat_endpoint(base: str) -> str:
    parts = urlsplit(base.strip())
    path = parts.path.rstrip('/')
    for suffix in ('/chat/completions', '/messages'):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            break
    path = path or '/v1'
    path += '/messages' if auth_protocol_for_url(base) == 'anthropic' else '/chat/completions'
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


def _content(value):
    if isinstance(value, str):
        return value
    out = []
    for part in value:
        if part.get('type') != 'image_url':
            out.append(part)
            continue
        url = part['image_url']['url']
        if url.startswith('data:') and ';base64,' in url:
            media, data = url[5:].split(';base64,', 1)
            source = {'type': 'base64', 'media_type': media, 'data': data}
        else:
            source = {'type': 'url', 'url': url}
        out.append({'type': 'image', 'source': source})
    return out


def chat_payload(url: str, body: dict, headers: dict | None):
    headers = dict(headers or {})
    if auth_protocol_for_url(url) != 'anthropic':
        return body, headers
    headers['anthropic-version'] = '2023-06-01'
    # Do not forward vendor-specific thinking/temperature switches to Claude.
    system = '\n\n'.join(m['content'] for m in body['messages'] if m['role'] == 'system')
    payload = {
        'model': body['model'],
        'max_tokens': body.get('max_tokens', 8192),
        'messages': [dict(role=m['role'], content=_content(m['content']))
                     for m in body['messages'] if m['role'] != 'system'],
    }
    if system:
        payload['system'] = system
    return payload, headers


def response_text(data: dict) -> str:
    if 'choices' in data:
        return data['choices'][0]['message'].get('content') or ''
    return ''.join(p.get('text', '') for p in data.get('content', []) if p.get('type') == 'text')
