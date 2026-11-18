/**
 * 渲染进程「右侧面板」模块注册表。
 *
 * 新增一个面板只需：
 *   1. 写一个组件（接收 PanelContext 里的字段）
 *   2. 在下面 PANELS 里加一行
 * 标签按钮与渲染都由 App 从这里自动生成。
 *
 * 详见 docs/EXTENDING.md。
 */
import { lazy, type ReactNode } from 'react'
import type { AskSelection, AskTask, Citation, PartialText } from '@shared/types'
import type { GraphNodeKind } from '@shared/types'
import type { TranslationTarget } from '@shared/types'
const NotesPanel = lazy(() => import('../features/notes/NotesPanel').then((m) => ({ default: m.NotesPanel })))
const DiscoveryPanel = lazy(() => import('../features/discovery/DiscoveryPanel').then((m) => ({ default: m.DiscoveryPanel })))
const AiPanel = lazy(() => import('../features/ai/AiPanel').then((m) => ({ default: m.AiPanel })))
const BatchPanel = lazy(() => import('../features/batch/BatchPanel').then((m) => ({ default: m.BatchPanel })))
const TranslationPanel = lazy(() => import('../features/translate/TranslationPanel').then((m) => ({ default: m.TranslationPanel })))
const GlossaryPanel = lazy(() => import('../features/translate/GlossaryPanel').then((m) => ({ default: m.GlossaryPanel })))
const JournalsPanel = lazy(() => import('../features/journals/JournalsPanel').then((m) => ({ default: m.JournalsPanel })))
const WorksPanel = lazy(() => import('../features/works/WorksPanel').then((m) => ({ default: m.WorksPanel })))
const PaperAnalysisPanel = lazy(() => import('../features/analysis/PaperAnalysisPanel').then((m) => ({ default: m.PaperAnalysisPanel })))
const SurveyPanel = lazy(() => import('../features/survey/SurveyPanel').then((m) => ({ default: m.SurveyPanel })))
const FsPanel = lazy(() => import('../features/files/FsPanel').then((m) => ({ default: m.FsPanel })))
const AuthorsPanel = lazy(() => import('../features/authors/AuthorsPanel').then((m) => ({ default: m.AuthorsPanel })))
import type { ViewMode } from '../features/translate/TranslationPanel'
import type { Translation } from '@shared/types'

export interface OpenTarget {
  itemId: number | null
  attachmentId: number | null
  page: number | null
  /** 结构化模块矩形（底边原点）：有则在跳页后高亮该区域 */
  rect?: [number, number, number, number] | null
}

