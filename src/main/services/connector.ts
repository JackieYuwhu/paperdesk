// Zotero 连接器：极简本地 HTTP 接收端。
// 浏览器扩展 / 书签向 127.0.0.1 上的本服务推送 PDF 链接或 DOI，
// 由主进程复用 importFromUrl(input) 完成解析与入库。
// 安全：只监听回环地址；写入 /import 必须带 x-paperdesk-token 头（首次使用自动生成并持久化）。
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { ConnectorStatus } from '../../shared/types'

export type { ConnectorStatus }

const DEFAULT_PORT = 23124
const HOST = '127.0.0.1'
const VERSION = '0.1'
/** 请求体上限（防止恶意/异常的超大 body） */
const MAX_BODY_BYTES = 64 * 1024
/** 单个输入标识符长度上限 */
const MAX_INPUT_LEN = 2048

/** 纯函数：校验令牌。expected 为空（未配置）一律拒绝。 */
export function checkToken(given: string | null, expected: string): boolean {
  if (!expected) return false
  if (typeof given !== 'string' || !given) return false
  return given === expected
}

/**
 * 纯函数：从已解析的请求体里取出导入输入。
 * 仅接受 `{ url: string }` 或 `{ doi: string }`；非对象 / 空 / 类型错误 / 超长 → error。
 */
export function parseImportRequest(body: unknown): { input: string } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' }
  }
  const rec = body as Record<string, unknown>
  const pick = (v: unknown, field: string): { input: string } | { error: string } | null => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'string') return { error: `${field} 必须是字符串` }
    const s = v.trim()
    if (!s) return { error: `${field} 不能为空` }
    if (s.length > MAX_INPUT_LEN) return { error: `${field} 过长` }
    return { input: s }
  }
  const fromUrl = pick(rec.url, 'url')
  if (fromUrl) return fromUrl
  const fromDoi = pick(rec.doi, 'doi')
  if (fromDoi) return fromDoi
  return { error: '缺少 url 或 doi 字段' }
}

/* ============================ 运行期状态 ============================ */

interface Cfg {
  enabled: boolean
  port: number
  token: string
}

let server: Server | null = null
let starting = false
let lastError: string | null = null
let cfg: Cfg = { enabled: true, port: DEFAULT_PORT, token: '' }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function normalizePort(raw: string | undefined): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

/** 延迟加载设置模块（保持本文件可被纯逻辑单测直接 import：加载时不触碰 electron/db） */
function loadSettings(): Promise<typeof import('./settings')> {
  return import('./settings')
}

/** 读取配置（设置 > 环境变量 > 默认）；令牌缺失时生成 32 位十六进制并持久化 */
async function refreshConfig(): Promise<void> {
  try {
    const s = await loadSettings()
    const enabled = s.effective('connector.enabled', 'PAPERDESK_CONNECTOR_ENABLED', '1') !== '0'
    const port = normalizePort(
      s.effective('connector.port', 'PAPERDESK_CONNECTOR_PORT', String(DEFAULT_PORT))
    )
    let token = s.effective('connector.token', 'PAPERDESK_CONNECTOR_TOKEN', '')
    if (!token) {
      token = randomBytes(16).toString('hex')
      try {
        s.setRaw('connector.token', token)
      } catch {
        /* 持久化失败不阻断：内存内仍可用本次令牌 */
      }
    }
    cfg = { enabled, port, token }
  } catch (e) {
    lastError = errMsg(e)
  }
}

/** 当前状态（同步，使用最近一次刷新到的配置） */
export function connectorStatus(): ConnectorStatus {
  return {
    running: !!server,
    port: cfg.port,
    token: cfg.token,
    enabled: cfg.enabled,
    url: `http://${HOST}:${cfg.port}`
  }
}

/** 读取最新配置后的状态（供 IPC 使用；首次读取会生成令牌） */
export async function connectorStatusAsync(): Promise<ConnectorStatus> {
  await refreshConfig()
  return connectorStatus()
}

/* ============================ HTTP 服务 ============================ */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-paperdesk-token'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS })
    res.end(payload)
  } catch {
    /* 连接可能已关闭：忽略 */
  }
}

