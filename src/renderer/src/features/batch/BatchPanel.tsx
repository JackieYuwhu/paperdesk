import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { OrganizePanel } from './OrganizePanel'
import {
  failedItemsToCsv,
  failedItemsToMarkdown,
  normalizeFailMessage,
  topFailReasons
} from '@shared/batch-fail'
import {
  BATCH_JOB_FILTER_KEY,
  filterJobs,
  parseBatchJobFilter,
  serializeBatchJobFilter,
  type JobStatusFilter
} from '@shared/batch-filter'
import {
  collectFailReasonOptions,
  selectJobIdsByFailureReasons
} from '@shared/batch-fail-filter'
import {
  buildGroupTree,
  flattenGroupTree,
  groupDisplayName,
  type GroupTreeNode
} from '@shared/library-groups'
import { describeBatchSyncResult, isBatchDigestTask } from '@shared/api'
import { aiToolBlockReason, type AiToolState } from '@shared/ai-tools'
import type {
  BatchItemRow,
  BatchJob,
  BatchProgress,
  BatchSyncResult,
  BatchSyncTarget,
  BatchTaskInfo,
  Item,
  LibraryGroup,
  LibraryTag
} from '@shared/types'

interface Props {
  itemId: number | null
  attachmentId: number | null
  active: boolean
  onLibraryChanged: () => void
  /** 「加入批处理」中转：打开时预选该任务（由功能声明驱动） */
  pendingBatchTask?: string | null
  onConsumePendingBatchTask?: () => void
  /** 打开某条目的笔记（批处理拆解报告归档后可直接跳转） */
  onOpenNotes?: (itemId: number) => void
}

const groupSubtreeCount = (node: GroupTreeNode): number =>
  node.count + node.children.reduce((n, child) => n + groupSubtreeCount(child), 0)

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  scheduled: '待办',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}
/** PD44：同步结果里逐篇状态的显示文案 */
const SYNC_STATUS_LABEL: Record<string, string> = {
  success: '成功',
  skipped: '跳过',
  failed: '失败'
}
const STATUS_COLOR: Record<string, string> = {
  queued: '#94a3b8',
  scheduled: '#f59e0b',
  running: '#3b82f6',
  done: '#12a150',
  failed: '#e5484d',
  cancelled: '#6b7280'
}

/** 作业是否为终态（可读取失败明细）。 */
const isTerminalJob = (status: string): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled'

/** 归一化明细中的失败原因文案，用于按原因筛选作业。 */
const failReasonsOf = (rows: BatchItemRow[]): string[] =>
  rows.filter((x) => x.status === 'failed').map((x) => normalizeFailMessage(x.message))