export interface PanelContext {
  itemId: number | null
  attachmentId: number | null
  /** 文库条目列表（供「拆解论文」等面板做批次选择） */
  items: import('@shared/types').Item[]
  notesRefresh: number
  /** 该面板当前是否为激活标签（用于需要感知可见性的组件，如 cytoscape 重算尺寸） */
  active: boolean
  /** 当前主题（light / dark），供需要自行绘制的内容（如图谱）适配 */
  theme: string
  onDeepLink: (url: string) => void
  onOpenTarget: (t: OpenTarget) => void
  /** 切换到指定右侧面板（如文件面板点击 .md 跳到「笔记」） */
  onOpenPanel: (id: string) => void
  /** 打开某条目的笔记（批处理拆解报告归档后跳转） */
  onOpenNotes: (itemId: number) => void
  /** 打开某个译文（文件面板点击译文产物 → 切到「译文」视图） */
  onOpenTranslation: (t: TranslationTarget, mode: ViewMode) => void
  onLibraryChanged: () => void
  /** 笔记内容变化（如把译文归档进笔记）→ 刷新笔记面板 */
  onNotesChanged: () => void
  /** 翻译状态与操作 */
  translation: Translation | null
  viewMode: ViewMode
  translating: boolean
  translateProgress: string
  /** 0–1 的真实进度（有则用确定型进度条） */
  translateRatio?: number
  onRunTranslate: (
    lang: string,
    mode: 'fine' | 'coarse',
    engine?: string,
    force?: boolean,
    layout?: 'reflow' | 'strict',
    /** 译文正文字号增量（pt）：不传则用设置里的 mt.fontDelta */
    fontDelta?: number
  ) => void | Promise<void>
  onCancelTranslate: () => void | Promise<void>
  onSetViewMode: (mode: ViewMode) => void
  /** 部分翻译（划词/本页）：需用户在面板里确认后才翻译 */
  partial: PartialText | null
  onClearPartial: () => void
  /** 划词后直接向 AI 提问/名词解释/翻译（带选区上下文：原文/附件/页码） */
  aiRequest: { text: string; task: AskTask; selection?: AskSelection | null } | null
  onAskSelection: (text: string, task: 'qa' | 'term', page?: number) => void
  onClearAiRequest: () => void
  /** 「加入批处理」中转：某功能声明的批处理任务 id（打开批处理面板时预选） */
  pendingBatchTask: string | null
  onConsumePendingBatchTask: () => void
  /** 把某功能加入批处理（打开批处理面板并预选该任务）——由各面板的按钮调用 */
  onAddToBatch: (taskId: string) => void
  /** 从「文献检索」跳转：要求相关论文面板按某类别过滤（如仅看施引文献） */
  pendingDiscoveryFilter: GraphNodeKind | null
  onConsumePendingDiscoveryFilter: () => void
  /** 「按引用展开」：切到该条目并打开相关论文，仅看施引文献 */
  onExpandCitations: (itemId: number, filter: GraphNodeKind) => void
  /** 划词「文件检索」：打开「文献检索」面板并以该词检索 */
  onSearchWorks: (query: string) => void
  /** 「文献检索」待消费的检索词（由 onSearchWorks 设置） */
  pendingWorksQuery: string | null
  onConsumePendingWorksQuery: () => void
  /** 打开「设置」对话框（如 LaTeX 未配置模型时的直达入口） */
  onOpenSettings: () => void
  /** 左栏当前分组筛选对应的分组路径（全部/未分组为 null）：供 AI 面板做「分组级问答」 */
  groupName: string | null
  /** 分组叶名（用于作用域文案，如「分组「扩散模型」· 12 篇」） */
  groupLabel: string
}

export interface PanelModule {
  id: string
  title: string
  /** Icon 组件里的图标名 */
  icon: string
  /** 所属分组（Office 式功能区的第一层） */
  group: string
  render: (ctx: PanelContext) => ReactNode
  /**
   * 该功能对应的**批处理任务 id**（可选）。
   * 声明后：顶栏会出现通用的「加入批处理」入口（打开批处理并预选该任务），
   * 无需在别处新增条件判断——这就是「声明一次即可接入菜单与批处理」。
   */
  batchTaskId?: string
}

/** 功能区分组（第一层）：把不相关的功能分开，便于查找 */
export const PANEL_GROUPS: Array<{ id: string; title: string }> = [
  { id: 'read', title: '阅读' },
  { id: 'research', title: '研究' },
  { id: 'data', title: '数据' }
]