/** 读取请求体并做大小上限保护；超限或出错返回 null */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    let over = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        over = true
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method || 'GET').toUpperCase()
  let path = '/'
  try {
    path = new URL(req.url || '/', `http://${HOST}`).pathname
  } catch {
    path = '/'
  }

  // 预检：允许浏览器扩展 / 书签跨域调用
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  if (method === 'GET' && path === '/ping') {
    sendJson(res, 200, { ok: true, app: 'paperdesk', version: VERSION })
    return
  }

  if (method === 'POST' && path === '/import') {
    const rawToken = req.headers['x-paperdesk-token']
    const given = Array.isArray(rawToken) ? (rawToken[0] ?? null) : (rawToken ?? null)
    if (!checkToken(given, cfg.token)) {
      sendJson(res, 401, { ok: false, message: 'token 无效' })
      return
    }
    const raw = await readBody(req)
    if (raw === null) {
      sendJson(res, 400, { ok: false, message: '请求体过大或读取失败' })
      return
    }
    let parsed: unknown
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
      return
    }
    const req2 = parseImportRequest(parsed)
    if ('error' in req2) {
      sendJson(res, 400, { ok: false, message: req2.error })
      return
    }
    try {
      const { importFromUrl } = await import('./fetch-pdf')
      const result = await importFromUrl(req2.input)
      sendJson(res, 200, { ok: result.ok, message: result.message })
    } catch (e) {
      sendJson(res, 500, { ok: false, message: `导入失败：${errMsg(e)}` })
    }
    return
  }

  sendJson(res, 404, { ok: false, message: '未找到' })
}

function startServer(): void {
  if (server) return
  const srv = createServer((req, res) => {
    handle(req, res).catch((e) => {
      lastError = errMsg(e)
      console.error('[paperdesk] connector error:', e)
      sendJson(res, 500, { ok: false, message: '服务器内部错误' })
    })
  })
  srv.on('error', (e) => {
    lastError = errMsg(e)
    if (server === srv) server = null
    try {
      srv.close()
    } catch {
      /* ignore */
    }
    console.warn('[paperdesk] connector 无法监听:', lastError)
  })
  srv.on('listening', () => {
    lastError = null
    console.log(`[paperdesk] connector listening on http://${HOST}:${cfg.port}`)
  })
  try {
    srv.listen(cfg.port, HOST)
    server = srv
  } catch (e) {
    lastError = errMsg(e)
    server = null
    try {
      srv.close()
    } catch {
      /* ignore */
    }
  }
}

function stopServer(): void {
  const s = server
  server = null
  if (!s) return
  try {
    s.close()
  } catch {
    /* ignore */
  }
}

/** 启动（幂等）：仅在配置为启用时监听 127.0.0.1；端口占用不抛出，只记录 lastError */
export function startConnector(): void {
  void (async () => {
    if (server || starting) return
    starting = true
    try {
      await refreshConfig()
      if (!cfg.enabled) {
        stopServer()
        return
      }
      startServer()
    } catch (e) {
      lastError = errMsg(e)
    } finally {
      starting = false
    }
  })()
}

/** 关闭监听；可安全重复调用 */
export function stopConnector(): void {
  stopServer()
}

/** 切换启用状态并持久化；返回切换后的最新状态（IPC 用） */
export async function setConnectorEnabledAsync(enabled: boolean): Promise<ConnectorStatus> {
  await refreshConfig()
  cfg = { ...cfg, enabled }
  try {
    const s = await loadSettings()
    s.setRaw('connector.enabled', enabled ? '1' : '0')
  } catch (e) {
    lastError = errMsg(e)
  }
  if (enabled) startServer()
  else stopServer()
  return connectorStatus()
}

/** 同步切换（返回即时状态；持久化在后台完成） */
export function setConnectorEnabled(enabled: boolean): ConnectorStatus {
  void setConnectorEnabledAsync(enabled)
  return { ...connectorStatus(), enabled }
}

/** 供诊断：最近一次错误（不对外暴露于 ConnectorStatus） */
export function connectorLastError(): string | null {
  return lastError
}
