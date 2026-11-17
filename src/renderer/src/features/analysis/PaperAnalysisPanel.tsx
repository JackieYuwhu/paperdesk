import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from '../../components/Icon'
import { checkAnalysis, formatQuality } from '@shared/analysis-check'
import { diffStats, lineDiff } from '@shared/diff'
import type { DiffRow } from '@shared/diff'
import { markdownToHtml, splitBySections } from '@shared/md-html'
import {
  markdownTableToCsv,
  markdownTableToRows,
  projectRows,
  tableRowsToCsv,
  visibleColumnIndexes
} from '@shared/md-table'
import { nextSortState, sortRowsByColumn } from '@shared/md-table-sort'
import type { SortState } from '@shared/md-table-sort'
import { analysisSectionKey, clampSectionIndex, parseSectionIndex } from '@shared/analysis-state'
import { filterOutlineIndexes } from '@shared/outline-search'
import { describeDigestSyncResult } from '@shared/api'
import { aiToolBlockReason, type AiToolState } from '@shared/ai-tools'
import type { Item } from '@shared/types'

type Depth = 'brief' | 'standard' | 'deep'

/** IPC 错误带 "Error invoking remote method 'x': Error:" 前缀，去掉后才是给用户看的文案 */
function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim()
}

interface Props {
  itemId: number | null
  attachmentId: number | null
  items: Item[]
  onNotesChanged: () => void
  /** 深链跳转（点击 [p.N] 定位原文页） */
  onDeepLink: (url: string) => void
  /** 把「拆解论文 / 批次对比」加入批处理 */
  onAddToBatch?: (taskId: string) => void
}