export const PANELS: PanelModule[] = [
  {
    id: 'notes',
    title: '笔记',
    icon: 'notes',
    group: 'read',
    render: (c) => (
      <NotesPanel itemId={c.itemId} refreshSignal={c.notesRefresh} onDeepLink={c.onDeepLink} />
    )
  },
  {
    id: 'discovery',
    title: '相关论文',
    icon: 'graph',
    group: 'research',
    batchTaskId: 'find-related',
    render: (c) => (
      <DiscoveryPanel
        mode="related"
        itemId={c.itemId}
        active={c.active}
        theme={c.theme}
        onLibraryChanged={c.onLibraryChanged}
        pendingFilter={c.pendingDiscoveryFilter}
        onConsumePendingFilter={c.onConsumePendingDiscoveryFilter}
      />
    )
  },
  {
    id: 'topic',
    title: '研究方向',
    icon: 'search',
    group: 'research',
    render: (c) => (
      <DiscoveryPanel
        mode="topic"
        itemId={c.itemId}
        active={c.active}
        theme={c.theme}
        onLibraryChanged={c.onLibraryChanged}
      />
    )
  },
  {
    id: 'ai',
    title: '问答',
    icon: 'sparkles',
    group: 'read',
    render: (c) => (
      <AiPanel
        request={c.aiRequest}
        onClearRequest={c.onClearAiRequest}
        attachmentId={c.attachmentId}
        itemId={c.itemId}
        items={c.items}
        onOpenTarget={c.onOpenTarget}
        onOpenCitation={(cit: Citation) =>
          c.onOpenTarget({
            itemId: cit.itemId,
            attachmentId: cit.attachmentId,
            page: cit.page,
            rect: cit.rect ?? null
          })
        }
        onOpenSettings={c.onOpenSettings}
        groupName={c.groupName}
        groupLabel={c.groupLabel}
      />
    )
  },
  {
    id: 'glossary',
    title: '词汇库',
    icon: 'book',
    group: 'read',
    render: (c) => <GlossaryPanel key={c.attachmentId} attachmentId={c.attachmentId} />
  },
  {
    id: 'translate',
    title: '翻译',
    icon: 'translate',
    group: 'read',
    batchTaskId: 'translate',
    render: (c) => (
      <TranslationPanel
        itemId={c.itemId}
        attachmentId={c.attachmentId}
        translation={c.translation}
        viewMode={c.viewMode}
        translating={c.translating}
        progress={c.translateProgress}
        progressRatio={c.translateRatio}
        onRunTranslate={c.onRunTranslate}
        onCancelTranslate={c.onCancelTranslate}
        onSetViewMode={c.onSetViewMode}
        partial={c.partial}
        onClearPartial={c.onClearPartial}
        onNotesChanged={c.onNotesChanged}
        onOpenTarget={c.onOpenTarget}
        onOpenTranslation={c.onOpenTranslation}
        onAddToBatch={c.onAddToBatch}
      />
    )
  },
  {
    id: 'authors',
    title: '作者',
    icon: 'info',
    group: 'research',
    render: (c) => <AuthorsPanel itemId={c.itemId} />
  },
  {
    id: 'files',
    title: '文件',
    icon: 'folder',
    group: 'data',
    render: (c) => (
      <FsPanel
        active={c.active}
        onOpenTarget={c.onOpenTarget}
        onOpenPanel={c.onOpenPanel}
        onOpenTranslation={c.onOpenTranslation}
      />
    )
  },
  {
    id: 'batch',
    title: '批处理',
    icon: 'layers',
    group: 'data',
    render: (c) => (
      <BatchPanel
        itemId={c.itemId}
        attachmentId={c.attachmentId}
        active={c.active}
        onLibraryChanged={c.onLibraryChanged}
        pendingBatchTask={c.pendingBatchTask}
        onConsumePendingBatchTask={c.onConsumePendingBatchTask}
        onOpenNotes={c.onOpenNotes}
      />
    )
  },
  {
    id: 'journals',
    title: '期刊',
    icon: 'book',
    group: 'research',
    render: (c) => <JournalsPanel itemId={c.itemId} />
  },
  {
    id: 'works',
    title: '文献检索',
    icon: 'search',
    group: 'research',
    render: (c) => (
      <WorksPanel
        itemId={c.itemId}
        onLibraryChanged={c.onLibraryChanged}
        onOpenTarget={c.onOpenTarget}
        onOpenPanel={c.onOpenPanel}
        onExpandCitations={c.onExpandCitations}
        pendingQuery={c.pendingWorksQuery}
        onConsumePendingQuery={c.onConsumePendingWorksQuery}
      />
    )
  },
  {
    id: 'analysis',
    title: '拆解论文',
    icon: 'list',
    group: 'read',
    batchTaskId: 'analyze-paper',
    render: (c) => (
      <PaperAnalysisPanel
        itemId={c.itemId}
        attachmentId={c.attachmentId}
        items={c.items}
        onNotesChanged={c.onNotesChanged}
        onDeepLink={c.onDeepLink}
        onAddToBatch={c.onAddToBatch}
      />
    )
  },
  {
    id: 'survey',
    title: '领域调研',
    icon: 'search',
    group: 'research',
    render: (c) => (
      <SurveyPanel itemId={c.itemId} items={c.items} onLibraryChanged={c.onLibraryChanged} />
    )
  }
]