export function BatchPanel({
  itemId,
  attachmentId,
  active,
  pendingBatchTask,
  onConsumePendingBatchTask,
  onOpenNotes
}: Props): React.JSX.Element {
  const [tasks, setTasks] = useState<BatchTaskInfo[]>([])
  const [jobs, setJobs] = useState<BatchJob[]>([])
  const [taskId, setTaskId] = useState('')
  const [scope, setScope] = useState<
    'all' | 'item' | 'attachment' | 'select' | 'group' | 'tag'
  >('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const expandedRef = useRef<number | null>(null)
  const [items, setItems] = useState<BatchItemRow[]>([])
  const [failCounts, setFailCounts] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  /** PD44：正在同步的作业与目标（同一作业同一目标只允许点一次） */
  const [syncing, setSyncing] = useState<{ jobId: number; target: BatchSyncTarget } | null>(null)
  /** PD44：勾选要同步的论文（item_id）；空集合 = 整批已完成论文 */
  const [syncPicks, setSyncPicks] = useState<Set<number>>(new Set())
  /** PD44：每个作业 × 目标的最近一次同步结果（逐篇成功/跳过/失败） */
  const [syncResults, setSyncResults] = useState<Record<string, BatchSyncResult>>({})
  /** 智能整理（阶段三）：从这次批处理的产物生成整理草稿，预览后再保存 */
  const [organizeRun, setOrganizeRun] = useState<string | null>(null)
  /**
   * PD54：AI 工具库状态。拆解同步被关掉（或它的「写入知识库」权限被关）时，
   * 两个同步按钮禁用并说明原因 —— 不隐藏，避免用户找不到入口。
   */
  const [toolStates, setToolStates] = useState<AiToolState[] | null>(null)
  const digestSyncBlocked = aiToolBlockReason(toolStates, [
    { id: 'digest-sync', permission: 'write-knowledge' }
  ])
  const [allItems, setAllItems] = useState<Item[]>([])
  const [groups, setGroups] = useState<LibraryGroup[]>([])
  const [groupName, setGroupName] = useState('')
  const [tags, setTags] = useState<LibraryTag[]>([])
  const [tagName, setTagName] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState('')

  // Batch C：功能声明的「加入批处理」入口 → 打开本面板时预选任务
  useEffect(() => {
    if (!pendingBatchTask) return
    setTaskId(pendingBatchTask)
    onConsumePendingBatchTask?.()
  }, [pendingBatchTask, onConsumePendingBatchTask])

  // PD54：读 AI 工具库并按广播跟随设置变化（开关改完立即生效，无需重启）
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
  // 作业列表自身的筛选（与上方条目选择器用的 filter 无关）：惰性从 localStorage 恢复
  const [jobStatus, setJobStatus] = useState<JobStatusFilter>(() => {
    try {
      return parseBatchJobFilter(localStorage.getItem(BATCH_JOB_FILTER_KEY)).status
    } catch {
      return 'all'
    }
  })
  const [jobKeyword, setJobKeyword] = useState(() => {
    try {
      return parseBatchJobFilter(localStorage.getItem(BATCH_JOB_FILTER_KEY)).keyword
    } catch {
      return ''
    }
  })
  // 按失败原因筛选（多选）：当前选中原因集合 + 每个作业的失败原因缓存（归一化文案）
  const [failReason, setFailReason] = useState<string[]>([])
  const [failReasons, setFailReasons] = useState<Record<number, string[]>>({})
  // 已抓取（或在途）失败明细的作业 id，保证每个作业最多请求一次，避免渲染循环
  const failSeenRef = useRef<Set<number>>(new Set())
  const groupOptions = useMemo(() => flattenGroupTree(buildGroupTree(groups)), [groups])

  // 作业筛选变化时写入 localStorage（与上方参数持久化同一套容错风格）
  useEffect(() => {
    try {
      localStorage.setItem(BATCH_JOB_FILTER_KEY, serializeBatchJobFilter(jobStatus, jobKeyword))
    } catch {
      /* ignore */
    }
  }, [jobStatus, jobKeyword])

  // 为终态作业抓取失败明细并写入缓存（已展开的作业复用当前明细，稍后由下方 effect 处理）
  useEffect(() => {
    for (const j of jobs) {
      if (!isTerminalJob(j.status) || j.id === expanded) continue
      if (failSeenRef.current.has(j.id)) continue
      failSeenRef.current.add(j.id)
      void window.api.batch.items(j.id).then((rows) => {
        setFailReasons((prev) => ({ ...prev, [j.id]: failReasonsOf(rows) }))
      })
    }
  }, [jobs, expanded])

  // 当前展开的作业：直接用已加载的明细刷新缓存
  useEffect(() => {
    if (expanded == null) return
    setFailReasons((prev) => ({ ...prev, [expanded]: failReasonsOf(items) }))
  }, [expanded, items])

  // 可选失败原因（跨作业合并计数），含当前展开作业的明细
  const failReasonOptions = useMemo(() => {
    const byJob = new Map<number, string[]>(Object.entries(failReasons).map(([id, m]) => [Number(id), m]))
    if (expanded != null) byJob.set(expanded, failReasonsOf(items))
    const itemsByJob = [...byJob.entries()].map(([jobId, messages]) => ({
      jobId,
      items: messages.map((message) => ({ status: 'failed', message }) as unknown as BatchItemRow)
    }))
    return collectFailReasonOptions(itemsByJob, 5)
  }, [failReasons, expanded, items])

  const shownJobs = useMemo(() => {
    const candidates = filterJobs(jobs, jobStatus, jobKeyword)
    const ids = new Set(selectJobIdsByFailureReasons(candidates, failReasons, failReason))
    return candidates.filter((j) => ids.has(j.id))
  }, [jobs, jobStatus, jobKeyword, failReasons, failReason])

  const task = tasks.find((t) => t.id === taskId) ?? null

  const reload = useCallback(async (): Promise<void> => {
    setJobs(await window.api.batch.list())
  }, [])

  useEffect(() => {
    void (async () => {
      const ts = await window.api.batch.tasks()
      setTasks(ts)
      if (ts.length > 0) setTaskId((prev) => prev || ts[0].id)
    })()
    void reload()
  }, [reload])

  useEffect(() => {
    return window.api.onBatchProgress((p: BatchProgress) => {
      void reload()
      // 展开中的作业：进度事件同步刷新明细，否则会出现“头部 3/5、详情仍停在 1 篇”的错位。
      if (expandedRef.current === p.jobId) {
        void window.api.batch.items(p.jobId).then((rows) => {
          setItems(rows)
          setFailCounts((prev) => ({
            ...prev,
            [p.jobId]: rows.filter((x) => x.status === 'failed').length
          }))
        })
      }
    })
  }, [reload])

  // 切到本面板时刷新
  useEffect(() => {
    if (active) {
      void reload()
      void window.api.library.list().then(setAllItems)
      void window.api.library.listGroups().then(setGroups)
      void window.api.library.listTags().then(setTags)
    }
  }, [active, reload])

  // 导入/改名/删除后同步刷新条目选择器与作业列表（无需再上传一篇触发）
  useEffect(
    () =>
      window.api.onLibraryChanged(() => {
        void reload()
        void window.api.library.list().then(setAllItems)
        void window.api.library.listGroups().then(setGroups)
      }),
    [reload]
  )

  const togglePick = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 切换失败原因多选（选中/取消）
  const toggleFailReason = (message: string): void => {
    setFailReason((prev) =>
      prev.includes(message) ? prev.filter((m) => m !== message) : [...prev, message]
    )
  }

  // 切换任务时只调整范围；参数一律使用服务端默认值，避免面板堆叠无意义选项
  useEffect(() => {
    const t = tasks.find((x) => x.id === taskId)
    if (!t) return
    if (t.input === 'item') setScope('item')
    else setScope(attachmentId != null ? 'attachment' : 'all')
  }, [taskId, tasks]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadItems = async (jobId: number): Promise<void> => {
    if (expanded === jobId) {
      expandedRef.current = null
      setExpanded(null)
      return
    }
    expandedRef.current = jobId
    setExpanded(jobId)
    setSyncPicks(new Set())
    const rows = await window.api.batch.items(jobId)
    setItems(rows)
    setFailCounts((prev) => ({
      ...prev,
      [jobId]: rows.filter((x) => x.status === 'failed').length
    }))
  }

  const retry = async (jobId: number): Promise<void> => {
    setMsg('')
    try {
      const job = await window.api.batch.retryFailed(jobId)
      setMsg(`已创建重试作业 #${job.id}`)
      await reload()
    } catch (e) {
      setMsg('重试失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** PD44：勾选/取消单篇论文（只影响同步范围，不改变批处理本身） */
  const toggleSyncPick = (itemId: number): void => {
    setSyncPicks((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  /**
   * PD44：把勾选论文（无勾选=整批已完成论文）的拆解结果同步到知识库或思维地图。
   * 知识库只建待审提案（绝不发布）；思维地图按 digestPointId 幂等，保留用户改名节点。
   * 先用 window.confirm 告知预计影响篇数，执行后展示逐篇成功/跳过/失败。
   */
  const syncBatch = async (job: BatchJob, target: BatchSyncTarget): Promise<void> => {
    const picks = expanded === job.id ? [...syncPicks] : []
    const doneCount =
      expanded === job.id
        ? items.filter((row) => row.status === 'done' && row.item_id != null).length
        : job.done
    const count = picks.length > 0 ? picks.length : doneCount
    if (count <= 0) {
      setMsg('这一批还没有可同步的已完成论文')
      return
    }
    const label = target === 'mindmap' ? '思维地图' : '知识库暂存区'
    const scopeText = picks.length > 0 ? `勾选的 ${picks.length} 篇论文` : `整批已完成的 ${doneCount} 篇论文`
    const effect =
      target === 'mindmap'
        ? '按本次结果覆盖上一次同步到地图的节点（你改过名的节点会保留，手工建的节点不删）'
        : '只生成待审核提案，不会自动发布正式条目'
    if (
      !window.confirm(
        `将同步${scopeText}的拆解要点到${label}。\n预计影响：最多 ${count} 篇论文；${effect}。\n继续？`
      )
    ) {
      return
    }
    setMsg('')
    setSyncing({ jobId: job.id, target })
    try {
      const result = await window.api.knowledge.batchSync({
        jobId: job.id,
        target,
        itemIds: picks.length > 0 ? picks : undefined
      })
      setSyncResults((prev) => ({ ...prev, [`${job.id}:${target}`]: result }))
      setMsg(describeBatchSyncResult(result))
    } catch (e) {
      setMsg('同步失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSyncing(null)
    }
  }

  const create = async (): Promise<void> => {
    if (!task) return
    setBusy(true)
    setMsg('')
    try {
      const job = await window.api.batch.create({
        task: task.id,
        scope,
        itemId,
        attachmentId,
        itemIds: scope === 'select' ? [...selected] : undefined,
        group: scope === 'group' ? groupName : undefined,
        tag: scope === 'tag' ? tagName : undefined,
        params: {},
        offPeakOnly: false
      })
      // 旧筛选条件可能把刚创建的作业藏起来；创建后回到「全部」并清空关键词/失败原因
      setJobStatus('all')
      setJobKeyword('')
      setFailReason([])
      setMsg(`已创建作业 #${job.id}`)
      await reload()
    } catch (e) {
      setMsg('创建失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const pct = (j: BatchJob): number => (j.total > 0 ? Math.round((j.done / j.total) * 100) : 0)

  const exportFailed = async (name: string, content: string): Promise<void> => {
    try {
      const p = await window.api.translate.saveReport(name, content)
      if (p) setMsg('已导出：' + p)
    } catch (e) {
      setMsg('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="panel">
      <div className="panel__bar" style={{ flexWrap: 'wrap' }}>
        <select
          value={taskId}
          data-testid="batch-task"
          onChange={(e) => setTaskId(e.target.value)}
        >
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <select
          value={scope}
          data-testid="batch-scope"
          onChange={(e) =>
            setScope(
              e.target.value as 'all' | 'item' | 'attachment' | 'select' | 'group' | 'tag'
            )
          }
        >
          <option value="all">全部</option>
          {task?.input !== 'item' && <option value="attachment">当前文档</option>}
          <option value="item">当前条目</option>
          <option value="select">多选条目</option>
          <option value="group">按分组</option>
          <option value="tag">按标签</option>
        </select>
        {scope === 'group' && (
          <select
            value={groupName}
            data-testid="batch-group"
            title="对整个分组（含子分组）批量执行"
            onChange={(e) => setGroupName(e.target.value)}
          >
            <option value="">选择分组…</option>
            {groupOptions.map((g) => (
              <option key={g.name} value={g.name}>
                {`${'　'.repeat(g.depth)}${groupDisplayName(g.name)}（${groupSubtreeCount(g)}）`}
              </option>
            ))}
          </select>
        )}
        {scope === 'tag' && (
          <select
            value={tagName}
            data-testid="batch-tag"
            title="对该标签下的全部论文批量执行"
            onChange={(e) => setTagName(e.target.value)}
          >
            <option value="">选择标签…</option>
            {tags.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}（{t.count}）
              </option>
            ))}
          </select>
        )}
        <button
          className="primary"
          disabled={
            busy ||
            (scope === 'select' && selected.size === 0) ||
            (scope === 'group' && !groupName) ||
            (scope === 'tag' && !tagName)
          }
          onClick={() => void create()}
          data-testid="batch-create"
          title="按默认参数直接执行；分析结果会自动归档到论文拆解"
        >
          <Icon name="play" size={14} />
          创建作业
        </button>
        {msg && <span className="meta__muted">{msg}</span>}
      </div>

      {scope === 'select' && (
        <div className="batch__pick" data-testid="batch-pick">
          <div className="panel__bar" style={{ borderBottom: 'none', paddingTop: 4 }}>
            <input
              className="ai__input"
              placeholder="筛选条目…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button className="ghost" onClick={() => setSelected(new Set(allItems.map((i) => i.id)))}>
              全选
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())}>
              清空
            </button>
            <span className="meta__muted">已选 {selected.size}</span>
          </div>
          <ul className="batch__picklist" data-testid="batch-picklist">
            {allItems
              .filter((it) => !filter.trim() || (it.title ?? '').toLowerCase().includes(filter.trim().toLowerCase()))
              .map((it) => (
                <li key={it.id}>
                  <label className="batch__pickitem">
                    <input
                      type="checkbox"
                      checked={selected.has(it.id)}
                      data-testid={`batch-pick-${it.id}`}
                      onChange={() => togglePick(it.id)}
                    />
                    <span className="batch__picktitle">{it.title ?? it.key}</span>
                    <span className="meta__muted">{it.year ?? ''}</span>
                  </label>
                </li>
              ))}
          </ul>
        </div>
      )}


      <div className="meta__label" style={{ padding: '10px 14px 0' }}>
        作业（显示 {shownJobs.length} / 共 {jobs.length}）
      </div>
      <div className="panel__bar" style={{ borderBottom: 'none', paddingTop: 4 }}>
        <select
          value={jobStatus}
          data-testid="batch-filter-status"
          onChange={(e) => setJobStatus(e.target.value as JobStatusFilter)}
        >
          <option value="all">全部</option>
          <option value="active">进行中</option>
          <option value="done">已完成</option>
          <option value="failed">失败</option>
        </select>
        <input
          className="ai__input"
          placeholder="按标题筛选…"
          value={jobKeyword}
          data-testid="batch-filter-keyword"
          onChange={(e) => setJobKeyword(e.target.value)}
        />
        <div
          data-testid="batch-filter-fail-reason"
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
        >
          <span className="meta__muted">失败原因</span>
          {failReasonOptions.map((opt, i) => (
            <label
              key={opt.message}
              className="meta__muted"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <input
                type="checkbox"
                style={{ width: 'auto', flex: '0 0 auto', minWidth: 0 }}
                data-testid={`batch-filter-fail-reason-opt-${i}`}
                data-reason={opt.message}
                checked={failReason.includes(opt.message)}
                onChange={() => toggleFailReason(opt.message)}
              />
              {`${opt.message}（${opt.count}）`}
            </label>
          ))}
          <button
            className="ghost"
            data-testid="batch-filter-fail-reason-all"
            onClick={() => setFailReason([])}
          >
            全部原因
          </button>
        </div>
      </div>
      {shownJobs.length === 0 && jobs.length > 0 && (
        <div className="list__hint" style={{ padding: '0 14px' }}>
          没有匹配的作业
        </div>
      )}
      <ul className="batch__list" data-testid="batch-jobs">
        {jobs.length === 0 && <li className="list__hint">还没有批处理作业</li>}
        {shownJobs.map((j) => (
          <li key={j.id} className="batch__job">
            <div
              className="batch__job-head"
              data-testid={`batch-job-${j.id}`}
              onClick={() => void loadItems(j.id)}
            >
              <span className="batch__dot" style={{ background: STATUS_COLOR[j.status] }} />
              <span className="batch__title" title={j.title}>
                {j.title}
              </span>
              <span className="batch__status" style={{ color: STATUS_COLOR[j.status] }}>
                {STATUS_LABEL[j.status] ?? j.status}
              </span>
            </div>
            <div className="batch__bar">
              <i style={{ width: `${pct(j)}%`, background: STATUS_COLOR[j.status] }} />
            </div>
            <div className="batch__meta">
              {j.done}/{j.total} · {j.message ?? ''} ·{' '}
              <span data-testid={`batch-run-${j.id}`} title="同一批次标识的作业共享一个提案批次">
                批次 {j.batch_run_id || j.key}
              </span>
            </div>
            <div className="batch__actions">
              {(j.status === 'running' || j.status === 'queued' || j.status === 'scheduled') && (
                <button className="icon ghost" title="取消" onClick={() => void window.api.batch.cancel(j.id).then(reload)}>
                  <Icon name="stop" size={14} />
                </button>
              )}
              {isTerminalJob(j.status) && isBatchDigestTask(j.task) && (
                <div className="batch__sync" data-testid={`batch-sync-${j.id}`}>
                  <div className="batch__sync-head">同步拆解结果</div>
                  <div className="batch__sync-grid">
                    <div className="batch__sync-item" data-testid={`batch-sync-knowledge-${j.id}`}>
                      <button
                        className="ghost"
                        data-testid="batch-sync-knowledge"
                        disabled={syncing?.jobId === j.id || !!digestSyncBlocked}
                        title={
                          digestSyncBlocked
                            ? `${digestSyncBlocked}：到 设置 → AI 工具库 重新打开（或恢复默认）`
                            : '同步拆解要点到知识库暂存区（只生成待审提案）'
                        }
                        onClick={() => {
                          if (digestSyncBlocked) return
                          void syncBatch(j, 'knowledge')
                        }}
                      >
                        {syncing?.jobId === j.id && syncing.target === 'knowledge'
                          ? '同步中…'
                          : '同步到知识库'}
                      </button>
                    </div>
                    <div className="batch__sync-item" data-testid={`batch-sync-mindmap-${j.id}`}>
                      <button
                        className="ghost"
                        data-testid="batch-sync-mindmap"
                        disabled={syncing?.jobId === j.id || !!digestSyncBlocked}
                        title={
                          digestSyncBlocked
                            ? `${digestSyncBlocked}：到 设置 → AI 工具库 重新打开（或恢复默认）`
                            : '把拆解要点写入每篇论文的思维地图（覆盖上一次同步）'
                        }
                        onClick={() => {
                          if (digestSyncBlocked) return
                          void syncBatch(j, 'mindmap')
                        }}
                      >
                        {syncing?.jobId === j.id && syncing.target === 'mindmap'
                          ? '同步中…'
                          : '同步到思维地图'}
                      </button>
                    </div>
                    <div className="batch__sync-item" data-testid={`batch-organize-${j.id}`}>
                      <button
                        className="ghost"
                        data-testid="batch-organize"
                        disabled={syncing?.jobId === j.id}
                        title="批处理完成后先出整理草稿（结构/主题/证据），预览来源与推断标记后再保存"
                        onClick={() => setOrganizeRun(j.batch_run_id)}
                      >
                        智能整理
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {(['knowledge', 'mindmap'] as const).map((target) => {
                const result = syncResults[`${j.id}:${target}`]
                if (!result) return null
                const detailItems = result.items ?? []
                const label = target === 'mindmap' ? '同步到思维地图' : '同步到知识库'
                return (
                  <div
                    className="batch__sync-result"
                    key={target}
                    data-testid={`batch-sync-result-${j.id}-${target}`}
                  >
                    <div className="batch__sync-summary" data-testid="batch-sync-result">
                      <span className="batch__sync-summary-label">{label}</span>
                      <span className="batch__sync-counts" data-testid={`batch-sync-counts-${j.id}-${target}`}>
                        成功 {result.success ?? 0} · 跳过 {result.skipped ?? 0} · 失败{' '}
                        {result.failed ?? 0}
                      </span>
                    </div>
                    {detailItems.length > 0 && (
                      <details className="batch__sync-details" data-testid="batch-sync-detail">
                        <summary>明细（{detailItems.length} 篇）</summary>
                        <ul className="batch__sync-rows">
                          {detailItems.map((item, index) => (
                            <li
                              key={`${target}-${item.itemId ?? 'x'}-${item.batchItemId ?? 'x'}-${index}`}
                              className={`batch__sync-row batch__sync-row--${item.status}`}
                              data-testid={`batch-sync-detail-row-${j.id}-${target}-${index}`}
                            >
                              <span className="batch__sync-row-title" title={item.title}>
                                {item.title}
                              </span>
                              <span className="batch__sync-row-status">
                                {SYNC_STATUS_LABEL[item.status] ?? item.status}
                              </span>
                              <span className="batch__sync-row-reason">{item.reason}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )
              })}
              {(j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') &&
                (failCounts[j.id] ?? 0) > 0 && (
                  <button
                    className="ghost"
                    title="只重试该作业中失败的项"
                    data-testid={`batch-retry-${j.id}`}
                    onClick={() => void retry(j.id)}
                  >
                    只重试失败项
                  </button>
                )}
              <button
                className="icon ghost"
                title="打开产物目录"
                onClick={() => void window.api.batch.openOutput(j.id)}
              >
                <Icon name="folder" size={14} />
              </button>
              <button
                className="icon ghost"
                title="删除记录"
                onClick={() => void window.api.batch.remove(j.id).then(reload)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
            {expanded === j.id && (
              <>
                <div className="batch__items-summary" data-testid={`batch-items-summary-${j.id}`}>
                  {(() => {
                    const done = items.filter((x) => x.status === 'done').length
                    const failed = items.filter((x) => x.status === 'failed').length
                    const other = items.length - done - failed
                    const hint =
                      isTerminalJob(j.status) && isBatchDigestTask(j.task)
                        ? ' · 勾选论文=只同步所选，不勾选=整批'
                        : ''
                    return `共 ${items.length} · 完成 ${done} · 失败 ${failed}${
                      other > 0 ? ` · 其它 ${other}` : ''
                    }${hint}`
                  })()}
                </div>
                {(() => {
                  const { reasons, total } = topFailReasons(items)
                  if (total === 0) return null
                  return (
                    <div className="batch__fail" data-testid={`batch-fail-reasons-${j.id}`}>
                      <div className="batch__fail-title">失败原因（Top {reasons.length}）：</div>
                      <ul className="batch__fail-list">
                        {reasons.map((r) => (
                          <li key={r.message}>{`${r.message} ×${r.count}`}</li>
                        ))}
                      </ul>
                      <button
                        className="ghost"
                        data-testid={`batch-copy-failed-${j.id}`}
                        onClick={() =>
                          void window.api.app.copyText(
                            items
                              .filter((x) => x.status === 'failed')
                              .map((x) => `${x.label ?? '#' + x.id}：${x.message ?? ''}`)
                              .join('\n')
                          )
                        }
                      >
                        复制失败清单
                      </button>
                      <button
                        className="ghost"
                        data-testid="batch-export-failed-md"
                        onClick={() =>
                          void exportFailed('批处理失败清单.md', failedItemsToMarkdown(items))
                        }
                      >
                        导出失败清单 .md
                      </button>
                      <button
                        className="ghost"
                        data-testid="batch-export-failed-csv"
                        onClick={() =>
                          void exportFailed('批处理失败清单.csv', failedItemsToCsv(items))
                        }
                      >
                        导出失败清单 .csv
                      </button>
                    </div>
                  )
                })()}
                <ul className="batch__items">
                  {items.length === 0 && <li className="list__hint">（暂无明细）</li>}
                  {items.map((it) => (
                    <li key={it.id} className="batch__item">
                      {it.status === 'done' && it.item_id != null && (
                        <input
                          type="checkbox"
                          data-testid={`batch-sync-pick-${it.item_id}`}
                          title="勾选后只同步这篇论文；不勾选任何论文时同步整批"
                          checked={syncPicks.has(it.item_id)}
                          onChange={() => toggleSyncPick(it.item_id as number)}
                        />
                      )}
                      <span className={`batch__chip batch__chip--${it.status}`}>{it.status}</span>
                      <span className="batch__item-label">{it.label ?? `#${it.id}`}</span>
                      {it.message && <span className="meta__muted">{it.message}</span>}
                      {it.status === 'done' &&
                        it.item_id != null &&
                        onOpenNotes &&
                        (it.message?.includes('已写入笔记') ||
                          it.message?.includes('已入笔记') ||
                          it.message?.includes('已归档到笔记')) && (
                          <button
                            className="ghost"
                            data-testid={`batch-open-note-${it.id}`}
                            title="打开这条拆解报告所在的论文笔记"
                            onClick={() => onOpenNotes(it.item_id as number)}
                          >
                            查看笔记
                          </button>
                        )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
      {organizeRun && (
        <OrganizePanel
          runId={organizeRun}
          onClose={() => setOrganizeRun(null)}
          onOpenResult={() => setOrganizeRun(null)}
        />
      )}
    </div>
  )
}