/** 阅读 → 拆解论文（paper-analysis 技能） */
export function PaperAnalysisPanel({
  itemId,
  attachmentId,
  items,
  onNotesChanged,
  onDeepLink,
  onAddToBatch
}: Props): React.JSX.Element {
  const [focus, setFocus] = useState('')
  const [depth, setDepth] = useState<Depth>('standard')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    markdown: string
    backend: string
    label: string
    note?: string
  } | null>(null)
  // 同一篇论文的历次拆解（最多留 3 次），用于「与上次对比」
  const [history, setHistory] = useState<Array<{ label: string; markdown: string }>>([])
  const [showDiff, setShowDiff] = useState(false)
  const [diffOnly, setDiffOnly] = useState(true)
  const [collapseAll, setCollapseAll] = useState(false)
  const [secKey, setSecKey] = useState(0)
  // 大纲当前高亮的小节（点击 / 滚动联动）
  const [activeSec, setActiveSec] = useState(0)
  // 大纲搜索词（过滤显示的小节条目）
  const [outlineQuery, setOutlineQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // 大纲按钮（用于方向键在条目间移动焦点）
  const outlineRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [notice, setNotice] = useState('')
  const [current, setCurrent] = useState<Item | null>(null)
  /** 「归档到笔记」的可见反馈：idle / busy / done / error（按钮就在旁边显示，避免"点了没反应"） */
  const [noteState, setNoteState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  /** 「同步到知识库」的反馈与文案（PD38）；只创建待审提案，不发布正式条目 */
  const [digestState, setDigestState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [digestNotice, setDigestNotice] = useState('')
  /** 「同步到思维地图」的反馈与文案（PD38） */
  const [mapState, setMapState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [mapNotice, setMapNotice] = useState('')
  /**
   * PD54：AI 工具库状态。拆解同步（或其「写入知识库」权限）被关闭时，
   * 两个同步按钮禁用并给出原因，入口仍然可见。
   */
  const [toolStates, setToolStates] = useState<AiToolState[] | null>(null)
  const digestSyncBlocked = aiToolBlockReason(toolStates, [
    { id: 'digest-sync', permission: 'write-knowledge' }
  ])
  // 拆解/对比进行中的已用时（秒），用于加载动画让用户知道大概还要等多久
  const [elapsed, setElapsed] = useState(0)

  // 批次：从文库勾选要对比的论文
  const [picked, setPicked] = useState<number[]>([])
  const [busyBatch, setBusyBatch] = useState(false)
  const [batch, setBatch] = useState<{ compare: string; cards: number; backend: string } | null>(null)
  // 对比表按维度浏览：选中的列 + 该列筛选词
  const [compareCol, setCompareCol] = useState(0)
  const [compareFilter, setCompareFilter] = useState('')
  // 对比表按列排序（null = 不排序）
  const [sort, setSort] = useState<SortState | null>(null)
  // 对比表隐藏的列（持久化到 localStorage，默认全部显示）
  const [hiddenCols, setHiddenCols] = useState<number[]>(() => {
    try {
      const raw = window.localStorage.getItem('paperdesk.compare.hiddenColumns')
      const arr = raw ? JSON.parse(raw) : []
      return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : []
    } catch {
      return []
    }
  })
  // 维度子集（默认全选）
  const [sections, setSections] = useState<number[]>([1, 2, 3, 4, 5, 6, 7, 8])
  // 使用的技能（'' = 内置 paper-analysis）
  const [skill, setSkill] = useState('')
  const [skills, setSkills] = useState<string[]>([])
  // 技能模板「预览对比」：与另一个技能逐行对比（'' = 不对比）
  const [diffTarget, setDiffTarget] = useState('')
  const [skillDiff, setSkillDiff] = useState<{
    rows: DiffRow[]
    added: number
    removed: number
  } | null>(null)
  const effectiveSkill = skill || 'paper-analysis'

  // PD54：读 AI 工具库并按主进程广播跟随（设置里改完，拆解面板立即生效）
  useEffect(() => {
    let alive = true
    void window.api.aiTools.list().then(
      (r) => {
        if (alive) setToolStates(r.tools)
      },
      () => {
        /* 读不到按默认（可用）处理 */
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

  useEffect(() => {
    let cancelled = false
    if (!diffTarget) {
      setSkillDiff(null)
      return
    }
    void Promise.all([
      window.api.analysis.getSkill(effectiveSkill),
      window.api.analysis.getSkill(diffTarget)
    ])
      .then(([a, b]) => {
        if (cancelled) return
        const rows = lineDiff(a.split(/\r?\n/), b.split(/\r?\n/))
        const s = diffStats(rows)
        setSkillDiff({ rows, added: s.added, removed: s.removed })
      })
      .catch(() => {
        if (!cancelled) setSkillDiff(null)
      })
    return () => {
      cancelled = true
    }
  }, [diffTarget, effectiveSkill])

  useEffect(() => {
    void window.api.analysis
      .listSkills()
      .then(setSkills)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (itemId == null) {
      setCurrent(null)
      return
    }
    void window.api.library
      .get(itemId)
      .then((it) => {
        if (!cancelled) setCurrent(it)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [itemId])

  // 当前条目默认勾选进批次
  useEffect(() => {
    if (itemId != null) setPicked((prev) => (prev.includes(itemId) ? prev : [itemId, ...prev]))
  }, [itemId])

  useEffect(() => {
    setHistory([])
    setShowDiff(false)
    // 切换论文时清掉上一篇的结果与提示：否则会显示上一篇的内容、
    // 归档时也容易把上一篇的结果写进这一篇的笔记（看起来像"点了没反应"）
    setResult(null)
    setNotice('')
    setNoteState('idle')
  }, [attachmentId])

  // 进行中计时（拆解 / 对比），配合加载动画提示「已用时」
  useEffect(() => {
    if (!busy && !busyBatch) {
      setElapsed(0)
      return
    }
    const t0 = Date.now()
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => window.clearInterval(id)
  }, [busy, busyBatch])

  // 滚动联动高亮：观察每个小节块，取最靠上的可见小节为当前项
  useEffect(() => {
    const root = scrollRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const els = Array.from(
      root.querySelectorAll<HTMLElement>('[data-testid^="analysis-sec-view-"]')
    )
    if (els.length === 0) return
    const visible = new Set<number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.testid?.replace('analysis-sec-view-', ''))
          if (Number.isNaN(idx)) continue
          if (e.isIntersecting) visible.add(idx)
          else visible.delete(idx)
        }
        // 取最小索引；无一可见时保留上一次（不清空）
        if (visible.size > 0) setActiveSec(Math.min(...visible))
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 }
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [result?.markdown])

  const candidates = useMemo(() => items.slice(0, 12), [items])
  const quality = useMemo(() => (result ? checkAnalysis(result.markdown) : null), [result])
  const diffRows = useMemo(() => {
    const prev = history[history.length - 1]
    if (!prev || !result) return []
    return lineDiff(prev.markdown.split(/\r?\n/), result.markdown.split(/\r?\n/))
  }, [history, result])
  const dstat = useMemo(() => diffStats(diffRows), [diffRows])
  const compareTable = useMemo(() => markdownTableToRows(batch?.compare ?? ''), [batch])
  const visibleCols = useMemo(
    () => visibleColumnIndexes(compareTable.header, hiddenCols),
    [compareTable, hiddenCols]
  )
  // 过滤用的列必须落在可见列内，否则回退到第一个可见列
  const effectiveCol = visibleCols.includes(compareCol) ? compareCol : visibleCols[0]
  const compareRows = useMemo(() => {
    const q = compareFilter.trim().toLowerCase()
    if (!q) return compareTable.rows
    return compareTable.rows.filter((r) => (r[effectiveCol] ?? '').toLowerCase().includes(q))
  }, [compareTable, effectiveCol, compareFilter])
  // 排序仅在排序列可见时生效；列被隐藏则忽略（保留状态，恢复可见后重新生效）
  const sortedRows = useMemo(() => {
    if (sort && visibleCols.includes(sort.col)) {
      return sortRowsByColumn(compareRows, sort.col, sort.dir)
    }
    return compareRows
  }, [compareRows, visibleCols, sort])

  // 隐藏列变化时持久化
  useEffect(() => {
    try {
      window.localStorage.setItem('paperdesk.compare.hiddenColumns', JSON.stringify(hiddenCols))
    } catch {
      /* 隐私模式等场景忽略写入失败 */
    }
  }, [hiddenCols])

  const run = async (): Promise<void> => {
    if (attachmentId == null) {
      setNotice('请先打开一篇论文（选择条目并打开附件）')
      return
    }
    const prevResult = result
    const label = `${depth === 'brief' ? '速览' : depth === 'deep' ? '深入' : '标准'} · 维度 ${sections.join('/')} · ${skill || 'paper-analysis'}`
    setBusy(true)
    setNotice('')
    setResult(null)
    try {
      const r = await window.api.analysis.run({
        attachmentId,
        focus,
        depth,
        sections,
        skill: skill || undefined
      })
      if (prevResult) {
        setHistory((h) => [...h, { label: prevResult.label, markdown: prevResult.markdown }].slice(-3))
      }
      setResult({ markdown: r.markdown, backend: r.backend, label })
      setNoteState('idle')
      setNotice(
        r.empty
          ? '未取到正文：该论文可能还没完成抽取——请在「元数据」面板运行一次抽取后重试'
          : `完成（${r.pages} 页 / ${r.chars} 字${r.reduced ? '，长文分段合并' : r.truncated ? '，已截断' : ''}）· 维度 ${(r.sections ?? []).join('/')} · 模型调用 ${r.calls ?? 1} 次` +
              (r.backend === 'openai' ? '' : ' · 离线占位')
      )
    } catch (e) {
      setNotice('拆解失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const runBatch = async (): Promise<void> => {
    const ids = picked
    if (ids.length < 2) {
      setNotice('批次对比请至少选择 2 篇')
      return
    }
    setBusyBatch(true)
    setNotice('')
    setBatch(null)
    try {
      const atts: number[] = []
      for (const id of ids) {
        const list = await window.api.attachments.listByItem(id)
        if (list[0]) atts.push(list[0].id)
      }
      if (atts.length < 2) {
        setNotice('所选论文中可读附件不足 2 个')
        return
      }
      const r = await window.api.analysis.compare({ attachmentIds: atts, focus, skill: skill || undefined })
      setBatch({ compare: r.compare, cards: r.cards.length, backend: r.backend })
      setNotice(`批次完成：${r.cards.length} 篇`)
    } catch (e) {
      setNotice('批次失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusyBatch(false)
    }
  }

  const exportHtml = async (): Promise<void> => {
    if (!result) return
    const title = `论文拆解 · ${current?.title ?? ''}`.trim() || '论文拆解'
    const html = markdownToHtml(result.markdown, {
      title,
      note: result.backend === 'openai' ? undefined : '离线占位：未配置模型服务，内容为占位框架'
    })
    const safe = (current?.title ?? 'analysis').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const p = await window.api.translate.saveReport(`${safe}.analysis.html`, html)
    if (p) setNotice(`已导出 HTML：${p}`)
  }

  const exportCompareCsv = async (): Promise<void> => {
    if (!batch) return
    const csv = markdownTableToCsv(batch.compare)
    if (!csv) {
      setNotice('对比结果里没有可导出的表格（可能为离线占位或格式异常）')
      return
    }
    const p = await window.api.translate.saveReport('论文对比.csv', csv)
    if (p) setNotice(`已导出 CSV：${p}`)
  }

  const exportCompareFilteredCsv = async (): Promise<void> => {
    const header = visibleCols.map((i) => compareTable.header[i] ?? '')
    const csv = tableRowsToCsv(header, projectRows(sortedRows, visibleCols))
    if (!csv) {
      setNotice('没有可导出的行')
      return
    }
    const p = await window.api.translate.saveReport('论文对比-filtered.csv', csv)
    if (p) setNotice(`已导出 CSV：${p}`)
  }

  const toNote = async (md: string, title: string): Promise<void> => {
    if (!md) return
    if (itemId == null) {
      setNoteState('error')
      setNotice('归档失败：没有选中的论文')
      return
    }
    setNoteState('busy')
    try {
      const existing = await window.api.notes.getForItem(itemId)
      const note = existing ?? (await window.api.notes.create(itemId))
      const body = `${(existing?.content ?? '').replace(/\s*$/, '')}\n\n## ${title}\n\n${md}\n`
      await window.api.notes.save(note.note.id, body)
      onNotesChanged()
      setNoteState('done')
      setNotice(`已归档到「${current?.title ?? '该论文'}」的笔记`)
    } catch (e) {
      setNoteState('error')
      setNotice('归档失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /**
   * 拆解结果 → 知识库暂存区（PD38）：只创建 source=digest 的待审提案批次，
   * 不发布任何正式条目；同一份拆解重复点击由服务层幂等，返回复用数量。
   */
  const syncDigestToKnowledge = async (): Promise<void> => {
    if (!result || itemId == null) return
    setDigestState('busy')
    setDigestNotice('')
    try {
      const res = await window.api.knowledge.syncDigest({
        itemId,
        markdown: result.markdown,
        title: `论文拆解 · ${current?.title ?? ''}`.trim()
      })
      setDigestState('done')
      setDigestNotice(describeDigestSyncResult(res))
    } catch (e) {
      setDigestState('error')
      setDigestNotice(`同步到知识库失败：${ipcErrorMessage(e) || '未知错误'}`)
    }
  }

  /**
   * 拆解结果 → 思维地图（PD55）：主进程生成三层骨架并覆盖上一次同步节点，
   * 用户节点与改过名的节点永久保留；同一份内容重复同步是幂等的。
   */
  const syncDigestToMindMap = async (): Promise<void> => {
    if (!result || itemId == null) return
    setMapState('busy')
    setMapNotice('')
    try {
      const synced = await window.api.mindmap.syncDigest({
        itemId,
        markdown: result.markdown,
        title: current?.title ?? null
      })
      setMapState('done')
      const modeLabel = synced.mode === 'ai' ? 'AI 骨架' : '规则骨架'
      const parts: string[] = []
      if (synced.added > 0) parts.push(`新增 ${synced.added} 个节点`)
      if (synced.removed > 0) parts.push(`覆盖 ${synced.removed} 个上次同步节点`)
      if (synced.kept > 0) parts.push(`保留 ${synced.kept} 个你改过的节点`)
      const warning = synced.warnings.length > 0 ? `；提示：${synced.warnings.join('；')}` : ''
      setMapNotice(
        parts.length > 0
          ? `${modeLabel}：${parts.join('、')}${warning}`
          : `${modeLabel}：与上次同步内容一致，没有重复写入${warning}`
      )
    } catch (e) {
      setMapState('error')
      setMapNotice(`同步到思维地图失败：${ipcErrorMessage(e) || '未知错误'}`)
    }
  }

  // 把 [p.N] 变成可点击的原文深链（需要当前附件的 key）
  const [attKey, setAttKey] = useState('')
  useEffect(() => {
    let cancelled = false
    if (itemId == null) {
      setAttKey('')
      return
    }
    void window.api.attachments
      .listByItem(itemId)
      .then((list) => {
        if (cancelled) return
        const hit = list.find((a) => a.id === attachmentId) ?? list[0]
        setAttKey(hit?.key ?? '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [itemId, attachmentId])

  // 上次查看小节：按附件 key 记忆并恢复（脏数据/越界一律钳制到合法范围）
  const sectionCount = useMemo(
    () => (result ? splitBySections(result.markdown).sections.length : 0),
    [result]
  )
  const restoredKeyRef = useRef('')
  useEffect(() => {
    if (!attKey || !result) return
    let raw: string | null = null
    try {
      raw =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(analysisSectionKey(attKey))
          : null
    } catch {
      raw = null
    }
    const idx = clampSectionIndex(parseSectionIndex(raw), sectionCount)
    setActiveSec(idx)
    restoredKeyRef.current = attKey
    const el = document.querySelector<HTMLDetailsElement>(
      `[data-testid="analysis-sec-view-${idx}"]`
    )
    if (el) {
      el.open = true
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [attKey, result, sectionCount])

  // 高亮小节变化时写回（仅在已恢复当前 key 后，避免切换论文瞬间写入旧值）
  useEffect(() => {
    if (!attKey || restoredKeyRef.current !== attKey) return
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(analysisSectionKey(attKey), String(activeSec))
      }
    } catch {
      /* 隐私模式等场景忽略写入失败 */
    }
  }, [activeSec, attKey])

  const linkifyPages = (text: string): string => {
    if (!attKey) return text
    return text.replace(
      /\[p\.(\d+)\]/g,
      (_m, n) => `[p.${n}](paperdesk://open?attachment=${encodeURIComponent(attKey)}&page=${n})`
    )
  }

  const md = (text: string): React.JSX.Element => (
    <div className="analysis__md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(u) => u}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (!href) return
                if (href.startsWith('paperdesk://')) onDeepLink(href)
                else void window.api.app.openExternal(href)
              }}
            >
              {children}
            </a>
          )
        }}
      >
        {linkifyPages(text)}
      </ReactMarkdown>
    </div>
  )

  // 跳到指定小节：高亮 + 展开 + 滚动定位
  const jumpToSection = (i: number): void => {
    setActiveSec(i)
    const el = document.querySelector<HTMLDetailsElement>(
      `[data-testid="analysis-sec-view-${i}"]`
    )
    if (!el) return
    el.open = true
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 按 `### 小节` 渲染成可折叠块（长报告更好读）
  const mdSections = (text: string): React.JSX.Element => {
    const { lead, sections } = splitBySections(text)
    if (sections.length === 0) return md(text)
    const shownIdx = filterOutlineIndexes(
      sections.map((s) => ({ title: s.title })),
      outlineQuery
    )
    return (
      <div className="analysis__md" data-testid="analysis-sections-view">
        {lead && md(lead)}
        {sections.length > 1 && (
          <>
            <input
              className="analysis__outline-search"
              value={outlineQuery}
              placeholder="搜索小节…"
              data-testid="analysis-outline-search"
              onChange={(e) => setOutlineQuery(e.target.value)}
            />
            <div className="analysis__outline" data-testid="analysis-outline">
              {shownIdx.map((i, pos) => (
                <button
                  key={i}
                  ref={(el) => {
                    outlineRefs.current[pos] = el
                  }}
                  data-testid={`analysis-outline-${i}`}
                  data-active={String(i === activeSec)}
                  tabIndex={i === activeSec ? 0 : -1}
                  onClick={() => jumpToSection(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                      e.preventDefault()
                      outlineRefs.current[Math.min(pos + 1, shownIdx.length - 1)]?.focus()
                    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                      e.preventDefault()
                      outlineRefs.current[Math.max(pos - 1, 0)]?.focus()
                    }
                  }}
                >
                  {i + 1}. {sections[i].title}
                </button>
              ))}
            </div>
          </>
        )}
        {sections.length > 1 && shownIdx.length === 0 && (
          <div className="modal__hint" data-testid="analysis-outline-empty">
            无匹配小节
          </div>
        )}
        <div className="analysis__secs-view" key={secKey}>
          {sections.map((s, i) => (
            <details key={i} className="analysis__sec" open={!collapseAll} data-testid={`analysis-sec-view-${i}`}>
              <summary>
                <span className="analysis__sec-title">
                  {i + 1}. {s.title}
                </span>
                <button
                  className="icon ghost analysis__sec-copy"
                  title="复制本小节（Markdown）"
                  data-testid={`analysis-sec-copy-${i}`}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void window.api.app.copyText(`## ${s.title}\n\n${s.body}`)
                    setNotice(`已复制小节：${s.title}`)
                  }}
                >
                  <Icon name="copy" size={12} />
                </button>
              </summary>
              {md(s.body)}
            </details>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="panel" ref={scrollRef}>
      <div className="analysis__head">
        <span className="sidebar__title">拆解论文</span>
        <span className="meta__muted">{skill || 'paper-analysis'}</span>
      </div>
      <div className="analysis__body">
        <p className="modal__hint" style={{ marginTop: 0 }}>
          按「研究问题 / 缺口 / 贡献 / 方法 / 证据 / 局限 / 图表与复现 / 综合」八项拆解，关键结论带
          <code>[p.N]</code> 定位；未配置模型时给出离线占位。
        </p>

        <div className="analysis__row">
          <span className="meta__muted">当前论文</span>
          <b data-testid="analysis-current">{current?.title ?? '（未选择）'}</b>
        </div>
        <div className="analysis__row">
          <span className="meta__muted">研究方向</span>
          <input
            value={focus}
            placeholder="可选：例如「蛋白结构预测的可复现性」"
            data-testid="analysis-focus"
            onChange={(e) => setFocus(e.target.value)}
          />
        </div>
        <div className="analysis__row">
          <span className="meta__muted">篇幅</span>
          <select
            value={depth}
            data-testid="analysis-depth"
            onChange={(e) => setDepth(e.target.value as Depth)}
          >
            <option value="brief">速览（≤350 字/篇）</option>
            <option value="standard">标准（700–1200 字/篇）</option>
            <option value="deep">深入（按需展开）</option>
          </select>
          <span className="toolbar__spacer" />
          <button
            className="primary"
            disabled={busy || attachmentId == null}
            onClick={() => void run()}
            data-testid="analysis-run"
          >
            <Icon name="list" size={13} />
            {busy ? '拆解中…' : '开始拆解'}
          </button>
          {onAddToBatch && (
            <button
              className="ghost"
              disabled={attachmentId == null}
              title="把「拆解论文」加入批处理（到批处理面板确认执行）"
              data-testid="analysis-add-batch"
              onClick={() => onAddToBatch('analyze-paper')}
            >
              <Icon name="layers" size={13} />
              加入批处理
            </button>
          )}
        </div>

        <div className="analysis__row">
          <span className="meta__muted">技能</span>
          <select
            value={skill}
            data-testid="analysis-skill"
            title="选择拆解技能（可在「设置 → 论文拆解技能」里编辑/另存）"
            onChange={(e) => {
              const v = e.target.value
              setSkill(v)
              const eff = v || 'paper-analysis'
              if (diffTarget === eff) setDiffTarget('')
            }}
          >
            <option value="">内置 paper-analysis</option>
            {skills
              .filter((s) => s !== 'paper-analysis')
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </select>
          <span className="toolbar__spacer" />
          <select
            value={diffTarget}
            data-testid="analysis-skill-diff-target"
            title="选择另一个技能，与当前技能逐行对比（只读）"
            onChange={(e) => setDiffTarget(e.target.value)}
          >
            <option value="">（不减对比）</option>
            {skills
              .filter((s) => s !== effectiveSkill)
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </select>
          <span className="toolbar__spacer" />
          <span className="meta__muted" data-testid="analysis-skill-label">
            正在使用：{effectiveSkill}
          </span>
        </div>

        {diffTarget && skillDiff && skillDiff.rows.length > 0 && (
          <div data-testid="analysis-skill-diff" style={{ marginBottom: 8 }}>
            <div className="meta__muted">
              技能差异（{effectiveSkill} → {diffTarget}）：+{skillDiff.added} / −{skillDiff.removed}
            </div>
            <div className="diffview">
              <div className="diffview__body">
                {skillDiff.rows
                  .filter((r) => r.type !== '=')
                  .map((r, i) => (
                    <div key={i} className={`diffrow diffrow--${r.type}`}>
                      <div className="diffrow__cell">{r.type === '+' ? '' : r.left}</div>
                      <div className="diffrow__cell">{r.type === '-' ? '' : r.right}</div>
                    </div>
                  ))}
              </div>
            </div>
            <div className="analysis__actions">
              <button
                data-testid="analysis-skill-diff-apply"
                title="把当前技能切换为这个目标技能"
                onClick={() => {
                  setSkill(diffTarget)
                  setDiffTarget('')
                  setSkillDiff(null)
                  setNotice(`已切换到技能 ${diffTarget}`)
                }}
              >
                <Icon name="check" size={13} />
                设为当前技能
              </button>
            </div>
          </div>
        )}

        <div className="analysis__secs" data-testid="analysis-sections">
          <span className="meta__muted">分析维度</span>
          {[
            [1, '研究问题'],
            [2, '缺口'],
            [3, '贡献'],
            [4, '方法'],
            [5, '证据'],
            [6, '局限'],
            [7, '图表/复现'],
            [8, '综合']
          ].map(([n, label]) => (
            <label key={n}>
              <input
                type="checkbox"
                checked={sections.includes(Number(n))}
                data-testid={`analysis-sec-${n}`}
                onChange={(e) =>
                  setSections((prev) =>
                    e.target.checked
                      ? [...new Set([...prev, Number(n)])].sort((a, b) => a - b)
                      : prev.filter((x) => x !== Number(n))
                  )
                }
              />
              {n} {label}
            </label>
          ))}
        </div>

        {notice && (
          <p className="modal__hint" data-testid="analysis-notice">
            {notice}
          </p>
        )}

        {(busy || busyBatch) && (
          <div className="analysis__loading" data-testid="analysis-loading">
            <span className="spinner" />
            <span>
              {busy ? '正在拆解论文…' : '正在批次对比…'} 已用时 {elapsed}s
              <span className="meta__muted">（长文/深入模式较慢，请稍候）</span>
            </span>
            <div className="analysis__progress" role="progressbar" aria-label="拆解进行中">
              <span />
            </div>
          </div>
        )}

        {result && (
          <div className="analysis__result" data-testid="analysis-result">
            {result.backend !== 'openai' && (
              <div className="modal__hint" style={{ marginBottom: 6 }}>
                当前为<b>离线占位</b>：在「设置 → 模型服务」配置后可生成真实拆解。
              </div>
            )}
            {quality && quality.sections.length > 0 && (
              <div className="analysis__actions">
                <button
                  data-testid="analysis-collapse-toggle"
                  onClick={() => {
                    setCollapseAll((v) => !v)
                    setSecKey((k) => k + 1)
                  }}
                >
                  <Icon name="layers" size={13} />
                  {collapseAll ? '展开全部小节' : '折叠全部小节'}
                </button>
              </div>
            )}
            {mdSections(result.markdown)}
            {quality && (
              <div className="analysis__quality" data-testid="analysis-quality">
                {formatQuality(quality)}
                {quality.missing.length > 0 && (
                  <div className="analysis__quality-miss meta__muted">
                    缺定位（示例）：{quality.missing.slice(0, 3).join(' ／ ')}
                  </div>
                )}
              </div>
            )}
            {history.length > 0 && (
              <div className="analysis__actions">
                <button
                  data-testid="analysis-diff-toggle"
                  onClick={() => setShowDiff((v) => !v)}
                  title={`与上次（${history[history.length - 1].label}）对比`}
                >
                  <Icon name="list" size={13} />
                  {showDiff ? '收起对比' : `与上次对比（+${dstat.added} / −${dstat.removed}）`}
                </button>
                {showDiff && (
                  <label
                    className="meta__muted"
                    style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <input
                      type="checkbox"
                      checked={diffOnly}
                      data-testid="analysis-diff-only"
                      onChange={(e) => setDiffOnly(e.target.checked)}
                    />
                    只看改动
                  </label>
                )}
              </div>
            )}
            {showDiff && diffRows.length > 0 && (
              <div className="diffview" data-testid="analysis-diff">
                <div className="diffview__body">
                  {(diffOnly ? diffRows.filter((r) => r.type !== '=') : diffRows).map((r, i) => (
                    <div key={i} className={`diffrow diffrow--${r.type}`}>
                      <div className="diffrow__cell">{r.type === '+' ? '' : r.left}</div>
                      <div className="diffrow__cell">{r.type === '-' ? '' : r.right}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="analysis__actions">
              <button
                onClick={() => void window.api.app.copyText(result.markdown)}
                data-testid="analysis-copy"
              >
                <Icon name="check" size={13} />
                复制
              </button>
              <button
                onClick={() => void toNote(result.markdown, `论文拆解（${current?.title ?? ''}）`)}
                data-testid="analysis-note"
                disabled={noteState === 'busy'}
                title="把本次拆解写入该论文的笔记（同名小节会替换）"
              >
                <Icon name={noteState === 'done' ? 'check' : 'notes'} size={13} />
                {noteState === 'busy' ? '归档中…' : noteState === 'done' ? '已归档' : '归档到笔记'}
              </button>
              <button onClick={() => void exportHtml()} data-testid="analysis-export-html">
                <Icon name="file" size={13} />
                导出 HTML
              </button>
            </div>
          </div>
        )}

        {/* PD38：拆解完成后的两条同步入口；未完成拆解时按钮存在但不可点 */}
        <div className="analysis__actions analysis__digest-actions" data-testid="analysis-digest-actions">
          <button
            data-testid="digest-to-knowledge"
            disabled={!result || digestState === 'busy' || !!digestSyncBlocked}
            title={
              digestSyncBlocked
                ? `${digestSyncBlocked}：到 设置 → AI 工具库 重新打开（或恢复默认）`
                : '把拆解要点提交到知识库暂存区（生成待审核提案，不会直接发布）'
            }
            onClick={() => {
              if (digestSyncBlocked) return
              void syncDigestToKnowledge()
            }}
          >
            <Icon name={digestState === 'done' ? 'check' : 'layers'} size={13} />
            {digestState === 'busy' ? '提交中…' : '同步到知识库'}
          </button>
          <button
            data-testid="digest-to-mindmap"
            disabled={!result || mapState === 'busy' || !!digestSyncBlocked}
            title={
              digestSyncBlocked
                ? `${digestSyncBlocked}：到 设置 → AI 工具库 重新打开（或恢复默认）`
                : '把拆解要点写成本文思维地图根节点的子节点（重复同步不会重复写入）'
            }
            onClick={() => {
              if (digestSyncBlocked) return
              void syncDigestToMindMap()
            }}
          >
            <Icon name={mapState === 'done' ? 'check' : 'graph'} size={13} />
            {mapState === 'busy' ? '写入中…' : '同步到思维地图'}
          </button>
          {digestNotice ? (
            <span className="analysis__digest-note" data-testid="digest-to-knowledge-note">
              {digestNotice}
            </span>
          ) : null}
          {mapNotice ? (
            <span className="analysis__digest-note" data-testid="digest-to-mindmap-note">
              {mapNotice}
            </span>
          ) : null}
        </div>

        <h4 className="analysis__h">批次对比（选 ≥2 篇）</h4>
        <ul className="analysis__pick" data-testid="analysis-pick">
          {candidates.map((it) => (
            <li key={it.id}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.includes(it.id)}
                  data-testid={`analysis-pick-${it.id}`}
                  onChange={(e) =>
                    setPicked((prev) =>
                      e.target.checked ? [...new Set([...prev, it.id])] : prev.filter((x) => x !== it.id)
                    )
                  }
                />
                <span>{it.title ?? `#${it.id}`}</span>
              </label>
            </li>
          ))}
          {candidates.length === 0 && <li className="list__hint">文库为空</li>}
        </ul>
        <div className="analysis__actions">
          <button
            className="primary"
            disabled={busyBatch}
            onClick={() => void runBatch()}
            data-testid="analysis-compare"
          >
            <Icon name="list" size={13} />
            {busyBatch ? '对比中…' : `开始对比（${picked.length}）`}
          </button>
          {onAddToBatch && (
            <button
              className="ghost"
              disabled={picked.length < 2}
              title="把「批次对比」加入批处理（到批处理面板确认执行）"
              data-testid="analysis-compare-add-batch"
              onClick={() => onAddToBatch('compare')}
            >
              <Icon name="layers" size={13} />
              加入批处理
            </button>
          )}
        </div>
        {batch && (
          <div className="analysis__result" data-testid="analysis-compare-result">
            {md(batch.compare)}
            {compareTable.rows.length > 0 && (
              <div className="analysis__table" data-testid="analysis-compare-table">
                <div className="analysis__row">
                  <span className="meta__muted">按维度</span>
                  <select
                    value={String(effectiveCol)}
                    data-testid="analysis-compare-group"
                    onChange={(e) => setCompareCol(Number(e.target.value))}
                  >
                    {compareTable.header.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <input
                    value={compareFilter}
                    placeholder="按该列筛选…"
                    data-testid="analysis-compare-filter"
                    onChange={(e) => setCompareFilter(e.target.value)}
                  />
                </div>
                <div className="analysis__actions" data-testid="analysis-compare-cols">
                  {compareTable.header.map((h, i) => (
                    <button
                      key={i}
                      data-testid={`analysis-compare-col-${i}`}
                      data-hidden={String(hiddenCols.includes(i))}
                      title={hiddenCols.includes(i) ? `显示「${h}」列` : `隐藏「${h}」列`}
                      onClick={() =>
                        setHiddenCols((prev) =>
                          prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]
                        )
                      }
                    >
                      {h}
                    </button>
                  ))}
                </div>
                <div className="analysis__table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {visibleCols.map((i, j) => (
                          <th
                            key={i}
                            className={j === 0 ? 'analysis__table-fixed-col' : undefined}
                            data-testid={`analysis-compare-sort-${i}`}
                            data-sort={sort && sort.col === i ? sort.dir : 'none'}
                            style={{ cursor: 'pointer' }}
                            title={`按「${compareTable.header[i] ?? ''}」排序`}
                            onClick={() => setSort(nextSortState(sort, i))}
                          >
                            {compareTable.header[i] ?? ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {projectRows(sortedRows, visibleCols).map((r, i) => (
                        <tr key={i}>
                          {r.map((c, j) => (
                            <td key={j} className={j === 0 ? 'analysis__table-fixed-col' : undefined}>
                              {c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="analysis__count meta__muted" data-testid="analysis-compare-count">
                  显示 {compareRows.length} / 共 {compareTable.rows.length} 行
                </div>
              </div>
            )}
            <div className="analysis__actions">
              <button
                onClick={() => void window.api.app.copyText(batch.compare)}
                data-testid="analysis-compare-copy"
              >
                <Icon name="check" size={13} />
                复制
              </button>
              <button
                onClick={() => void toNote(batch.compare, '批次对比（论文拆解）')}
                data-testid="analysis-compare-note"
              >
                <Icon name="notes" size={13} />
                归档到笔记
              </button>
              <button onClick={() => void exportCompareCsv()} data-testid="analysis-compare-csv">
                <Icon name="file" size={13} />
                导出 CSV
              </button>
              <button
                onClick={() => void exportCompareFilteredCsv()}
                data-testid="analysis-compare-csv-filtered"
                disabled={compareRows.length === 0}
              >
                <Icon name="file" size={13} />
                导出筛选结果（{compareRows.length}）
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
