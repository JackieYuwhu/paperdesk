import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { chatMarkdownToHtml } from '@shared/chat-md'
import { groupPaperCount } from '@shared/ai-group'
import type {
  AiConversationSummary,
  AskProgress,
  AskProgressEvent,
  AskSelection,
  AskTask,
  AskWebMode,
  Citation,
  Item,
  KnowledgeHitRef,
  PaperFindResult,
  WebSource,
  WorkHit
} from '@shared/types'
import { sourceLabel, workKey, workOpenUrl, workPdfUrl } from '@shared/paper-hits'
import { aiToolBlockReason, type AiToolState } from '@shared/ai-tools'
import { planAsk, type SourceMessage } from '@shared/ask-intent'
import { AI_PRESETS, type AiPreset } from './presets'

/** 问答作用域：单篇 / 分组（含子分组）/ 全库 */
type AiScope = 'doc' | 'group' | 'all'

interface Props {
  onOpenCitation: (c: Citation) => void
  /** 来自阅读器划词的提问/名词解释/翻译请求（带选区上下文：原文/附件/页码） */
  request: { text: string; task: AskTask; selection?: AskSelection | null } | null
  onClearRequest: () => void
  /** 打开「设置」（LaTeX / 模型未配置时的直达入口） */
  onOpenSettings?: () => void
  /** 当前论文（问答默认限定在这一篇内检索） */
  attachmentId: number | null
  itemId: number | null
  items: Item[]
  /** 左栏当前分组：非空时提供「分组级问答」作用域 */
  groupName?: string | null
  /** 分组叶名（仅用于作用域文案） */
  groupLabel?: string
  /** 打开历史对话时切到对应论文 */
  onOpenTarget?: (t: { itemId: number | null; attachmentId: number | null; page: number | null }) => void
}

interface Msg {
  id: number
  role: 'user' | 'assistant'
  text: string
  citations?: Citation[]
  meta?: string
  /** 正在生成中的占位气泡 */
  pending?: boolean
  /** 联网检索状态：off=未启用 / on=已联网 / failed=尝试失败已降级 */
  web?: 'off' | 'on' | 'failed'
  webError?: string | null
  /** 联网关闭但仍被要求联网时的说明（本轮未发送搜索请求） */
  webHint?: string | null
  /** 联网命中的网页来源（[W1]…，点击用系统浏览器打开） */
  webSources?: WebSource[]
  /** 知识库命中（已发布条目，[K1]…） */
  knowledgeHits?: KnowledgeHitRef[]
  /** 本轮实际检索范围（论文片段/知识库/网页数量） */
  scopeLabel?: string
  /** 提问时附带的选区上下文（完整原文/附件/页码），供「翻译上面这段」回溯 */
  selection?: AskSelection | null
  /** 本轮调用失败：气泡内展示行内错误（不把错误当回答，也不进上下文） */
  failed?: boolean
}

/** 输入框自动增高的上限（px）：按 20px 行高 / 6px 上下内边距 / 1px 边框算约 8 行，超过后内部滚动 */
const AI_INPUT_MAX_HEIGHT = 176

/**
 * 问答：**对话式**界面。每轮以气泡呈现，支持连续追问（把上文作为上下文传给模型），
 * 划词「问 AI / 名词解释」也会作为一条用户消息进入同一对话。
 */
