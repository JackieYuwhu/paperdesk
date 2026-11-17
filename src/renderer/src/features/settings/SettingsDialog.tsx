import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import {
  AI_TOOLS,
  AI_TOOL_CATEGORIES,
  AI_TOOL_CATEGORY_LABELS,
  AI_TOOL_PERMISSION_LABELS,
  resolveToolState
} from '@shared/ai-tools'
import type {
  AiToolCategory,
  AiToolDefinition,
  AiToolPermission,
  AiToolState
} from '@shared/ai-tools'
import type {
  ConnectorStatus,
  KnowledgeStatus,
  ProviderTestResult,
  PublicSettings,
  SystemHealth,
  TestFaultStatus,
  TranslateSkill
} from '@shared/types'

/** 内置拆解技能名（不可删除） */
const BUILTIN_SKILL_NAMES = ['paper-analysis', 'survey', 'method', 'reviewer']

interface Props {
  onClose: () => void
  onThemeChange?: (theme: string) => void
  /** 打开知识库正式条目面板（PD36）；未提供时不显示入口（独立渲染/测试场景） */
  onOpenKnowledge?: () => void
  /** 打开知识库暂存区（PD34）；未提供时不显示入口（独立渲染/测试场景） */
  onOpenStaging?: () => void
  /**
   * 打开后直接定位到某一段（PD50）：知识库的「配置语义检索」入口
   * 需要落到「语义检索」段，而不是让用户自己在长表单里找。
   */
  initialSection?: 'embed' | null
}

/** 导入前预览：某技能相对本地的变更 */
interface SkillDiff {
  next: TranslateSkill
  prev?: TranslateSkill
  match: string
  isNew: boolean
  changes: string[]
  dir: 'new' | 'up' | 'down' | 'same'
}

const SCOPE_LABEL: Record<string, string> = {
  all: '全文',
  first: '仅首页',
  rest: '第 2 页起'
}

/** 字符级差异（去除公共前后缀后高亮中间变化部分） */
function CharDiff({ before, after }: { before: string; after: string }): React.JSX.Element {
  let pre = 0
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++
  let suf = 0
  while (
    suf < before.length - pre &&
    suf < after.length - pre &&
    before[before.length - 1 - suf] === after[after.length - 1 - suf]
  ) {
    suf++
  }
  const head = before.slice(0, pre)
  const oldMid = before.slice(pre, before.length - suf)
  const newMid = after.slice(pre, after.length - suf)
  const tail = after.slice(after.length - suf)
  return (
    <div className="chardiff">
      <div className="chardiff__row chardiff__row--old">
        <span className="chardiff__sign">−</span>
        <span>
          {head}
          <del>{oldMid}</del>
          {tail}
        </span>
      </div>
      <div className="chardiff__row chardiff__row--new">
        <span className="chardiff__sign">+</span>
        <span>
          {head}
          <ins>{newMid}</ins>
          {tail}
        </span>
      </div>
    </div>
  )
}