export function AiPanel({
  onOpenCitation,
  request,
  onClearRequest,
  onOpenSettings,
  attachmentId,
  itemId,
  items,
  groupName,
  groupLabel,
  onOpenTarget
}: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  /** 联网三态（来自设置键 ai.webSearch）：off 关闭 / auto 自动 / always 始终 */
  const [webMode, setWebMode] = useState<AskWebMode>('off')
  /** 三态的最新值：send 前会重读设置，失败时回退到这里 */
  const webModeRef = useRef<AskWebMode>('off')
  /** 「严格依据文献」：只用检索到的论文/知识库/网页，不给模型通用知识 */
  const [strict, setStrict] = useState(false)
  const strictRef = useRef(false)
  /**
   * 翻译目标语言（界面选择）：auto = 按原文自动推断。
   * 优先级低于用户显式指令（「翻译成中文」），高于自动推断。
   */
  const [targetLang, setTargetLang] = useState<'auto' | 'zh' | 'en'>(() => {
    try {
      const v = localStorage.getItem('paperdesk.ai.targetLang')
      return v === 'zh' || v === 'en' ? v : 'auto'
    } catch {
      return 'auto'
    }
  })
  const targetLangRef = useRef<'auto' | 'zh' | 'en'>(targetLang)
  /** 本轮进度（检索 → 知识库 → 联网 → 翻译 → 模型） */
  const [progress, setProgress] = useState<AskProgress | null>(null)
  /** 最近一次的选区上下文（划词/粘贴），供「翻译上面这段」引用 */
  const selectionRef = useRef<AskSelection | null>(null)
  /** 当前请求标识（取消用） */
  const requestIdRef = useRef('')
  useEffect(() => () => {
    if (requestIdRef.current) void window.api.ai.cancel(requestIdRef.current).catch(() => undefined)
  }, [])
  /**
   * AI 工具库（PD54）：联网检索是否被用户关掉。
   * 关闭后开关禁用并给出原因，实际请求也强制 web=false（不只靠界面禁用）。
   */
  const [toolStates, setToolStates] = useState<AiToolState[] | null>(null)
  const webSearchBlocked = aiToolBlockReason(toolStates, [
    { id: 'web-search', permission: 'network' }
  ])
  const webSearchBlockedRef = useRef('')
  webSearchBlockedRef.current = webSearchBlocked
  /** 「用 AI 找论文」结果（null = 未开启该视图） */
  const [papers, setPapers] = useState<PaperFindResult | null>(null)
  const [papersBusy, setPapersBusy] = useState(false)
  const [papersMsg, setPapersMsg] = useState('')
  /** 已入库的论文：workKey → 提示文案（防重复点击） */
  const [addedIds, setAddedIds] = useState<Record<string, string>>({})
  const idRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  /** AI 输入框（textarea）：随内容自动增高，超过上限后内部滚动 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * 按内容重算输入框高度：单行 34px（20px 行高 + 12px 内边距 + 2px 边框），每多一行 +20px，
   * 到 AI_INPUT_MAX_HEIGHT 后不再长高，改为内部滚动。
   */
  const growInput = useCallback((): void => {
    const el = inputRef.current
    if (!el) return
    // 面板隐藏（display:none）时量不到宽度，跳过；恢复可见时由 ResizeObserver 重测
    if (el.clientWidth === 0) return
    const scrollTop = el.scrollTop
    // 光标在末尾（正常追加输入/粘贴）且已超过上限时，保持看到最新一行
    const caretAtEnd = el.selectionStart === el.value.length
    // 先按「无滚动条 + 自动高度」测量，避免滚动条占宽导致换行数来回抖动
    el.style.height = 'auto'
    el.style.overflowY = 'hidden'
    // box-sizing:border-box：scrollHeight 不含边框，补上 offsetHeight-clientHeight
    const borders = Math.max(0, el.offsetHeight - el.clientHeight)
    const full = el.scrollHeight + borders
    el.style.height = `${Math.min(full, AI_INPUT_MAX_HEIGHT)}px`
    el.style.overflowY = full > AI_INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
    // 保持长文编辑时的滚动位置，避免每次输入都跳回顶部；追加输入时跟到最新一行
    el.scrollTop = caretAtEnd && full > AI_INPUT_MAX_HEIGHT ? el.scrollHeight : scrollTop
  }, [])

  // 内容变化（输入 / 粘贴 / 发送后清空 / 载入历史）后同步高度
  useLayoutEffect(() => {
    growInput()
  }, [input, growInput])

  // ---- 论文范围（像「附加文件」）：默认只和当前论文对话，可切到分组 / 全库 ----
  const scopeItem = items.find((i) => i.id === itemId) ?? null
  const [scopePref, setScopePref] = useState<AiScope>('doc')
  const hasGroup = typeof groupName === 'string' && groupName.trim() !== ''
  const groupCount = hasGroup ? groupPaperCount(items, groupName) : 0
  /** 生效作用域：没有分组时「分组」退化为单篇/全库；没有文档时退化为全库 */
  const scope: AiScope =
    scopePref === 'group' && hasGroup
      ? 'group'
      : scopePref !== 'all' && attachmentId != null
        ? 'doc'
        : 'all'
  const groupTitle = groupLabel || groupName || ''

  /** 引用详情展开状态（默认只显示简洁的 [n] p.X 标记） */
  const [expandedCites, setExpandedCites] = useState<Record<number, boolean>>({})

  // ---- 图片识别（公式 / 表格）：结果与「进行中」状态 ----
  const [formulaBusy, setFormulaBusy] = useState(false)
  const [formulaLatex, setFormulaLatex] = useState('')
  const [formulaMsg, setFormulaMsg] = useState('')
  /** 未配置模型：给出直达「设置」的入口 */
  const [formulaNeedsConfig, setFormulaNeedsConfig] = useState(false)
  const [tableBusy, setTableBusy] = useState(false)
  const [tableMd, setTableMd] = useState('')
  const [tableMsg, setTableMsg] = useState('')
  const [tableNeedsConfig, setTableNeedsConfig] = useState(false)
  const formulaFileRef = useRef<HTMLInputElement | null>(null)
  const tableFileRef = useRef<HTMLInputElement | null>(null)
  /** 图片请求代次：换论文 / 重开面板 / 开始新识别后，迟到的旧响应直接丢弃 */
  const runSeqRef = useRef(0)
  /** 粘贴图片时走哪个入口（跟随最近一次点击的按钮，默认公式） */
  const imageModeRef = useRef<'formula' | 'table'>('formula')
  const rootRef = useRef<HTMLDivElement | null>(null)

  /** 清空公式/表格的「进行中」状态与上一次结果（换论文、重开面板、开始新识别时调用） */
  const resetImageState = useCallback((): void => {
    runSeqRef.current += 1
    setFormulaBusy(false)
    setFormulaLatex('')
    setFormulaMsg('')
    setFormulaNeedsConfig(false)
    setTableBusy(false)
    setTableMd('')
    setTableMsg('')
    setTableNeedsConfig(false)
  }, [])

  // 换论文 → 重置对话（避免"参照上一篇回答"）与图片识别结果（载入历史对话时跳过对话重置）
  useEffect(() => {
    resetImageState()
    if (loadGuardRef.current !== null && loadGuardRef.current === attachmentId) {
      loadGuardRef.current = null
      return
    }
    setMessages([])
    setConvId(null)
    setConvTitle('')
    setStatus('')
    setScopePref('doc')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId])

  // 面板常驻挂载、靠 display:none 切换：从隐藏恢复可见时清掉上一次的图片识别结果；
  // 面板可见且宽度变化（缩放窗口 / 切面板）时按新宽度重算输入框高度
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let hidden = el.clientWidth === 0 || el.clientHeight === 0
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      const nowHidden = el.clientWidth === 0 || el.clientHeight === 0
      if (hidden && !nowHidden) resetImageState()
      if (!nowHidden && (hidden || el.clientWidth !== width)) growInput()
      hidden = nowHidden
      width = el.clientWidth
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [resetImageState, growInput])

  // ---- 对话历史 ----
  const [histOpen, setHistOpen] = useState(false)
  const [convs, setConvs] = useState<AiConversationSummary[]>([])
  const [convId, setConvId] = useState<number | null>(null)
  const [convTitle, setConvTitle] = useState('')
  /** 载入历史对话后切换论文时，避免被"换论文重置"逻辑清空 */
  const loadGuardRef = useRef<number | null>(null)

  const refreshConvs = useCallback(async (): Promise<void> => {
    try {
      setConvs(await window.api.ai.listConversations())
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    void refreshConvs()
  }, [refreshConvs])

  const fmtTime = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const newConversation = useCallback((): void => {
    setMessages([])
    setConvId(null)
    setConvTitle('')
    setStatus('')
    setHistOpen(false)
    // 新对话不继承上一轮选区：「翻译上面这段」不应指到别的论文去
    selectionRef.current = null
  }, [])

  const loadConversation = useCallback(
    async (c: AiConversationSummary): Promise<void> => {
      const data = await window.api.ai.getConversation(c.id)
      if (!data) return
      // 历史对话对应另一篇论文 → 先切过去（避免答非所问）
      if (c.itemId != null && c.itemId !== itemId) {
        loadGuardRef.current = c.attachmentId
        onOpenTarget?.({ itemId: c.itemId, attachmentId: c.attachmentId, page: null })
      }
      setMessages(
        data.messages.map((m, i) => ({
          id: i + 1,
          role: m.role,
          text: m.content,
          citations: m.citations ?? [],
          // 选区上下文随消息持久化：恢复对话后仍可「翻译上面这段」
          selection: m.context ?? null
        }))
      )
      // 接着往下问时沿用最后一条带选区的原文
      const withSel = [...data.messages].reverse().find((m) => m.context?.text)
      selectionRef.current = withSel?.context ?? null
      setConvId(c.id)
      setConvTitle(c.title)
      setHistOpen(false)
      setStatus('')
    },
    [itemId, onOpenTarget]
  )

  const renameConv = useCallback(
    async (c: AiConversationSummary): Promise<void> => {
      const t = window.prompt('重命名对话', c.title || '')
      if (t == null) return
      await window.api.ai.renameConversation(c.id, t)
      if (c.id === convId) setConvTitle(t.trim())
      await refreshConvs()
    },
    [convId, refreshConvs]
  )

  const removeConv = useCallback(
    async (id: number): Promise<void> => {
      if (!window.confirm('删除该对话记录？')) return
      await window.api.ai.deleteConversation(id)
      if (id === convId) newConversation()
      await refreshConvs()
    },
    [convId, newConversation, refreshConvs]
  )

  const readImageB64 = (file: File | Blob): Promise<{ b64: string; mime: string }> =>
    new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => {
        const s = String(fr.result || '')
        const i = s.indexOf(',')
        resolve({ b64: i >= 0 ? s.slice(i + 1) : s, mime: file.type || 'image/png' })
      }
      fr.onerror = () => reject(new Error('读取图片失败'))
      fr.readAsDataURL(file)
    })

  /** 图片 → 公式 / LaTeX（视觉模型）；开始新识别时清掉上一次结果与另一个入口的状态 */
  const runFormula = async (file: File | Blob): Promise<void> => {
    const seq = ++runSeqRef.current
    imageModeRef.current = 'formula'
    setTableBusy(false)
    setFormulaBusy(true)
    setFormulaLatex('')
    setFormulaMsg('识别中…')
    setFormulaNeedsConfig(false)
    try {
      const { b64, mime } = await readImageB64(file)
      const r = await window.api.ai.formula(b64, mime)
      if (seq !== runSeqRef.current) return // 已换论文/重开面板/开始新识别：丢弃迟到响应
      const latex = (r.latex || '').trim()
      setFormulaLatex(latex)
      if (!latex || r.kind === 'none') {
        setFormulaMsg(`该图片不包含公式（未生成 LaTeX）${r.note ? ` · ${r.note}` : ''}`)
      } else {
        const kind =
          r.kind === 'theorem' ? '定理' : r.kind === 'display' ? '行间公式' : '行内公式'
        setFormulaMsg(`${kind}${r.note ? ` · ${r.note}` : ''}`)
      }
    } catch (e) {
      if (seq !== runSeqRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      setFormulaLatex('')
      setFormulaMsg('识别失败：' + msg)
      setFormulaNeedsConfig(/未配置|Base URL|API ?Key|模型/i.test(msg))
    } finally {
      if (seq === runSeqRef.current) setFormulaBusy(false)
    }
  }

  /** 表格图片 → GitHub 风格 Markdown 表格（视觉模型） */
  const runTable = async (file: File | Blob): Promise<void> => {
    const seq = ++runSeqRef.current
    imageModeRef.current = 'table'
    setFormulaBusy(false)
    setTableBusy(true)
    setTableMd('')
    setTableMsg('识别中…')
    setTableNeedsConfig(false)
    try {
      const { b64, mime } = await readImageB64(file)
      const r = await window.api.ai.table(b64, mime)
      if (seq !== runSeqRef.current) return
      const md = (r.markdown || '').trim()
      if (!r.found || !md) {
        setTableMd('')
        setTableMsg(`该图片不包含表格（未生成 Markdown）${r.note ? ` · ${r.note}` : ''}`)
      } else {
        setTableMd(md)
        setTableMsg(`已转成 Markdown 表格 · ${md.split('\n').length} 行`)
      }
    } catch (e) {
      if (seq !== runSeqRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      setTableMd('')
      setTableMsg('识别失败：' + msg)
      setTableNeedsConfig(/未配置|Base URL|API ?Key|模型/i.test(msg))
    } finally {
      if (seq === runSeqRef.current) setTableBusy(false)
    }
  }

  const nextId = (): number => {
    idRef.current += 1
    return idRef.current
  }
  /** 只在用户已经贴近底部时才跟随滚动（避免打断向上翻阅引用） */
  const maybeScroll = (force = false): void => {
    requestAnimationFrame(() => {
      const el = listRef.current
      if (!el) return
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      if (force || nearBottom) el.scrollTop = el.scrollHeight
    })
  }

  /** 读取联网三态（读不到设置时按关闭处理：默认不联网）；返回最新值供 send 使用 */
  const refreshWebMode = async (): Promise<AskWebMode> => {
    try {
      const v = await window.api.settings.webSearchGet()
      const mode: AskWebMode = v === 'always' ? 'always' : v === 'auto' ? 'auto' : 'off'
      webModeRef.current = mode
      setWebMode(mode)
      // AI 工具库关掉联网检索（或它的联网权限）时，即使设置里还开着也不联网
      return webSearchBlockedRef.current ? 'off' : mode
    } catch {
      /* 读不到设置：保持当前值（默认关） */
      return webSearchBlockedRef.current ? 'off' : webModeRef.current
    }
  }

  /** 读取「严格依据文献」开关 */
  const refreshStrict = async (): Promise<boolean> => {
    try {
      const v = await window.api.settings.strictEvidenceGet()
      strictRef.current = v
      setStrict(v)
      return v
    } catch {
      return strictRef.current
    }
  }

  // 面板常驻：在设置里改过开关后（窗口重新获得焦点）要跟着变，不能一直用挂载时的旧值
  useEffect(() => {
    void refreshWebMode()
    void refreshStrict()
    const onFocus = (): void => {
      void refreshWebMode()
      void refreshStrict()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 进度事件：只接收本轮请求（requestId 过滤），逐阶段更新状态行
  useEffect(() => {
    const off = window.api.ai.onProgress((p: AskProgressEvent) => {
      if (!p || p.requestId !== requestIdRef.current) return
      setProgress({ phase: p.phase, done: p.done, total: p.total, message: p.message })
      setStatus(p.message)
    })
    return off
  }, [])

  // AI 工具库（PD54）：挂载时读一次，之后靠主进程广播跟随设置里的开关，立刻生效
  useEffect(() => {
    let alive = true
    void window.api.aiTools.list().then(
      (r) => {
        if (alive) setToolStates(r.tools)
      },
      () => {
        /* 读不到就按默认（可用）处理，不阻塞提问 */
      }
    )
    const off = window.api.onAiToolsChanged((r) => {
      setToolStates(r?.tools ?? null)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  /** 「用 AI 找论文」：用输入框（或最近一条提问）作为需求 */
  const findPapersNow = async (): Promise<void> => {
    if (papersBusy) return
    const q =
      input.trim() ||
      [...messages].reverse().find((m) => m.role === 'user' && !m.pending)?.text.trim() ||
      ''
    if (!q) {
      setPapers(null)
      setPapersMsg('先在输入框里写一句需求，例如「近三年扩散模型在医学图像分割的论文」')
      return
    }
    setPapersBusy(true)
    setPapersMsg('正在把需求转成检索式并检索学术库…')
    setPapers(null)
    setAddedIds({})
    try {
      const r = await window.api.ai.findPapers(q, { limit: 8 })
      setPapers(r)
      setPapersMsg(r.works.length ? '' : r.warnings[0] ?? '没有检索到相关论文')
    } catch (e) {
      setPapersMsg('找论文失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setPapersBusy(false)
    }
  }

  /**
   * 一键入库 / 导入分组：addMetadata 落库，再调 setGroup（同组也调用一次）
   * —— addMetadata 不广播 libraryChanged，setGroup 会，左栏和列表因此即时刷新。
   */
  const addPaper = async (w: WorkHit, toGroup: boolean): Promise<void> => {
    const key = workKey(w)
    if (!key || addedIds[key]) return
    try {
      const item = await window.api.library.addMetadata({
        title: w.title,
        doi: w.doi,
        year: w.year,
        venue: w.venue
      })
      const target = toGroup ? groupName ?? null : null
      try {
        await window.api.library.setGroup(item.id, target)
      } catch {
        /* 已在目标分组 / 分组不存在：入库本身已成功 */
      }
      setAddedIds((prev) => ({
        ...prev,
        [key]: toGroup && groupName ? `已加入分组「${groupLabel ?? groupName}」` : '已入库'
      }))
    } catch (e) {
      setPapersMsg('入库失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const send = async (qArg?: string, taskArg?: AskTask, selArg?: AskSelection | null): Promise<void> => {
    const q = (qArg ?? input).trim()
    if (!q || busy) return
    const baseTask: AskTask = taskArg ?? 'qa'
    // 设置里可能刚改过：下发前重读一次，避免面板按旧状态静默走离线
    const wantedWeb = await refreshWebMode()
    const strictNow = await refreshStrict()
    // 选区：本次显式传入优先；否则沿用最近一次划词（同一轮追问仍可引用）
    const sel = selArg ?? selectionRef.current
    // 上下文 = 之前已完成的消息（不含占位与失败提示）；原文全文一并带上，供「翻译上面这段」回溯
    const historyMsgs: SourceMessage[] = messages
      .filter((m) => !m.pending && !m.failed && m.text)
      .map((m) => ({ role: m.role, content: m.text, selection: m.selection ?? null }))
    // 任务判定：明确要求翻译 → 直接进翻译流程（不以检索命中为前提）
    const plan = planAsk(q, historyMsgs, baseTask, sel, targetLangRef.current)
    const task: AskTask = plan.task
    const sourceText = plan.inlineText ?? plan.source?.text ?? ''
    const pendingId = nextId()
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text: q, selection: plan.source },
      { id: pendingId, role: 'assistant', text: '', pending: true }
    ])
    setInput('')
    setBusy(true)
    setProgress(null)
    setStatus(
      task === 'translate'
        ? '准备翻译…'
        : task === 'term'
          ? '解释中…'
          : wantedWeb !== 'off'
            ? '联网检索中…'
            : '思考中…'
    )
    maybeScroll(true)
    const requestId = `r${Date.now()}-${pendingId}`
    requestIdRef.current = requestId
    const streamId = `s${Date.now()}-${pendingId}`
    // 作用域 → 请求参数：单篇带 attachmentId；分组带 groupName（附件置空）；全库都为空。
    // 划词名词解释/翻译仍按原行为（单篇带附件、否则全库），不受分组作用域影响。
    const scopeAttachmentId =
      task === 'term' || task === 'translate' || scope === 'doc' ? attachmentId : null
    const scopeGroupName = task === 'qa' && scope === 'group' ? groupName : null
    // ---- 对话历史：首次发送时建会话，随后逐条落库 ----
    let cid = convId
    try {
      if (cid == null) {
        const c = await window.api.ai.createConversation({
          itemId,
          attachmentId: scopeAttachmentId
        })
        cid = c.id
        setConvId(cid)
      }
      await window.api.ai.appendMessage(cid, {
        role: 'user',
        content: q,
        // 选区上下文与原文随消息持久化：重启/切换对话后「翻译上面这段」仍可回溯
        context: plan.source ?? null
      })
    } catch {
      /* 落库失败不影响回答 */
    }
    try {
      const r = await window.api.ai.askStream(
        q,
        {
          mode: 'hybrid',
          task,
          history: historyMsgs.map((m) => ({ role: m.role, content: m.content })),
          attachmentId: scopeAttachmentId,
          groupName: scopeGroupName,
          web: wantedWeb,
          strict: strictNow,
          selection: plan.source ?? null,
          sourceText: task === 'translate' ? sourceText : '',
          targetLang: plan.targetLang ?? undefined,
          requestId,
          streamId
        },
        (delta) => {
          // 逐段追加（第一段到达即结束"正在生成"占位，并退出「检索中」）
          setStatus((s) => (s.includes('中…') || s.includes('…') ? '思考中…' : s))
          setMessages((prev) =>
            prev.map((m) =>
              m.id === pendingId ? { ...m, text: (m.text ?? '') + delta, pending: false } : m
            )
          )
          maybeScroll()
        }
      )
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                id: pendingId,
                role: 'assistant',
                // 失败时也保留已检索到的网页/知识库来源，只把正文换成失败原因
                text: r.error ?? r.answer,
                failed: !!r.error,
                citations: r.citations,
                web: r.web,
                webError: r.webError ?? null,
                webHint: r.webHint ?? null,
                webSources: r.webSources ?? [],
                knowledgeHits: r.knowledgeHits ?? [],
                scopeLabel: r.scopeLabel ?? '',
                selection: plan.source ?? null,
                meta: [
                  r.translation ? `翻译 · ${r.translation.chunks} 段` : '',
                  r.backend ? `检索：${r.backend}` : '',
                  r.strict ? '严格依据文献' : '',
                  r.mode?.includes('+truncated') ? '上下文已截断' : '',
                  r.webMode ? `联网：${r.webMode === 'always' ? '始终' : r.webMode === 'auto' ? '自动' : '关闭'}` : '',
                  r.web === 'on' ? `已联网 · 网页 ${r.webSources?.length ?? 0}` : '',
                  r.web === 'failed'
                    ? `未联网${r.webError ? `：${r.webError}` : '：搜索失败（可在设置里填写代理后重试）'}`
                    : '',
                  r.webHint ?? ''
                ]
                  .filter(Boolean)
                  .join(' · ')
              }
            : m
        )
      )
      // 落库 + 首个回答后生成标题（AI 生成，失败回退首问截断）；失败轮次不落空回答
      if (cid != null && !r.error) {
        try {
          await window.api.ai.appendMessage(cid, {
            role: 'assistant',
            content: r.answer,
            citations: r.citations
          })
          if (!convTitle) {
            const t = await window.api.ai.generateTitle(cid)
            setConvTitle(t)
          }
          await refreshConvs()
        } catch {
          /* 忽略 */
        }
      }
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                id: pendingId,
                role: 'assistant',
                text: e instanceof Error ? e.message : String(e),
                failed: true
              }
            : m
        )
      )
    } finally {
      setBusy(false)
      setStatus('')
      setProgress(null)
      requestIdRef.current = ''
      // 不再强制滚到底：用户可能正在向上看引用
    }
  }

  /** 取消本轮（模型请求断开；分段翻译保留已完成段并在气泡里标注已取消） */
  const cancelNow = async (): Promise<void> => {
    const id = requestIdRef.current
    if (!id) return
    setStatus('正在取消…')
    try {
      await window.api.ai.cancel(id)
    } catch {
      /* 取消失败：请求仍会自然结束 */
    }
  }

  /**
   * 空态功能按键：只把预设提示写入输入框（覆盖旧草稿），不自动发送。
   * 等 React 提交受控值后再聚焦并把光标落到末尾，避免受控 textarea 把光标重置到开头。
   */
  const applyPreset = useCallback((preset: AiPreset): void => {
    setInput(preset.prompt)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }, [])

  // 阅读器划词 → 作为一条用户消息进入同一对话（带完整选区上下文：原文/附件/页码）
  useEffect(() => {
    if (!request) return
    onClearRequest()
    if (request.selection) selectionRef.current = request.selection
    void send(request.text, request.task, request.selection ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && !m.pending)

  return (
    <div
      className="panel ai"
      ref={rootRef}
      onPaste={(e) => {
        const f = Array.from(e.clipboardData?.files ?? [])[0]
        if (f && /^image\//.test(f.type)) {
          e.preventDefault()
          void (imageModeRef.current === 'table' ? runTable(f) : runFormula(f))
        }
      }}
    >
      <div className="panel__bar">
        <span className="sidebar__title">对话</span>
        <span className="toolbar__spacer" />
        <button
          className="icon ghost"
          title="新建对话"
          data-testid="ai-new"
          onClick={newConversation}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          className={`icon ghost${histOpen ? ' on' : ''}`}
          title="对话历史"
          data-testid="ai-history-btn"
          onClick={() => {
            setHistOpen((v) => !v)
            void refreshConvs()
          }}
        >
          <Icon name="list" size={14} />
        </button>
        <button
          className={`icon ghost${papers || papersBusy ? ' on' : ''}`}
          title="用 AI 找论文：把一句话需求变成论文列表，可一键入库"
          data-testid="ai-find-papers"
          disabled={papersBusy}
          onClick={() => void findPapersNow()}
        >
          <Icon name="search" size={14} />
        </button>
        <button
          className="icon ghost"
          title="清空当前对话"
          data-testid="ai-clear"
          disabled={messages.length === 0}
          onClick={() => setMessages([])}
        >
          <Icon name="trash" size={14} />
        </button>
        <button
          className="icon ghost"
          title="图片 → LaTeX：选择公式截图（也可直接把图片粘贴到面板）"
          data-testid="ai-formula"
          disabled={formulaBusy}
          onClick={() => {
            imageModeRef.current = 'formula'
            formulaFileRef.current?.click()
          }}
        >
          <Icon name="file" size={14} />
        </button>
        <input
          ref={formulaFileRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="ai-formula-file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void runFormula(f)
            e.target.value = ''
          }}
        />
        <button
          className="icon ghost"
          title="表格 → Markdown：选择表格截图（也可先把图片粘贴到面板）"
          data-testid="ai-table"
          disabled={tableBusy}
          onClick={() => {
            imageModeRef.current = 'table'
            tableFileRef.current?.click()
          }}
        >
          <Icon name="layers" size={14} />
        </button>
        <input
          ref={tableFileRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="ai-table-file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void runTable(f)
            e.target.value = ''
          }}
        />
      </div>

      {(formulaLatex || formulaMsg) && (
        <div className="meta__section" data-testid="ai-formula-result">
          <div className="meta__label">公式（LaTeX）</div>
          {formulaMsg && <div className="meta__muted">{formulaMsg}</div>}
          {formulaNeedsConfig && (
            <div className="tr-sel__actions">
              <button
                className="ghost"
                data-testid="ai-formula-settings"
                onClick={() => onOpenSettings?.()}
              >
                <Icon name="settings" size={13} />
                去设置
              </button>
              <span className="meta__muted">配置支持视觉的模型后即可识别</span>
            </div>
          )}
          {formulaLatex && (
            <>
              <textarea
                className="ai__result ai__result--short"
                readOnly
                value={formulaLatex}
                data-testid="ai-formula-latex"
              />
              <div className="tr-sel__actions">
                <button
                  className="ghost"
                  data-testid="ai-formula-copy"
                  onClick={() => void navigator.clipboard.writeText(formulaLatex)}
                >
                  <Icon name="check" size={13} />
                  复制
                </button>
                <button
                  className="ghost"
                  data-testid="ai-formula-clear"
                  onClick={() => {
                    setFormulaLatex('')
                    setFormulaMsg('')
                  }}
                >
                  清空
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {(tableMd || tableMsg) && (
        <div className="meta__section" data-testid="ai-table-result">
          <div className="meta__label">表格（Markdown）</div>
          {tableMsg && <div className="meta__muted">{tableMsg}</div>}
          {tableNeedsConfig && (
            <div className="tr-sel__actions">
              <button
                className="ghost"
                data-testid="ai-table-settings"
                onClick={() => onOpenSettings?.()}
              >
                <Icon name="settings" size={13} />
                去设置
              </button>
              <span className="meta__muted">配置支持视觉的模型后即可识别</span>
            </div>
          )}
          {tableMd && (
            <>
              <textarea
                className="ai__result"
                readOnly
                value={tableMd}
                data-testid="ai-table-md"
              />
              <div className="tr-sel__actions">
                <button
                  className="ghost"
                  data-testid="ai-table-copy"
                  onClick={() => void navigator.clipboard.writeText(tableMd)}
                >
                  <Icon name="check" size={13} />
                  复制
                </button>
                <button
                  className="ghost"
                  data-testid="ai-table-clear"
                  onClick={() => {
                    setTableMd('')
                    setTableMsg('')
                  }}
                >
                  清空
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 问答作用域：单篇 / 分组（含子分组）全部论文 / 全库 */}
      <div className="ai__scope" data-testid="ai-scope">
        {scope === 'group' ? (
          <span className="ai__scope-doc" title={groupName ?? ''}>
            <Icon name="library" size={13} />
            <span className="ai__scope-title">
              分组「{groupTitle}」· {groupCount} 篇
            </span>
          </span>
        ) : scope === 'doc' ? (
          <span className="ai__scope-doc" title={scopeItem?.title ?? ''}>
            <Icon name="file" size={13} />
            <span className="ai__scope-title">{scopeItem?.title ?? `附件 #${attachmentId}`}</span>
          </span>
        ) : (
          <span className="ai__scope-all">
            <Icon name="library" size={13} /> 全库检索（未限定论文）
          </span>
        )}
        <span className="toolbar__spacer" />
        <button
          className={`ghost${webMode !== 'off' ? ' on' : ''}`}
          data-testid="ai-web-mode"
          disabled={!!webSearchBlocked}
          title={
            webSearchBlocked
              ? `${webSearchBlocked}：到 设置 → AI 工具库 重新打开（或恢复默认）`
              : webMode === 'always'
                ? '联网：始终——每轮都搜索网页并列出 [W1] 来源（点击改为关闭）'
                : webMode === 'auto'
                  ? '联网：自动——只在论文与知识库都没有依据时搜索网页（点击改为始终）'
                  : '联网：关闭——不发送任何搜索请求，只用论文与知识库（点击改为自动）'
          }
          onClick={() => {
            if (webSearchBlockedRef.current) return
            // 三态循环：关闭 → 自动 → 始终 → 关闭
            const next: AskWebMode =
              webMode === 'off' ? 'auto' : webMode === 'auto' ? 'always' : 'off'
            webModeRef.current = next
            setWebMode(next)
            void window.api.settings.webSearchSet(next).catch(() => {
              /* 写入失败也不阻塞提问 */
            })
          }}
        >
          <Icon name="external" size={12} />
          联网：{webMode === 'always' ? '始终' : webMode === 'auto' ? '自动' : '关闭'}
        </button>
        <button
          className={`ghost${strict ? ' on' : ''}`}
          data-testid="ai-strict-toggle"
          title={
            strict
              ? '严格依据文献：仅用检索到的论文/知识库/网页回答，没有依据就明确说没有（点击关闭）'
              : '当前允许模型用通用知识补充（会标注【模型知识】）；点击切换到严格依据文献'
          }
          onClick={() => {
            const next = !strict
            strictRef.current = next
            setStrict(next)
            void window.api.settings.strictEvidenceSet(next).catch(() => {
              /* 写入失败也不阻塞提问 */
            })
          }}
        >
          <Icon name="book" size={12} />
          {strict ? '严格' : '通用'}
        </button>
        <select
          className="ai__lang"
          data-testid="ai-target-lang"
          value={targetLang}
          title={
            '翻译目标语言：用户明确说「翻译成中文/英文」时以其为准；否则用这里的偏好；' +
            '「自动」= 按原文语种推断（中文原文译英文，英文原文译中文）'
          }
          onChange={(e) => {
            const v = e.target.value === 'zh' || e.target.value === 'en' ? e.target.value : 'auto'
            targetLangRef.current = v
            setTargetLang(v)
            try {
              localStorage.setItem('paperdesk.ai.targetLang', v)
            } catch {
              /* 隐私模式等不可写：仅本次会话生效 */
            }
          }}
        >
          <option value="auto">译文：自动</option>
          <option value="zh">译文：中文</option>
          <option value="en">译文：英文</option>
        </select>
        {hasGroup && (
          <button
            className="ghost"
            data-testid="ai-scope-group"
            title={
              scope === 'group'
                ? '退出分组，回到单篇/全库'
                : `改为分组「${groupTitle}」的全部 ${groupCount} 篇论文`
            }
            onClick={() =>
              setScopePref(scope === 'group' ? (attachmentId != null ? 'doc' : 'all') : 'group')
            }
          >
            {scope === 'group' ? '退出分组' : '分组'}
          </button>
        )}
        {attachmentId != null && (
          <button
            className="ghost"
            data-testid="ai-scope-toggle"
            title={scope === 'doc' ? '改为全库检索' : '限定为当前论文'}
            onClick={() => setScopePref(scope === 'doc' ? 'all' : 'doc')}
          >
            {scope === 'doc' ? '全库' : '限定本文'}
          </button>
        )}
      </div>

      {histOpen && (
        <div className="ai__hist" data-testid="ai-history">
          <div className="ai__hist-head">
            <span className="ai__hist-head-title">对话历史</span>
            <span className="toolbar__spacer" />
            <button className="ghost" data-testid="ai-hist-new" onClick={newConversation}>
              <Icon name="plus" size={13} />
              新建
            </button>
            <button
              className="icon ghost"
              title="返回对话"
              data-testid="ai-hist-close"
              onClick={() => setHistOpen(false)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          {convs.length === 0 && <div className="ai__hint">还没有历史对话。</div>}
          {convs.map((c) => (
            <div key={c.id} className="ai__hist-item" data-testid={`ai-hist-${c.id}`}>
              <button className="ai__hist-open" onClick={() => void loadConversation(c)}>
                <span className="ai__hist-title">{c.title || '（未命名）'}</span>
                <span className="ai__hist-meta">
                  <Icon name="file" size={11} /> {c.attachmentName ?? c.itemTitle ?? '未关联论文'}
                  {c.messageCount ? ` · ${c.messageCount} 条` : ''} · {fmtTime(c.updatedAt)}
                </span>
              </button>
              <button
                className="icon ghost"
                title="重命名"
                data-testid={`ai-hist-rename-${c.id}`}
                onClick={() => void renameConv(c)}
              >
                <Icon name="notes" size={13} />
              </button>
              <button
                className="icon ghost"
                title="删除"
                data-testid={`ai-hist-del-${c.id}`}
                onClick={() => void removeConv(c.id)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 「用 AI 找论文」结果面板：结构化卡片 + 一键入库 / 导入分组 / 下载 PDF */}
      {(papers || papersBusy || papersMsg) && !histOpen && (
        <div
          className="ai__hist"
          data-testid="ai-papers"
          style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
        >
          <div className="ai__hist-head">
            <span className="ai__hist-head-title">
              <Icon name="search" size={13} /> 用 AI 找论文
            </span>
            <span className="toolbar__spacer" />
            <button
              className="icon ghost"
              title="返回对话"
              data-testid="ai-papers-close"
              onClick={() => {
                setPapers(null)
                setPapersMsg('')
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          {papers && (
            <div className="ai__hint">
              需求：{papers.query || '（空）'}
              {papers.queryByAi ? ' · 检索式由模型生成' : ''}
              {papers.providers.length ? ` · 来源：${papers.providers.join(' + ')}` : ''}
            </div>
          )}
          {papersMsg && (
            <div className="ai__hint" data-testid="ai-papers-msg">
              {papersMsg}
            </div>
          )}
          {papers?.works.map((w, i) => {
            const key = workKey(w)
            const done = addedIds[key]
            const pdf = workPdfUrl(w)
            const openUrl = workOpenUrl(w)
            return (
              <div
                key={key || i}
                className="ai__hist-item"
                style={{ display: 'block' }}
                data-testid={`ai-paper-${i}`}
              >
                <button
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text)',
                    font: 'inherit',
                    fontWeight: 600,
                    cursor: openUrl ? 'pointer' : 'default',
                    padding: 0
                  }}
                  title={openUrl ? `打开：${openUrl}` : undefined}
                  onClick={() => {
                    if (openUrl) void window.api.app.openExternal(openUrl)
                  }}
                >
                  {i + 1}. {w.title || '(无标题)'}
                </button>
                <div className="ai__hist-meta" style={{ display: 'block', whiteSpace: 'normal', marginTop: 3 }}>
                  {[w.authors?.slice(0, 4).join(', '), w.year ? String(w.year) : '', w.venue ?? '']
                    .filter(Boolean)
                    .join(' · ') || '作者/年份未知'}
                </div>
                {w.doi && (
                  <div className="ai__hist-meta" style={{ display: 'block' }}>
                    DOI：{w.doi}
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' }}>
                  <span className="ai__cite-chip" style={{ cursor: 'default' }} data-testid={`ai-paper-source-${i}`}>
                    {sourceLabel(w)}
                  </span>
                  <span className="toolbar__spacer" />
                  <button
                    className="ghost"
                    data-testid={`ai-paper-add-${i}`}
                    disabled={!!done}
                    title="加入论文库（重复论文会自动识别）"
                    onClick={() => void addPaper(w, false)}
                  >
                    <Icon name={done ? 'check' : 'plus'} size={12} /> {done ?? '一键入库'}
                  </button>
                  {groupName && (
                    <button
                      className="ghost"
                      data-testid={`ai-paper-group-${i}`}
                      disabled={!!done}
                      title={`加入分组「${groupLabel ?? groupName}」`}
                      onClick={() => void addPaper(w, true)}
                    >
                      <Icon name="library" size={12} /> 导入分组
                    </button>
                  )}
                  {pdf && (
                    <button
                      className="ghost"
                      data-testid={`ai-paper-pdf-${i}`}
                      title="下载开放获取 PDF 并导入"
                      onClick={() => {
                        void window.api.library
                          .importFromUrl(pdf, groupName ?? null)
                          .catch((e: unknown) => {
                            setPapersMsg(
                              '下载 PDF 失败：' + (e instanceof Error ? e.message : String(e))
                            )
                          })
                      }}
                    >
                      <Icon name="file" size={12} /> 下载 PDF
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {papers && papers.works.length === 0 && (
            <div className="ai__hint">
              换一个更具体的主题 / 方法名 / 作者再试，或检查网络与「设置」里的学术库配置。
            </div>
          )}
        </div>
      )}

      <div className="ai__chat" data-testid="ai-chat" ref={listRef} style={histOpen || papers || papersBusy ? { display: 'none' } : undefined}>
        {messages.length === 0 && (
          <div className="ai__presets" data-testid="ai-preset-group" role="group" aria-label="常用提问">
            {AI_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className="ai__preset"
                data-testid={`ai-preset-${preset.key}`}
                title={preset.prompt}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`ai__msg ai__msg--${m.role}`}
            data-testid={m.role === 'user' ? 'ai-msg-user' : 'ai-msg-assistant'}
          >
            <div
              className="ai__bubble"
              {...(m.id === lastAssistant?.id ? { 'data-testid': 'ai-answer' } : {})}
            >
              {m.pending ? (
                <span className="ai__typing" aria-label="正在生成">
                  <i />
                  <i />
                  <i />
                </span>
              ) : m.failed ? (
                <div className="state state--inline state--error ai__error" role="alert">
                  <div className="state__title">回答失败</div>
                  <div className="state__detail">{m.text}</div>
                </div>
              ) : (
                <div
                  className="ai__md"
                  dangerouslySetInnerHTML={{ __html: chatMarkdownToHtml(m.text ?? '') }}
                />
              )}
            </div>
            {m.meta && !m.pending && (
              <div
                className="ai__msg-meta meta__muted"
                {...(m.id === lastAssistant?.id ? { 'data-testid': 'ai-web-meta' } : {})}
              >
                {m.meta}
              </div>
            )}
            {!m.pending && m.scopeLabel && (
              <div className="ai__msg-meta meta__muted" data-testid="ai-scope-label">
                {m.scopeLabel}
              </div>
            )}
            {!m.pending && m.web === 'failed' && m.id === lastAssistant?.id && (
              <button
                className="ghost ai__web-fix"
                data-testid="ai-web-fix"
                title="检查网络连接，或在设置里填写检索代理后重试"
                onClick={onOpenSettings}
              >
                检查网络 / 设置代理
              </button>
            )}
            {!m.pending && m.webSources && m.webSources.length > 0 && (
              <div
                className="ai__cites"
                {...(m.id === lastAssistant?.id ? { 'data-testid': 'ai-web-sources' } : {})}
              >
                <div className="ai__cites-row">
                  {m.webSources.map((s) => (
                    <button
                      key={`w${s.index}`}
                      className="ai__cite-chip"
                      title={`${s.title}\n${s.url}${s.snippet ? `\n\n${s.snippet}` : ''}`}
                      data-testid={`ai-web-source-${s.index}`}
                      onClick={() => void window.api.app.openExternal(s.url)}
                    >
                      [W{s.index}] {s.site ?? s.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!m.pending && m.knowledgeHits && m.knowledgeHits.length > 0 && (
              <div
                className="ai__cites"
                {...(m.id === lastAssistant?.id ? { 'data-testid': 'ai-kb-cites' } : {})}
              >
                <div className="ai__cites-row">
                  {m.knowledgeHits.map((k, i) => (
                    <button
                      key={`k${k.id}`}
                      className="ai__cite-chip"
                      title={`知识库 · ${k.kind}\n${k.title}\n${k.snippet}`}
                      data-testid={`ai-kb-cite-${i + 1}`}
                      onClick={() =>
                        onOpenTarget?.({
                          itemId: k.itemId,
                          attachmentId: k.attachmentId,
                          page: null
                        })
                      }
                    >
                      [K{i + 1}] {k.title || k.kind}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {m.citations && m.citations.length > 0 && (
              <div
                className="ai__cites"
                {...(m.id === lastAssistant?.id ? { 'data-testid': 'ai-cites' } : {})}
              >
                <div className="ai__cites-row">
                  {m.citations.map((c) => (
                    <button
                      key={`${c.itemId ?? 'x'}:${c.chunkId}:${c.index}`}
                      className="ai__cite-chip"
                      title={c.snippet}
                      data-testid={`ai-cite-${c.index}`}
                      onClick={() => onOpenCitation(c)}
                    >
                      [{c.index}] <span className="ai__cite-page">p.{c.page}</span>
                    </button>
                  ))}
                  <button
                    className="ghost ai__cites-toggle"
                    onClick={() => setExpandedCites((prev) => ({ ...prev, [m.id]: !prev[m.id] }))}
                  >
                    {expandedCites[m.id] ? '收起引用' : `引用 ${m.citations.length} 条`}
                  </button>
                </div>
                {expandedCites[m.id] && (
                  <ol className="ai__cites-detail">
                    {m.citations.map((c) => (
                      <li key={`${c.itemId ?? 'x'}:${c.chunkId}:${c.index}`} className="ai__cite" onClick={() => onOpenCitation(c)}>
                        <span className="ai__cite-idx">[{c.index}]</span>
                        <span className="ai__cite-text">{c.snippet}</span>
                        <span className="ai__cite-page">p.{c.page} ↗</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="ai__composer">
        <textarea
          ref={inputRef}
          className="ai__input"
          rows={1}
          placeholder="输入问题，Enter 发送…"
          value={input}
          data-testid="ai-input"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          className="primary"
          disabled={busy || !input.trim()}
          onClick={() => void send()}
          data-testid="ai-ask"
        >
          <Icon name="sparkles" size={14} />
          {busy ? '…' : '发送'}
        </button>
      </div>
      {(status || busy) && (
        <div className="panel__status ai__progress" data-testid="ai-status">
          <span className="ai__progress-text">{status || '处理中…'}</span>
          {progress && progress.total > 1 && (
            <span
              className="ai__progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              data-testid="ai-progress"
              title={`${progress.message}（${progress.done}/${progress.total}）`}
            >
              <span
                className="ai__progress-fill"
                style={{ width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }}
              />
            </span>
          )}
          {busy && (
            <button
              className="ghost ai__cancel"
              data-testid="ai-cancel"
              title="取消本轮（分段翻译会保留已完成的段落）"
              onClick={() => void cancelNow()}
            >
              <Icon name="stop" size={11} /> 取消
            </button>
          )}
        </div>
      )}
    </div>
  )
}