/** 兜底补全，避免历史数据/异常返回导致界面崩溃 */
function normalize(r: PublicSettings): PublicSettings {
  return {
    provider: {
      protocol: r.provider?.protocol ?? (/anthropic\.com|\/messages(?:[/?#]|$)/i.test(r.provider?.baseUrl ?? '') ? 'anthropic' : 'openai'),
      baseUrl: r.provider?.baseUrl ?? '',
      apiKeySet: !!r.provider?.apiKeySet,
      chatModel: r.provider?.chatModel ?? '',
      embedModel: r.provider?.embedModel ?? '',
      mtModel: r.provider?.mtModel ?? '',
      mode: r.provider?.mode ?? 'auto'
    },
    mt: {
      engine: r.mt?.engine ?? 'simple',
      keepVersions: r.mt?.keepVersions ?? '0',
      glossary: r.mt?.glossary ?? '',
      autoGlossary: r.mt?.autoGlossary ?? '1',
      thinking: r.mt?.thinking ?? '0',
      fontDelta: r.mt?.fontDelta ?? '1.5'
    },
    embed: { enabled: r.embed?.enabled ?? '1', mode: r.embed?.mode ?? 'local' },
    batch: {
      concurrency: r.batch?.concurrency ?? '1',
      offPeakOnly: r.batch?.offPeakOnly ?? '0',
      offPeakStart: r.batch?.offPeakStart ?? '00:30',
      offPeakEnd: r.batch?.offPeakEnd ?? '08:30'
    },
    analysis: {
      workers: r.analysis?.workers ?? '4',
      cardWorkers: r.analysis?.cardWorkers ?? '4',
      fastModel: r.analysis?.fastModel ?? '',
      strongModel: r.analysis?.strongModel ?? ''
    },
    openalex: { mailto: r.openalex?.mailto ?? '', apiKey: '', apiKeySet: !!r.openalex?.apiKeySet },
    scholar: { apiKey: '', apiKeySet: !!r.scholar?.apiKeySet },
    semantic: { apiKey: '', apiKeySet: !!r.semantic?.apiKeySet },
    metadata: {
      crossref: r.metadata?.crossref ?? '1',
      crossrefLimit: r.metadata?.crossrefLimit ?? '12'
    },
    grobid: { url: r.grobid?.url ?? '' },
    websearch: {
      // 三态：'0' 关闭 / 'auto' 自动（本地无依据才联网）/ '1' 始终
      enabled:
        r.websearch?.enabled === '1' ? '1' : r.websearch?.enabled === 'auto' ? 'auto' : '0',
      proxy: r.websearch?.proxy ?? ''
    },
    // 严格依据文献：'1' 只用检索证据，'0' 允许模型通用知识（标注【模型知识】）
    strictEvidence: r.strictEvidence === '1' ? '1' : '0',
    ui: { theme: r.ui?.theme ?? 'light' },
    // 结构化解析（实验）：缺省 = 关闭
    blocksAdapter: !!r.blocksAdapter
  }
}

export function SettingsDialog({
  onClose,
  onThemeChange,
  onOpenKnowledge,
  onOpenStaging,
  initialSection = null
}: Props): React.JSX.Element {
  const [s, setS] = useState<PublicSettings | null>(null)
  /** 「语义检索」段的锚点（PD50：知识库按钮跳进来要直接看到这一段） */
  const embedSectionRef = useRef<HTMLHeadingElement | null>(null)
  const [activeSection, setActiveSection] = useState(initialSection === 'embed' ? 'search' : 'model')
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState('')
  const [health, setHealth] = useState<SystemHealth | null>(null)
  const [checking, setChecking] = useState(false)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [skills, setSkills] = useState<TranslateSkill[]>([])
  const [skillDraft, setSkillDraft] = useState<Record<string, string>>({})
  const [skillSkip, setSkillSkip] = useState<Record<string, boolean>>({})
  const [skillScope, setSkillScope] = useState<Record<string, string>>({})
  const [skillPreview, setSkillPreview] = useState<Record<string, boolean>>({})
  const [skillStatus, setSkillStatus] = useState('')
  const [skillConflicts, setSkillConflicts] = useState<string[]>([])
  const [skillUpdates, setSkillUpdates] = useState<string[]>([])
  const [skillDiff, setSkillDiff] = useState<SkillDiff[] | null>(null)
  const [skillSel, setSkillSel] = useState<Record<string, boolean>>({})
  const [orphans, setOrphans] = useState<{
    list: { name: string; bytes: number }[]
    bytes: number
    dir: string
  } | null>(null)
  const [orphanStatus, setOrphanStatus] = useState('')
  const [dataStatus, setDataStatus] = useState('')
  /** 测试副本故障注入状态（FA02）：不设开关时显示「未启用」，取数前显示读取中 */
  const [testFault, setTestFault] = useState<TestFaultStatus | null>(null)
  const [testFaultFailed, setTestFaultFailed] = useState(false)
  const [connector, setConnector] = useState<ConnectorStatus | null>(null)
  const [analysisSkill, setAnalysisSkill] = useState('')
  const [analysisStatus, setAnalysisStatus] = useState('')
  // 多套拆解技能：当前编辑的名字 + 可选列表
  const [analysisSkillName, setAnalysisSkillName] = useState('paper-analysis')
  const [analysisSkillList, setAnalysisSkillList] = useState<string[]>(['paper-analysis'])
  const [analysisNewName, setAnalysisNewName] = useState('')
  const [confirmDeleteSkill, setConfirmDeleteSkill] = useState(false)
  // 知识库占位状态（PD31：只读；不影响设置保存）
  const [knowledge, setKnowledge] = useState<KnowledgeStatus | null>(null)
  // AI 工具库（PD54）：按类别列出所有 AI 能力与权限开关，改完即存，不依赖「保存」按钮
  const [aiTools, setAiTools] = useState<AiToolState[]>([])
  const [aiToolWarnings, setAiToolWarnings] = useState<string[]>([])
  const [aiToolCategory, setAiToolCategory] = useState<AiToolCategory | 'all'>('all')
  const [aiToolQuery, setAiToolQuery] = useState('')
  const [aiToolStatus, setAiToolStatus] = useState('')

  useEffect(() => {
    void window.api.skills
      .list()
      .then((s) => {
        setSkills(s)
        setSkillDraft(Object.fromEntries(s.map((x) => [x.id, x.system])))
        setSkillSkip(Object.fromEntries(s.map((x) => [x.id, x.skip])))
      })
      .catch(() => undefined)
  }, [])

  // 论文拆解技能文本（可编辑；支持多套技能）
  useEffect(() => {
    void window.api.analysis
      .getSkill()
      .then(setAnalysisSkill)
      .catch(() => undefined)
    void window.api.analysis
      .listSkills()
      .then((list) => {
        setAnalysisSkillList(list)
        setAnalysisSkillName((cur) => (list.includes(cur) ? cur : 'paper-analysis'))
      })
      .catch(() => undefined)
  }, [])

  const applySkills = (s: TranslateSkill[]): void => {
    setSkills(s)
    setSkillDraft(Object.fromEntries(s.map((x) => [x.id, x.system])))
    setSkillSkip(Object.fromEntries(s.map((x) => [x.id, x.skip])))
    setSkillScope(Object.fromEntries(s.map((x) => [x.id, x.scope || 'all'])))
  }

  const saveSkill = async (id: string): Promise<void> => {
    try {
      applySkills(
        await window.api.skills.save(
          id,
          skillDraft[id] ?? '',
          !!skillSkip[id],
          skillScope[id] ?? 'all'
        )
      )
      setSkillStatus(`已保存「${id}」 ${new Date().toLocaleTimeString()}`)
    } catch (e) {
      setSkillStatus('保存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const resetSkills = async (): Promise<void> => {
    try {
      applySkills(await window.api.skills.reset())
      setSkillStatus('已恢复默认技能')
    } catch (e) {
      setSkillStatus('恢复失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** 一键预设：只翻译正文（标题/题注/公式/参考文献/页眉页脚 保持原样） */
  const applyBodyOnlyPreset = async (): Promise<void> => {
    try {
      let list: TranslateSkill[] = skills
      for (const sk of skills) {
        list = await window.api.skills.save(sk.id, sk.system, sk.id !== 'body', sk.scope || 'all')
      }
      applySkills(list)
      setSkillStatus('已切换为「仅翻译正文」（其余类型保持原样）')
    } catch (e) {
      setSkillStatus('应用预设失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const exportSettings = async (): Promise<void> => {
    try {
      const p = await window.api.settings.exportFile()
      if (p) setStatus('已导出设置：' + p)
    } catch (e) {
      setStatus('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const importSettings = async (): Promise<void> => {
    try {
      const r = await window.api.settings.importFile()
      if (r) {
        setS(normalize(r))
        setStatus('已导入设置（API Key 需重新填写）')
        onThemeChange?.(r.ui?.theme ?? 'light')
      }
    } catch (e) {
      setStatus('导入失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const scanOrphans = async (): Promise<void> => {
    try {
      const r = await window.api.translate.orphans()
      setOrphans({ list: r.orphans, bytes: r.bytes, dir: r.dir })
      setOrphanStatus(
        r.orphans.length
          ? `发现 ${r.orphans.length} 个孤儿文件（${(r.bytes / 1024).toFixed(1)} KB）`
          : '没有孤儿文件'
      )
    } catch (e) {
      setOrphanStatus('扫描失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const exportOrphans = async (): Promise<void> => {
    try {
      const r = await window.api.translate.orphans()
      const lines = [
        '# 孤儿文件清单',
        '',
        `- 数量：${r.orphans.length}`,
        `- 占用：${(r.bytes / 1024).toFixed(1)} KB`,
        ''
      ]
      for (const f of r.orphans) lines.push(`- ${(f.bytes / 1024).toFixed(1)} KB　${f.name}`)
      const p = await window.api.translate.saveReport('orphan-files.md', lines.join('\n'))
      if (p) setOrphanStatus('已导出清单：' + p)
    } catch (e) {
      setOrphanStatus('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const cleanOrphans = async (): Promise<void> => {
    try {
      const names = orphans ? orphans.list.map((o) => o.name) : undefined
      const n = await window.api.translate.cleanOrphans(names)
      setOrphanStatus(`已清理 ${n} 个文件`)
      await scanOrphans()
    } catch (e) {
      setOrphanStatus('清理失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const revealOrphans = (): void => {
    if (!orphans?.dir) return
    void window.api.files.reveal(orphans.dir)
  }

  const loadAnalysisSkill = async (name: string): Promise<void> => {
    setAnalysisSkillName(name)
    try {
      setAnalysisSkill(await window.api.analysis.getSkill(name))
    } catch (e) {
      setAnalysisStatus('读取失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const saveAnalysisSkill = async (): Promise<void> => {
    try {
      await window.api.analysis.saveSkill(analysisSkill, analysisSkillName)
      setAnalysisStatus(`已保存「${analysisSkillName}」（下次拆解生效）`)
    } catch (e) {
      setAnalysisStatus('保存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const resetAnalysisSkill = async (): Promise<void> => {
    try {
      setAnalysisSkill(await window.api.analysis.resetSkill(analysisSkillName))
      setAnalysisStatus(`已恢复内置内容到「${analysisSkillName}」`)
    } catch (e) {
      setAnalysisStatus('恢复失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const copyAnalysisSkill = async (): Promise<void> => {
    const to = analysisNewName.trim()
    if (!to) {
      setAnalysisStatus('请先填写新技能名（英文/数字/连字符）')
      return
    }
    try {
      const name = await window.api.analysis.copySkill(analysisSkillName, to)
      setAnalysisSkillList(await window.api.analysis.listSkills())
      setAnalysisSkillName(name)
      setAnalysisNewName('')
      setAnalysisStatus(`已另存为「${name}」`)
    } catch (e) {
      setAnalysisStatus('另存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const deleteAnalysisSkill = async (): Promise<void> => {
    if (BUILTIN_SKILL_NAMES.includes(analysisSkillName)) {
      setAnalysisStatus('内置技能不可删除')
      return
    }
    if (!confirmDeleteSkill) {
      setConfirmDeleteSkill(true)
      setAnalysisStatus(`再点一次「确认删除」以删除「${analysisSkillName}」`)
      return
    }
    setConfirmDeleteSkill(false)
    try {
      setAnalysisSkillList(await window.api.analysis.deleteSkill(analysisSkillName))
      await loadAnalysisSkill('paper-analysis')
      setAnalysisStatus('已删除')
    } catch (e) {
      setAnalysisStatus('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const backupData = async (): Promise<void> => {
    try {
      const p = await window.api.data.backup()
      if (p) setDataStatus('已备份：' + p)
    } catch (e) {
      setDataStatus('备份失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const restoreData = async (): Promise<void> => {
    if (!window.confirm('从备份恢复会覆盖当前数据库（恢复前会自动备份当前库）。继续？')) return
    try {
      const r = await window.api.data.restore()
      if (r) setDataStatus(`已恢复（安全备份：${r.safety ?? '无'}）`)
    } catch (e) {
      setDataStatus('恢复失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const toggleConnector = async (enabled: boolean): Promise<void> => {
    try {
      setConnector(await window.api.connector.setEnabled(enabled))
      setDataStatus(enabled ? '已启用 Zotero 连接器' : '已停用 Zotero 连接器')
    } catch (e) {
      setDataStatus('连接器切换失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const copyConnector = async (): Promise<void> => {
    if (!connector) return
    await window.api.app.copyText(`${connector.url}  token: ${connector.token}`)
    setDataStatus('已复制连接器地址与令牌')
  }

  const exportSkills = async (): Promise<void> => {
    try {
      const p = await window.api.skills.exportFile()
      if (p) setSkillStatus('已导出：' + p)
    } catch (e) {
      setSkillStatus('导出失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const unsavedSkills = (): string[] => {
    const out: string[] = []
    for (const sk of skills) {
      const draft = skillDraft[sk.id] ?? ''
      const skip = !!skillSkip[sk.id]
      const scope = skillScope[sk.id] ?? 'all'
      if (draft !== sk.system || skip !== !!sk.skip || scope !== (sk.scope || 'all')) {
        out.push(sk.id)
      }
    }
    return out
  }

  const importSkills = async (): Promise<void> => {
    const dirty = unsavedSkills()
    if (
      dirty.length > 0 &&
      !window.confirm(
        `有 ${dirty.length} 项技能改动尚未保存，导入会用文件内容覆盖这些草稿：${dirty.join('、')}。仍要继续？`
      )
    ) {
      return
    }
    try {
      const parsed = await window.api.skills.importFile()
      if (!parsed) return
      const cur = new Map(skills.map((s) => [s.id, s]))
      const diff: SkillDiff[] = parsed.map((p) => {
        const c = cur.get(p.match)
        const changes: string[] = []
        let dir: SkillDiff['dir'] = 'new'
        if (c) {
          if ((p.system ?? '') !== c.system) changes.push('system')
          if (!!p.skip !== !!c.skip) changes.push('skip')
          if ((p.scope || 'all') !== (c.scope || 'all')) changes.push('scope')
          const pv = Number(p.version || 0)
          const cv = Number(c.version || 0)
          if (pv !== cv) changes.push(`v${cv}→v${pv}`)
          dir = pv > cv ? 'up' : pv < cv ? 'down' : 'same'
        }
        return { next: p, prev: c, match: p.match, isNew: !c, changes, dir }
      })
      setSkillDiff(diff)
      setSkillSel(
        Object.fromEntries(diff.map((d) => [d.match, d.isNew || (d.dir === 'up' && d.changes.length > 0)]))
      )
      setSkillStatus(`已选择文件，待确认：${diff.length} 项`)
    } catch (e) {
      setSkillStatus('读取技能文件失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const applyDiff = async (): Promise<void> => {
    const only = (skillDiff ?? []).filter((d) => skillSel[d.match]).map((d) => d.match)
    if (only.length === 0) {
      setSkillStatus('未选择任何技能')
      return
    }
    try {
      const r = await window.api.skills.applyImport(true, only)
      applySkills(r.skills)
      setSkillConflicts(r.conflicts)
      setSkillUpdates(r.updates)
      setSkillDiff(null)
      setSkillSel({})
      setSkillStatus(`已应用 ${r.imported} 项`)
    } catch (e) {
      setSkillStatus('应用失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const forceImport = async (only?: string[]): Promise<void> => {
    try {
      const r = await window.api.skills.applyImport(true, only)
      applySkills(r.skills)
      setSkillConflicts(r.conflicts)
      setSkillStatus(
        only && only.length
          ? `已采用导入版：${only.join('/')}`
          : `已覆盖导入 ${r.imported} 项`
      )
    } catch (e) {
      setSkillStatus('覆盖导入失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  useEffect(() => {
    void window.api.settings
      .get()
      .then((r) => setS(normalize(r)))
      .catch((e: unknown) => setStatus('读取设置失败：' + (e instanceof Error ? e.message : String(e))))
  }, [])

  // AI 工具库（PD54）：读一次 + 订阅广播（主进程 update/reset 后各窗口都能跟上）
  useEffect(() => {
    let alive = true
    void window.api.aiTools.list().then(
      (r) => {
        if (!alive) return
        setAiTools(r.tools)
        setAiToolWarnings(r.warnings ?? [])
      },
      (e: unknown) => {
        if (!alive) return
        setAiTools(resolveToolState(AI_TOOLS))
        setAiToolStatus('读取 AI 工具库失败：' + (e instanceof Error ? e.message : String(e)))
      }
    )
    const off = window.api.onAiToolsChanged((r) => {
      setAiTools(r?.tools ?? [])
      setAiToolWarnings(r?.warnings ?? [])
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  /** 更新单个工具：enabled 覆盖开关，permissions 按 key 合并；失败在面板里给出可读原因 */
  const patchAiTool = async (
    id: string,
    patch: { enabled?: boolean; permissions?: Partial<Record<AiToolPermission, boolean>> }
  ): Promise<void> => {
    try {
      const r = await window.api.aiTools.update({ id, ...patch })
      setAiTools(r.tools)
      setAiToolWarnings(r.warnings ?? [])
      setAiToolStatus('')
    } catch (e) {
      setAiToolStatus('保存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const toggleAiToolEnabled = (state: AiToolState): void => {
    void patchAiTool(state.id, { enabled: !state.enabled })
  }

  const toggleAiToolPermission = (state: AiToolState, permission: AiToolPermission): void => {
    const permissions: Partial<Record<AiToolPermission, boolean>> = {}
    permissions[permission] = state.permissions[permission] === false
    void patchAiTool(state.id, { permissions })
  }

  const resetAiToolLibrary = async (): Promise<void> => {
    try {
      const r = await window.api.aiTools.reset()
      setAiTools(r.tools)
      setAiToolWarnings([])
      setAiToolStatus('已恢复默认：所有 AI 工具启用、权限全开')
    } catch (e) {
      setAiToolStatus('恢复默认失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // 指定段落定位（PD50）：设置表单很长，从知识库点进来必须直接落到「语义检索」
  useEffect(() => {
    if (!s || initialSection !== 'embed') return
    const target = embedSectionRef.current
    if (!target) return
    target.scrollIntoView({ block: 'start' })
  }, [!!s, initialSection])

  // Zotero 连接器状态（首次读取会在主进程生成令牌）
  useEffect(() => {
    void window.api.connector
      .status()
      .then(setConnector)
      .catch(() => undefined)
  }, [])

  // 测试副本故障注入状态（FA02）：只读，每次打开设置页重新取一次
  useEffect(() => {
    void window.api.data
      .testFault()
      .then(setTestFault)
      .catch(() => setTestFaultFailed(true))
  }, [])

  // 知识库占位状态（PD31）：只读取一次，不提供任何检索/上传操作
  useEffect(() => {
    void window.api.settings
      .knowledgeStatus()
      .then(setKnowledge)
      .catch(() => undefined)
  }, [])

  const save = async (): Promise<boolean> => {
    if (!s || saving) return false
    setSaving(true)
    try {
      const saved = await window.api.settings.save({
        provider: {
          protocol: s.provider.protocol,
          baseUrl: s.provider.baseUrl,
          chatModel: s.provider.chatModel,
          embedModel: s.provider.embedModel,
          mtModel: s.provider.mtModel,
          mode: s.provider.mode,
          ...(apiKey ? { apiKey } : {})
        },
        mt: {
          engine: s.mt.engine,
          keepVersions: s.mt.keepVersions,
          glossary: s.mt.glossary,
          autoGlossary: s.mt.autoGlossary,
          thinking: s.mt.thinking,
          fontDelta: s.mt.fontDelta
        },
        embed: { enabled: s.embed.enabled, mode: s.embed.mode },
        batch: {
          concurrency: s.batch.concurrency,
          offPeakOnly: s.batch.offPeakOnly,
          offPeakStart: s.batch.offPeakStart,
          offPeakEnd: s.batch.offPeakEnd
        },
        analysis: {
          workers: s.analysis.workers,
          cardWorkers: s.analysis.cardWorkers,
          fastModel: s.analysis.fastModel,
          strongModel: s.analysis.strongModel
        },
        openalex: { mailto: s.openalex.mailto, ...(s.openalex.apiKey ? { apiKey: s.openalex.apiKey } : {}) },
    scholar: { ...(s.scholar.apiKey ? { apiKey: s.scholar.apiKey } : {}) },
    semantic: { ...(s.semantic.apiKey ? { apiKey: s.semantic.apiKey } : {}) },
        metadata: { crossref: s.metadata.crossref, crossrefLimit: s.metadata.crossrefLimit },
        grobid: { url: s.grobid.url },
        websearch: {
          enabled:
            s.websearch.enabled === '1' ? '1' : s.websearch.enabled === 'auto' ? 'auto' : '0',
          proxy: s.websearch.proxy.trim()
        },
        strictEvidence: s.strictEvidence === '1' ? '1' : '0',
        ui: { theme: s.ui.theme },
        blocksAdapter: !!s.blocksAdapter
      })
      setS(normalize(saved))
      setApiKey('')
      setStatus(`已保存 ${new Date().toLocaleTimeString()}`)
      return true
    } catch (e) {
      setStatus('保存失败：' + (e instanceof Error ? e.message : String(e)))
      return false
    } finally { setSaving(false) }
  }

  /**
   * 结构化解析（实验）开关：切换即保存，**只写 blocksAdapter 一个键**，
   * 不会连带提交表单里其它未保存的编辑；失败则回滚 UI 状态并给出原因。
   */
  const toggleBlocksAdapter = async (next: boolean): Promise<void> => {
    if (!s) return
    setS({ ...s, blocksAdapter: next })
    try {
      const saved = await window.api.settings.save({ blocksAdapter: next })
      setS((prev) => (prev ? { ...prev, blocksAdapter: !!saved.blocksAdapter } : normalize(saved)))
      setStatus(
        saved.blocksAdapter
          ? '结构化解析已开启：新解析的文档才会带块标注'
          : '结构化解析已关闭：保持与旧版一致的解析产物'
      )
    } catch (e) {
      setS((prev) => (prev ? { ...prev, blocksAdapter: !next } : prev))
      setStatus('保存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const testConn = async (): Promise<void> => {
    setTesting(true)
    try {
      if (!(await save())) return
      setTest(await window.api.system.testProvider())
    } catch (e) {
      setTest({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        model: '',
        baseUrl: '',
        latencyMs: 0
      })
    } finally {
      setTesting(false)
    }
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setHealth(await window.api.system.health())
    } finally {
      setChecking(false)
    }
  }

  // AI 工具库（PD54）：分类计数 + 关键词过滤（名称或说明）；过滤后为空给「清除筛选」
  const aiToolKeyword = aiToolQuery.trim().toLowerCase()
  const aiToolRows: { state: AiToolState; def: AiToolDefinition }[] = aiTools.flatMap((state) => {
    const def = AI_TOOLS.find((d) => d.id === state.id)
    return def ? [{ state, def }] : []
  })
  const visibleAiTools = aiToolRows
    .filter(({ def }) => aiToolCategory === 'all' || def.category === aiToolCategory)
    .filter(({ def }) =>
      aiToolKeyword
        ? def.name.toLowerCase().includes(aiToolKeyword) ||
          def.description.toLowerCase().includes(aiToolKeyword)
        : true
    )
  const aiToolCount = (category: AiToolCategory): number =>
    AI_TOOLS.filter((def) => def.category === category).length

  return (
    <div className="modal settings-overlay">
      <div className="modal__box settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()} data-testid="settings-dialog">
        <div className="modal__head">
          <div><span className="settings-eyebrow">PAPERDESK</span><h2 id="settings-title">设置</h2></div><span className="settings-version">v0.1.0</span>
          <button className="icon ghost" title="关闭" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            {[
              ['model', '模型服务', '连接与模型'], ['reading', '阅读与翻译', '翻译引擎与术语'],
              ['ai', 'AI 与自动化', '工具权限与批处理'], ['search', '检索与知识', '学术来源与知识库'],
              ['skills', '提示词与技能', '翻译与拆解模板'], ['data', '数据与集成', '备份、清理与 Zotero'],
              ['system', '外观与诊断', '主题与服务状态']
            ].map(([id, label, hint]) => <button key={id} aria-current={activeSection === id ? 'page' : undefined}
              data-testid={`settings-tab-${id}`} onClick={() => { setActiveSection(id); setStatus(''); }}>
              <strong>{label}</strong><span>{hint}</span></button>)}
            <div className="settings-nav-note">你的研究工作台<br />配置保存在本机</div>
          </nav>
        {!s ? (
          <div className="modal__body">加载中…</div>
        ) : (
          <div className="modal__body settings-content">
            <section className="settings-card" hidden={activeSection !== 'model'}>
            <h4>模型连接</h4>
            <p className="modal__hint">支持 OpenAI 与 Anthropic 两类接口。一次配置，用于论文问答、翻译与拆解；兼容网关请选择其提供的接口协议。</p>
            <div className="settings-protocols" role="group" aria-label="接口协议">
              {(['openai', 'anthropic'] as const).map((protocol) => <button key={protocol}
                type="button" aria-pressed={s.provider.protocol === protocol} data-testid={`protocol-${protocol}`}
                className={s.provider.protocol === protocol ? 'is-selected' : ''}
                onClick={() => { if (s.provider.protocol === protocol) return; setTest(null); setS({ ...s, provider: { ...s.provider, protocol,
                  baseUrl: !s.provider.baseUrl || /^https:\/\/api\.(openai|anthropic)\.com(?:\/|$)/.test(s.provider.baseUrl)
                    ? protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1' : s.provider.baseUrl,
                  chatModel: '', mtModel: '' } }) }}>
                <strong>{protocol === 'openai' ? 'OpenAI' : 'Anthropic'}</strong>
                <span>{protocol === 'openai' ? 'Chat Completions · 兼容服务' : 'Messages · Claude / 兼容服务'}</span>
              </button>)}
            </div>
            <div className="settings-connection-status"><span className={s.provider.apiKeySet ? 'is-ready' : ''} />{s.provider.apiKeySet ? 'API Key 已安全保存' : '尚未配置 API Key'}<span className="toolbar__spacer" />{s.provider.mode === 'mock' ? '离线模式' : '自动连接'}</div>
            <label className="field">
              <span>Base URL</span>
              <input
                data-testid="set-provider-baseurl"
                value={s.provider.baseUrl}
                placeholder={s.provider.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'}
                onChange={(e) => setS({ ...s, provider: { ...s.provider, baseUrl: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type={showKey ? "text" : "password"}
                autoComplete="off"
                data-testid="set-provider-key"
                value={apiKey}
                placeholder={s.provider.apiKeySet ? '已设置（留空则不修改）' : '未设置'}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            <div className="settings-key-actions"><button className="ghost" onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏密钥' : '显示本次输入'}</button><span>留空保留已保存的密钥 · 本机加密存储</span></div>
            <label className="field">
              <span>对话模型</span>
              <input
                data-testid="set-provider-chatmodel"
                value={s.provider.chatModel}
                placeholder={s.provider.protocol === 'anthropic' ? '填写服务提供的 Claude 模型 ID' : '填写服务提供的模型 ID'}
                onChange={(e) => setS({ ...s, provider: { ...s.provider, chatModel: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>向量模型</span>
              <input
                value={s.provider.embedModel}
                placeholder="text-embedding-3-small / bge-m3"
                onChange={(e) => setS({ ...s, provider: { ...s.provider, embedModel: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>翻译模型</span>
              <input
                data-testid="set-provider-mtmodel"
                value={s.provider.mtModel}
                placeholder="留空则复用对话模型"
                onChange={(e) => setS({ ...s, provider: { ...s.provider, mtModel: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>运行模式</span>
              <select
                data-testid="set-provider-mode"
                value={s.provider.mode}
                onChange={(e) => setS({ ...s, provider: { ...s.provider, mode: e.target.value } })}
              >
                <option value="auto">自动（配了就用真模型）</option>
                <option value="mock">强制离线占位</option>
              </select>
            </label>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button disabled={testing} onClick={() => void testConn()} data-testid="set-test-provider">
                <Icon name="sparkles" size={14} />
                {testing ? '连接中…' : '保存并测试连接'}
              </button>
              <span className="modal__hint" style={{ margin: 0 }}>
                使用当前填写的配置发送一次简短请求
              </span>
            </div>
            {test && (
              <div className="modal__hint" data-testid="set-test-result" style={{ marginTop: 8 }}>
                {test.ok
                  ? `✅ 连接成功（${test.model} · ${test.latencyMs}ms）`
                  : `❌ 连接失败：${test.error ?? '未知错误'}`}
              </div>
            )}
            </section>

            <section className="settings-card" hidden={activeSection !== 'reading'}>
            <h4>翻译</h4>
            <label className="field">
              <span>引擎</span>
              <select
                data-testid="set-mt-engine"
                value={s.mt.engine}
                onChange={(e) => setS({ ...s, mt: { ...s.mt, engine: e.target.value } })}
              >
                <option value="simple">内置（保版式，需文本层）</option>
                <option value="vision">视觉识别（模型读图，适合扫描件）</option>
                <option value="pdf2zh">pdf2zh（需自行安装）</option>
              </select>
            </label>
            <label className="field">
              <span>历史版本保留</span>
              <select
                value={s.mt.keepVersions}
                onChange={(e) => setS({ ...s, mt: { ...s.mt, keepVersions: e.target.value } })}
                data-testid="set-keep-versions"
              >
                <option value="0">不限制</option>
                <option value="1">只保留最新 1 份</option>
                <option value="3">保留最近 3 份</option>
                <option value="5">保留最近 5 份</option>
              </select>
            </label>
            <label className="field">
              <span>术语表</span>
              <textarea
                rows={4}
                style={{ width: '100%', resize: 'vertical' }}
                placeholder={'每行一条，英文=中文，例如：\ncombinatorial optimization=组合优化\nalgorithm construction=算法构建'}
                value={s.mt.glossary}
                onChange={(e) => setS({ ...s, mt: { ...s.mt, glossary: e.target.value } })}
                data-testid="set-glossary"
              />
            </label>
            <label className="field" style={{ gridTemplateColumns: '1fr' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={s.mt.autoGlossary !== '0'}
                  onChange={(e) =>
                    setS({ ...s, mt: { ...s.mt, autoGlossary: e.target.checked ? '1' : '0' } })
                  }
                  data-testid="set-auto-glossary"
                />
                自动抽取术语表（每篇论文多一次短请求，结果缓存）
              </span>
            </label>
            <label className="field" style={{ gridTemplateColumns: '1fr' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={s.mt.thinking === '0'}
                  onChange={(e) =>
                    setS({ ...s, mt: { ...s.mt, thinking: e.target.checked ? '0' : '1' } })
                  }
                  data-testid="set-no-think"
                />
                翻译时关闭模型思考（更快；服务端不支持该参数时自动忽略）
              </span>
            </label>
            </section>

            <section className="settings-card" hidden={activeSection !== 'data'}>
            <h4>译文产物</h4>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => void scanOrphans()} data-testid="scan-orphans">
                <Icon name="search" size={13} />
                扫描孤儿文件
              </button>
              {orphans && orphans.list.length > 0 && (
                <>
                  <button onClick={() => revealOrphans()} data-testid="orphans-dir">
                    <Icon name="folder" size={13} />
                    打开目录
                  </button>
                  <button onClick={() => void cleanOrphans()} data-testid="clean-orphans">
                    <Icon name="close" size={13} />
                    清理（{orphans.list.length}）
                  </button>
                  <button onClick={() => void exportOrphans()} data-testid="export-orphans">
                    <Icon name="upload" size={13} />
                    导出清单
                  </button>
                </>
              )}
              <span className="modal__hint" style={{ margin: 0 }}>
                {orphanStatus}
              </span>
            </div>
            {orphans && orphans.list.length > 0 && (
              <ul className="qa-list" data-testid="orphan-list">
                {orphans.list.slice(0, 12).map((o) => (
                  <li key={o.name}>
                    <span className="meta__muted">
                      {(o.bytes / 1024).toFixed(1)} KB　{o.name}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            </section>

            <section className="settings-card" hidden={activeSection !== 'data'}>
            <h4>数据安全</h4>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => void backupData()} data-testid="data-backup">
                <Icon name="upload" size={13} />
                备份数据库
              </button>
              <button onClick={() => void restoreData()} data-testid="data-restore">
                <Icon name="refresh" size={13} />
                从备份恢复
              </button>
              <span className="modal__hint" style={{ margin: 0 }}>
                {dataStatus}
              </span>
            </div>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="modal__hint" style={{ margin: 0 }} data-testid="test-fault-status">
                测试故障注入：
                {testFaultFailed ? '读取失败' : testFault ? (testFault.fault ?? '未启用') : '读取中…'}
              </span>
              <span className="modal__hint" style={{ margin: 0 }}>
                仅隔离测试副本生效，正式版恒为未启用
              </span>
            </div>
            </section>

            <section className="settings-card" hidden={activeSection !== 'data'}>
            <h4>Zotero 连接器</h4>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label className="skill__skip">
                <input
                  type="checkbox"
                  data-testid="connector-enabled"
                  checked={!!connector?.enabled}
                  onChange={(e) => void toggleConnector(e.target.checked)}
                />
                启用本地接收端
              </label>
              <span className="modal__hint" style={{ margin: 0 }}>
                {connector ? (connector.running ? '运行中' : '未运行') : '读取中…'}
              </span>
            </div>
            {connector && (
              <>
                <label className="field">
                  <span>接收地址</span>
                  <input readOnly value={connector.url} data-testid="connector-url" />
                </label>
                <label className="field">
                  <span>令牌</span>
                  <input readOnly value={connector.token} data-testid="connector-token" />
                </label>
                <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => void copyConnector()} data-testid="connector-copy">
                    <Icon name="file" size={13} />
                    复制地址与令牌
                  </button>
                </div>
              </>
            )}
            <p className="modal__hint">
              浏览器扩展/书签向 <code>POST {connector?.url ?? 'http://127.0.0.1:23124'}/import</code>{' '}
              发送 <code>{'{ "url": "<PDF 链接或 DOI>" }'}</code>，并带 <code>x-paperdesk-token</code> 头。
            </p>
            </section>

            <section className="settings-card" hidden={activeSection !== 'skills'}>
            <h4>翻译技能（按内容类型，可编辑）</h4>
            <p className="modal__hint">
              每种内容类型对应一个 prompt 文件，保存在 <code>data/skills/translate/*.json</code>，
              改完下次翻译即生效。可用变量：<code>{'{lang}'}</code> 目标语言、{' '}
              <code>{'{title}'}</code> 论文标题、<code>{'{authors}'}</code> 作者、{' '}
              <code>{'{section}'}</code> 当前章节。公式 / 参考文献 / 页眉页脚默认「跳过翻译」。
            </p>
            {skills.map((sk) => (
              <div key={sk.id} className="skill__item">
                <div className="skill__head">
                  <div className="skill__title">
                    <b>{sk.label}</b>
                    <span className="meta__muted">v{sk.version ?? 1}</span>
                  </div>
                  <span className="skill__match">{sk.match}</span>
                  <label className="skill__skip">
                    <input
                      type="checkbox"
                      checked={!!skillSkip[sk.id]}
                      onChange={(e) =>
                        setSkillSkip({ ...skillSkip, [sk.id]: e.target.checked })
                      }
                    />
                    跳过翻译
                  </label>
                  <select
                    value={skillScope[sk.id] ?? 'all'}
                    title="适用范围"
                    data-testid={`skill-scope-${sk.id}`}
                    onChange={(e) => setSkillScope({ ...skillScope, [sk.id]: e.target.value })}
                  >
                    <option value="all">全文</option>
                    <option value="first">仅首页</option>
                    <option value="rest">第 2 页起</option>
                  </select>
                  <span className="toolbar__spacer" />
                  <button
                    onClick={() =>
                      setSkillPreview({ ...skillPreview, [sk.id]: !skillPreview[sk.id] })
                    }
                  >
                    <Icon name="search" size={13} />
                    预览
                  </button>
                  <button onClick={() => void saveSkill(sk.id)} data-testid={`skill-save-${sk.id}`}>
                    <Icon name="check" size={13} />
                    {saving ? '保存中…' : '保存设置'}
                  </button>
                </div>
                <textarea
                  rows={3}
                  value={skillDraft[sk.id] ?? ''}
                  data-testid={`skill-system-${sk.id}`}
                  onChange={(e) => setSkillDraft({ ...skillDraft, [sk.id]: e.target.value })}
                />
                {skillPreview[sk.id] && (
                  <pre className="skill__preview">
                    {(skillDraft[sk.id] ?? '')
                      .replaceAll('{lang}', '中文')
                      .replaceAll('{title}', '〈论文标题〉')
                      .replaceAll('{authors}', '〈作者〉')}
                  </pre>
                )}
              </div>
            ))}
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                onClick={() => void applyBodyOnlyPreset()}
                data-testid="skills-preset-body-only"
                title="只翻译正文；标题、题注、公式、参考文献、页眉页脚保持原样（版式改动最小）"
              >
                <Icon name="translate" size={13} />
                仅翻译正文
              </button>
              <button onClick={() => void resetSkills()} data-testid="skills-reset">
                <Icon name="refresh" size={13} />
                恢复默认技能
              </button>
              <button onClick={() => void exportSkills()} data-testid="skills-export">
                <Icon name="upload" size={13} />
                导出技能
              </button>
              <button onClick={() => void importSkills()} data-testid="skills-import">
                <Icon name="file" size={13} />
                导入技能
              </button>
              {skillConflicts.length > 0 && (
                <button onClick={() => void forceImport()} data-testid="skills-force-import">
                  <Icon name="upload" size={13} />
                  全部覆盖（{skillConflicts.length}）
                </button>
              )}
              <span className="modal__hint" style={{ margin: 0 }}>
                {skillStatus}
              </span>
            </div>
            {skillDiff && (
              <div className="skilldiff" data-testid="skills-diff">
                <div className="modal__hint" style={{ marginTop: 4 }}>
                  将应用以下变更（勾选后点「应用所选」）：
                </div>
                <ul>
                  {skillDiff.map((d) => (
                    <li key={d.match}>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!skillSel[d.match]}
                          onChange={(e) =>
                            setSkillSel((prev) => ({ ...prev, [d.match]: e.target.checked }))
                          }
                        />
                        <b>{d.match}</b>
                        <span className="meta__muted">
                          {d.isNew
                            ? '（新增）'
                            : d.dir === 'up'
                              ? '（升级）'
                              : d.dir === 'down'
                                ? '（本地更新，导入为降级）'
                                : ''}
                          {d.changes.length ? ' 变更：' + d.changes.join('、') : ' 无变化'}
                        </span>
                      </label>
                      {d.prev && d.changes.includes('system') && (
                        <CharDiff before={d.prev.system} after={d.next.system} />
                      )}
                      {d.prev && d.changes.includes('skip') && (
                        <div className="chardiff">
                          <div className="chardiff__row">
                            <span className="chardiff__sign">·</span>
                            <span>
                              跳过翻译：{d.prev.skip ? '是' : '否'} → {d.next.skip ? '是' : '否'}
                            </span>
                          </div>
                        </div>
                      )}
                      {d.prev && d.changes.includes('scope') && (
                        <div className="chardiff">
                          <div className="chardiff__row">
                            <span className="chardiff__sign">·</span>
                            <span>
                              适用范围：{SCOPE_LABEL[d.prev.scope || 'all']} →{' '}
                              {SCOPE_LABEL[d.next.scope || 'all']}
                            </span>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button
                    className="primary"
                    onClick={() => void applyDiff()}
                    data-testid="skills-diff-apply"
                  >
                    应用所选
                  </button>
                  <button
                    onClick={() => {
                      setSkillDiff(null)
                      setSkillSel({})
                    }}
                    data-testid="skills-diff-cancel"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {skillUpdates.length > 0 && (
              <div className="modal__hint" data-testid="skills-updates">
                已升级到更高版本：{skillUpdates.join('、')}
              </div>
            )}
            {skillConflicts.length > 0 && (
              <div className="skillconflict" data-testid="skills-conflicts">
                <div className="modal__hint" style={{ marginTop: 4 }}>
                  以下技能本地版本更高，已保留本地；可逐项采用导入版：
                </div>
                <ul>
                  {skillConflicts.map((m) => (
                    <li key={m}>
                      <b>{m}</b>
                      <button
                        className="link"
                        style={{ marginLeft: 8 }}
                        data-testid={`skills-adopt-${m}`}
                        onClick={() => void forceImport([m])}
                      >
                        采用导入版
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            </section>

            <section className="settings-card" hidden={activeSection !== 'skills'}>
            <h4>论文拆解技能（可多套）</h4>
            <p className="modal__hint">
              每套技能保存在 <code>data/skills/analysis/&lt;名字&gt;.md</code>；改完**下次拆解即生效**
              （面板与批处理共用）。可「另存为」派生新技能（如「综述向」「审稿人视角」），在拆解面板切换。
            </p>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="modal__hint" style={{ margin: 0 }}>
                编辑
              </span>
              <select
                value={analysisSkillName}
                data-testid="analysis-skill-pick"
                onChange={(e) => void loadAnalysisSkill(e.target.value)}
              >
                {analysisSkillList.map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {BUILTIN_SKILL_NAMES.includes(n) ? '（内置）' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => void saveAnalysisSkill()} data-testid="analysis-skill-save">
                <Icon name="check" size={13} />
                保存技能
              </button>
              <button
                onClick={() => void resetAnalysisSkill()}
                data-testid="analysis-skill-reset"
              >
                <Icon name="refresh" size={13} />
                恢复内置内容
              </button>
              <button onClick={() => void copyAnalysisSkill()} data-testid="analysis-skill-copy">
                <Icon name="plus" size={13} />
                另存为…
              </button>
              <input
                className="ai__input"
                style={{ width: 150 }}
                placeholder="新技能名，如 survey"
                value={analysisNewName}
                data-testid="analysis-skill-newname"
                onChange={(e) => setAnalysisNewName(e.target.value)}
              />
              <button
                onClick={() => void deleteAnalysisSkill()}
                disabled={BUILTIN_SKILL_NAMES.includes(analysisSkillName)}
                data-testid="analysis-skill-delete"
              >
                <Icon name="trash" size={13} />
                {confirmDeleteSkill ? '确认删除' : '删除'}
              </button>
              <span className="modal__hint" style={{ margin: 0 }}>
                {analysisStatus}
              </span>
            </div>
            <textarea
              className="analysis__skills"
              rows={12}
              value={analysisSkill}
              data-testid="analysis-skill-text"
              onChange={(e) => setAnalysisSkill(e.target.value)}
            />
            </section>

            <section className="settings-card" hidden={activeSection !== 'ai'}>
            <h4>拆解</h4>
            <p className="modal__hint">
              长文拆解会先<b>并发</b>分段做事实抽取，再合并成一份报告；多篇对比会<b>并发</b>生成每篇卡片。
              并发越高越快，但同时向模型服务发出的请求也越多（1–8，默认 4）。
              <br />
              模型路由：<b>短分段</b>的事实抽取优先用「快速模型」，<b>合并 / 批次对比 / 单篇成稿</b>
              优先用「强模型」；留空表示沿用上方「模型服务」里的对话模型（不改变原有行为）。
            </p>
            <label className="field">
              <span>分段并发</span>
              <input
                data-testid="set-analysis-workers"
                value={s.analysis.workers}
                placeholder="4"
                onChange={(e) =>
                  setS({ ...s, analysis: { ...s.analysis, workers: e.target.value } })
                }
              />
            </label>
            <label className="field">
              <span>卡片并发（多篇对比）</span>
              <input
                data-testid="set-analysis-card-workers"
                value={s.analysis.cardWorkers}
                placeholder="4"
                onChange={(e) =>
                  setS({ ...s, analysis: { ...s.analysis, cardWorkers: e.target.value } })
                }
              />
            </label>
            <label className="field">
              <span>快速模型</span>
              <input
                data-testid="set-analysis-fast-model"
                value={s.analysis.fastModel}
                placeholder="留空 = 用默认模型（如 glm-4.6-flash / deepseek-chat）"
                onChange={(e) =>
                  setS({ ...s, analysis: { ...s.analysis, fastModel: e.target.value } })
                }
              />
            </label>
            <label className="field">
              <span>强模型</span>
              <input
                data-testid="set-analysis-strong-model"
                value={s.analysis.strongModel}
                placeholder="留空 = 用默认模型（如 glm-4.6 / deepseek-reasoner）"
                onChange={(e) =>
                  setS({ ...s, analysis: { ...s.analysis, strongModel: e.target.value } })
                }
              />
            </label>
            </section>

            <section className="settings-card" hidden={activeSection !== 'search'}>
            <h4
              id="settings-embed"
              data-testid="settings-section-embed"
              ref={embedSectionRef}
              className={
                initialSection === 'embed' ? 'modal__section-title modal__section-title--target' : undefined
              }
            >
              语义检索
            </h4>
            <p className="modal__hint">
              语义检索需要把全文分块转成向量。默认使用<b>本地向量</b>（离线哈希向量，无需联网、不会报错）；
              若你的模型服务提供 <code>/embeddings</code> 接口，可切换为「模型服务」获得更好的语义效果。
              Anthropic 不提供此接口，选择 Anthropic 时自动使用本地向量。
            </p>
            <label className="field">
              <span>向量服务</span>
              <select
                data-testid="set-embed-mode"
                value={s.embed.mode}
                onChange={(e) => setS({ ...s, embed: { ...s.embed, mode: e.target.value } })}
              >
                <option value="local">本地（离线哈希向量，默认）</option>
                <option value="provider" disabled={s.provider.protocol === 'anthropic'}>OpenAI 模型服务（/embeddings）</option>
                <option value="off">关闭（仅词法检索）</option>
              </select>
            </label>
            <label className="field">
              <span>启用</span>
              <select
                data-testid="set-embed-enabled"
                value={s.embed.enabled}
                onChange={(e) => setS({ ...s, embed: { ...s.embed, enabled: e.target.value } })}
              >
                <option value="1">开启（混合检索：词法 + 向量）</option>
                <option value="0">关闭（仅词法检索）</option>
              </select>
            </label>
            </section>

            <section className="settings-card" hidden={activeSection !== 'search'}>
            <h4>知识库</h4>
            <p className="modal__hint" data-testid="set-knowledge-status">
              <span
                style={{
                  display: 'inline-block',
                  marginRight: 6,
                  padding: '0 6px',
                  borderRadius: 4,
                  background: knowledge?.enabled ? 'rgba(18, 161, 80, 0.16)' : 'rgba(128, 128, 128, 0.18)',
                  fontSize: 12,
                  verticalAlign: 'middle'
                }}
              >
                {knowledge?.enabled ? '已启用' : '待启用'}
              </span>
              AI 只能提交提案：你在暂存区逐条审核、接受或改写后，显式发布才会写入正式条目；未审核内容不会进入检索与知识地图。
            </p>
            <p className="modal__hint" data-testid="set-knowledge-root">
              数据目录：<code>{knowledge ? knowledge.root : '读取中…'}</code>
            </p>
            {onOpenKnowledge && (
              <label className="field">
                <span>知识库</span>
                <button
                  className="ghost"
                  data-testid="knowledge-open-settings"
                  onClick={onOpenKnowledge}
                >
                  打开知识库…
                </button>
              </label>
            )}
            {onOpenStaging && (
              <label className="field">
                <span>待审提案</span>
                <button className="ghost" data-testid="set-open-staging" onClick={onOpenStaging}>
                  打开暂存区…
                </button>
              </label>
            )}
            </section>

            <section className="settings-card" hidden={activeSection !== 'ai'}>
            <h4>批处理</h4>
            <p className="modal__hint">
              许多模型（如 DeepSeek）分波峰/波谷定价。开启「仅低峰执行」后，需要调用模型的批处理作业会排队到低峰时段再跑。
            </p>
            <label className="field">
              <span>并发数</span>
              <input
                data-testid="set-batch-concurrency"
                value={s.batch.concurrency}
                placeholder="1"
                onChange={(e) => setS({ ...s, batch: { ...s.batch, concurrency: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>仅低峰执行</span>
              <select
                data-testid="set-batch-offpeak"
                value={s.batch.offPeakOnly}
                onChange={(e) => setS({ ...s, batch: { ...s.batch, offPeakOnly: e.target.value } })}
              >
                <option value="0">否（随时执行）</option>
                <option value="1">是（排队到低峰）</option>
              </select>
            </label>
            <label className="field">
              <span>低峰时段（起–止）</span>
              <span style={{ display: 'flex', gap: 8 }}>
                <input
                  data-testid="set-batch-start"
                  value={s.batch.offPeakStart}
                  placeholder="00:30"
                  onChange={(e) => setS({ ...s, batch: { ...s.batch, offPeakStart: e.target.value } })}
                />
                <input
                  data-testid="set-batch-end"
                  value={s.batch.offPeakEnd}
                  placeholder="08:30"
                  onChange={(e) => setS({ ...s, batch: { ...s.batch, offPeakEnd: e.target.value } })}
                />
              </span>
            </label>
            <p className="modal__hint">
              低峰时段之外算高峰；跨零点（如 22:00–06:00）同样支持。
            </p>
            </section>

            <section className="settings-card" hidden={activeSection !== 'search'}>
            <h4>元数据提取</h4>
            <p className="modal__hint">
              参考文献缺 DOI 时用 Crossref 模糊匹配补齐（离线跳过）。
            </p>
            <label className="field">
              <span>Crossref 解析</span>
              <select
                data-testid="set-meta-crossref"
                value={s.metadata.crossref}
                onChange={(e) =>
                  setS({ ...s, metadata: { ...s.metadata, crossref: e.target.value } })
                }
              >
                <option value="1">开启（默认，补齐 DOI）</option>
                <option value="0">关闭（完全离线）</option>
              </select>
            </label>
            <label className="field">
              <span>解析上限</span>
              <input
                data-testid="set-meta-crossref-limit"
                value={s.metadata.crossrefLimit}
                placeholder="12"
                onChange={(e) =>
                  setS({ ...s, metadata: { ...s.metadata, crossrefLimit: e.target.value } })
                }
              />
            </label>
            </section>

            <section className="settings-card" hidden={activeSection !== 'system'}>
            <h4 id="settings-blocks-adapter" data-testid="settings-section-blocks-adapter">
              结构化解析（实验）
            </h4>
            <p className="modal__hint">
              打开后，<b>新解析</b>的文档才会带结构化块标注（阅读页「解析检查」可逐块查看类型、页码与坐标）；
              已有文档需要<b>重新解析</b>才会出现块标注。关闭时不注入任何开关变量，解析产物与旧版一致。
            </p>
            <label className="field">
              <span>启用块标注</span>
              <input
                type="checkbox"
                data-testid="set-blocks-adapter"
                checked={!!s.blocksAdapter}
                style={{ width: 'auto' }}
                onChange={(e) => void toggleBlocksAdapter(e.target.checked)}
              />
            </label>
            <p className="modal__hint" data-testid="set-blocks-adapter-hint">
              切换即保存；开关在下一次启动解析侧车时生效（已运行的侧车需重启应用）。
            </p>
            </section>

            <section className="settings-card" hidden={activeSection !== 'search'}>
            <h4>其他</h4>
            <label className="field">
              <span>OpenAlex 邮箱</span>
              <input
                value={s.openalex.mailto}
                placeholder="进入 polite pool，提高配额"
                onChange={(e) => setS({ ...s, openalex: { ...s.openalex, mailto: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>OpenAlex API Key</span>
              <input
                type="password"
                autoComplete="off"
                value={s.openalex.apiKey}
                placeholder={s.openalex.apiKeySet ? '已设置（留空保留）' : '可选：填写 OpenAlex API Key'}
                onChange={(e) => setS({ ...s, openalex: { ...s.openalex, apiKey: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>Google Scholar（SerpAPI）Key</span>
              <input
                type="password"
                autoComplete="off"
                value={s.scholar.apiKey}
                placeholder={s.scholar.apiKeySet ? '已设置（留空保留）' : '可选：填写 SerpAPI Key'}
                onChange={(e) => setS({ ...s, scholar: { apiKey: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>Semantic Scholar API Key</span>
              <input
                type="password"
                autoComplete="off"
                value={s.semantic.apiKey}
                placeholder={s.semantic.apiKeySet ? '已设置（留空保留）' : '可选：填写 Semantic Scholar Key'}
                onChange={(e) => setS({ ...s, semantic: { apiKey: e.target.value } })}
              />
            </label>
            <label className="field">
              <span>GROBID 地址</span>
              <input
                value={s.grobid.url}
                placeholder="http://127.0.0.1:8070（可选）"
                onChange={(e) => setS({ ...s, grobid: { url: e.target.value } })}
              />
            </label>
            </section>

            <section className="settings-card" hidden={activeSection !== 'search'}>
            <h4>联网检索（AI 问答）</h4>
            <label className="field">
              <span>联网方式</span>
              <select
                data-testid="set-websearch-enabled"
                value={s.websearch.enabled === '1' ? '1' : s.websearch.enabled === 'auto' ? 'auto' : '0'}
                onChange={(e) =>
                  setS({ ...s, websearch: { ...s.websearch, enabled: e.target.value } })
                }
              >
                <option value="0">关闭（默认，不发送任何搜索请求）</option>
                <option value="auto">自动（论文与知识库都没有依据时才搜索网页）</option>
                <option value="1">始终（每轮都搜索网页并引用 [W1]…）</option>
              </select>
            </label>
            <label className="field">
              <span>检索代理</span>
              <input
                data-testid="set-websearch-proxy"
                value={s.websearch.proxy}
                placeholder="留空：先试系统代理，再直连；如 http://127.0.0.1:7993"
                onChange={(e) => setS({ ...s, websearch: { ...s.websearch, proxy: e.target.value } })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                data-testid="set-strict-evidence"
                checked={s.strictEvidence === '1'}
                onChange={(e) =>
                  setS({ ...s, strictEvidence: e.target.checked ? '1' : '0' })
                }
              />
              <span>严格依据文献：只用检索到的论文/知识库/网页回答，没有依据就直说</span>
            </label>
            <div className="modal__hint">
              关闭联网时不发送任何搜索请求；自动/始终模式下失败会在 8 秒内标注「未联网」并说明原因
              （网络不可达 / 需要代理 / HTTP 状态码 / 无结果），可点「检查网络 / 设置代理」重试；
              不会静默变成纯本地回答，也不会把失败当成「检索无结果」。
            </div>
            </section>

            <section className="settings-card" hidden={activeSection !== 'ai'}>
            <h4 id="settings-ai-tools" data-testid="settings-section-ai-tools">
              AI 工具库
            </h4>
            <div className="ai-tools" data-testid="ai-tools-panel">
              <div className="modal__hint">
                按类别查看与授权；关闭后对应入口自动变灰，无需重启。细节见 README。
              </div>
              <div className="ai-tools__bar">
                <div className="ai-tools__tabs">
                  <button
                    className={`ghost${aiToolCategory === 'all' ? ' on' : ''}`}
                    data-testid="ai-tools-category-all"
                    onClick={() => setAiToolCategory('all')}
                  >
                    全部<span className="ai-tools__count">{AI_TOOLS.length}</span>
                  </button>
                  {AI_TOOL_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      className={`ghost${aiToolCategory === cat ? ' on' : ''}`}
                      data-testid={`ai-tools-category-${cat}`}
                      onClick={() => setAiToolCategory(cat)}
                    >
                      {AI_TOOL_CATEGORY_LABELS[cat]}
                      <span className="ai-tools__count">{aiToolCount(cat)}</span>
                    </button>
                  ))}
                </div>
                <input
                  className="ai-tools__search"
                  data-testid="ai-tools-search"
                  value={aiToolQuery}
                  placeholder="搜索名称或说明"
                  onChange={(e) => setAiToolQuery(e.target.value)}
                />
              </div>
              {aiToolWarnings.length > 0 && (
                <div className="modal__hint ai-tools__warning" data-testid="ai-tools-warning">
                  {aiToolWarnings.join('；')}
                </div>
              )}
              {aiToolStatus && (
                <div className="modal__hint" data-testid="ai-tools-status">
                  {aiToolStatus}
                </div>
              )}
              {visibleAiTools.length > 0 && (
                <div className="ai-tools__list">
                  {visibleAiTools.map(({ state, def }) => (
                    <div
                      key={state.id}
                      className={`ai-tools__card${state.enabled ? '' : ' is-off'}`}
                      data-testid={`ai-tool-${state.id}`}
                    >
                      <label className="ai-tools__head">
                        <input
                          type="checkbox"
                          data-testid={`ai-tool-toggle-${state.id}`}
                          checked={state.enabled}
                          onChange={() => toggleAiToolEnabled(state)}
                        />
                        <span className="ai-tools__name">{def.name}</span>
                        <span className="chip">{AI_TOOL_CATEGORY_LABELS[def.category]}</span>
                      </label>
                      <div className="ai-tools__desc">{def.description}</div>
                      <div className="ai-tools__meta">入口：{def.entryHint}</div>
                      <div className="ai-tools__perms">
                        {def.requires.length === 0 ? (
                          <span className="ai-tools__perm">不需要额外能力（纯本地）</span>
                        ) : (
                          def.requires.map((permission) => (
                            <label key={permission} className="ai-tools__perm">
                              <input
                                type="checkbox"
                                data-testid={`ai-tool-perm-${state.id}-${permission}`}
                                checked={state.permissions[permission] !== false}
                                onChange={() => toggleAiToolPermission(state, permission)}
                              />
                              需要「{AI_TOOL_PERMISSION_LABELS[permission]}」
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {visibleAiTools.length === 0 && (
                <div className="ai-tools__empty" data-testid="ai-tools-empty">
                  {aiToolRows.length === 0
                    ? '正在读取 AI 工具清单…'
                    : '没有匹配的 AI 工具（换个关键词，或切回「全部」）'}
                  {aiToolRows.length > 0 && (
                    <button
                      className="ghost"
                      data-testid="ai-tools-clear-filters"
                      onClick={() => {
                        setAiToolCategory('all')
                        setAiToolQuery('')
                      }}
                    >
                      清除筛选
                    </button>
                  )}
                </div>
              )}
              <div className="ai-tools__foot">
                <button className="ghost" data-testid="ai-tools-reset" onClick={() => void resetAiToolLibrary()}>
                  <Icon name="refresh" size={13} />
                  恢复默认（全部启用）
                </button>
              </div>
            </div>
            </section>

            <section className="settings-card" hidden={activeSection !== 'system'}>
            <h4>服务自检</h4>
            <div className="panel__row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button disabled={checking} onClick={() => void check()} data-testid="set-health">
                <Icon name="refresh" size={14} />
                {checking ? '检测中…' : '检测解析服务'}
              </button>
            </div>
            {health && (
              <div className="modal__hint" data-testid="set-health-result" style={{ marginTop: 8 }}>
                解析服务（Python）：{health.python.ok ? '✅ 正常' : `❌ 不可用 — ${health.python.error ?? '未知错误'}`}
                <br />
                可选引擎：MinerU {health.python.mineru ? '✅' : '—'} · pdf2zh {health.python.pdf2zh ? '✅' : '—'}
                <br />
                模型服务：{health.provider.configured ? `✅ 已配置（${health.provider.chatModel || '未填模型'}）` : '— 未配置，当前为离线占位'}
              </div>
            )}
            </section>

            <section className="settings-card" hidden={activeSection !== 'system'}>
            <h4>外观</h4>
            <label className="field">
              <span>主题</span>
              <select
                data-testid="set-theme"
                value={s.ui.theme}
                onChange={(e) => {
                  const theme = e.target.value
                  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
                  onThemeChange?.(theme)
                  setS({ ...s, ui: { theme } })
                }}
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            </section>
          </div>
        )}

        </div>
        <div className="modal__foot settings-footer">
          <button
            disabled={!s}
            onClick={() => void exportSettings()}
            data-testid="settings-export"
          >
            <Icon name="upload" size={13} />
            导出设置
          </button>
          <button disabled={!s} onClick={() => void importSettings()} data-testid="settings-import">
            <Icon name="file" size={13} />
            导入设置
          </button>
          <span className="notes__status">{status}</span>
          <span className="toolbar__spacer" />
          <button className="primary" disabled={!s || saving} onClick={() => void save()} data-testid="set-save">
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  )
}
