// 主/渲染共享的数据类型（对齐 SQLite 表结构）
import type { MindmapScopeNodeRef } from './mindmap-scope'

export interface Item {
  id: number
  key: string
  doi: string | null
  title: string | null
  abstract: string | null
  year: number | null
  venue: string | null
  type: string | null
  language: string | null
  /** 领域（导入/识别元数据时由 AI 标注，如「自然语言处理」），未知为 null */
  domain: string | null
  /** 父条目（相关论文/AI 建议加入文库时归入其「空间」），顶层为 null */
  parent_id: number | null
  /** 该条目「空间」目录（相对 data/，如 spaces/<key>），便于文件面板与预览 */
  space_path: string | null
  /** 文库分组（用户自建标签，NULL = 未分组） */
  group_name?: string | null
  /** 手动标签（与分组正交；用于跨分组筛选与批处理范围） */
  tags?: string[]
  date_added: string
  date_modified: string
}

/** 文库分组（去重 + 条目计数），用于左侧栏分组栏与详情面板 */
export interface LibraryGroup {
  name: string
  count: number
  /** 父分组完整路径；null = 顶层分组。旧库只有 group_name 时由前端按路径推断。 */
  parent_name?: string | null
  /** 分组介绍（纯文本，可空） */
  description?: string | null
  /** 最近一次分组信息/成员变更时间 */
  date_modified?: string | null
  /** 同层手动顺序（1 起）；null/undefined = 未手动排序，按名称兜底 */
  sort_order?: number | null
}

/** 文库手动标签（kind=manual）；领域/关键词标签仍走同一张表但 kind=keyword */
export interface LibraryTag {
  id: number
  name: string
  kind: string
  count: number
}

export interface Attachment {
  id: number
  key: string
  item_id: number | null
  path: string
  filename: string | null
  content_type: string | null
  size: number | null
  page_count: number | null
}

export interface ImportPdfResult {
  item: Item
  attachment: Attachment
  /** 同一 PDF 已在文库中（按 SHA-256 命中），未重复复制文件 */
  duplicate?: boolean
}

/** 多选 PDF 导入结果：一次文件对话框可同时导入多篇 */
export interface ImportPdfBatchResult {
  canceled: boolean
  items: ImportPdfResult[]
  message: string
}

export type AnnotationType = 'highlight' | 'underline' | 'note'

/** 批注：坐标存 PDF 用户空间点（与缩放/DPR 无关） */
export interface Annotation {
  id: number
  key: string
  attachment_id: number
  type: string
  text: string | null
  prefix: string | null
  suffix: string | null
  comment: string | null
  color: string | null
  page_index: number
  /** JSON: { pageIndex, rects: [[x1,y1,x2,y2], ...] } */
  position: string
  sort_index: string | null
  date_added: string
  date_modified: string
}

export interface NewAnnotation {
  attachmentId: number
  type: AnnotationType
  pageIndex: number
  rects: [number, number, number, number][]
  color?: string | null
  text?: string | null
  prefix?: string | null
  suffix?: string | null
  comment?: string | null
}

export interface AnnotationPosition {
  pageIndex: number
  rects: [number, number, number, number][]
}

/** 笔记：元数据在库里，正文在 data/notes/<key>.md */
export interface Note {
  id: number
  key: string
  item_id: number | null
  title: string | null
  md_path: string | null
  date_added: string
  date_modified: string
}

export interface NoteWithContent {
  note: Note
  content: string
}

/**
 * 思维地图节点锚点（PD55）：指回原文某个 chunk 内的字符区间。
 * quoteStart/quoteEnd 是「含首尾」的 UTF-16 下标，原文 = chunk.text.slice(quoteStart, quoteEnd + 1)；
 * rect 来自 chunks.bbox（没有时为 null），moduleId 来自 chunks.module_id。
 */
export interface MindmapAnchor {
  page: number
  quoteStart: number
  quoteEnd: number
  rect: [number, number, number, number] | null
  moduleId: string | null
}

/** 骨架生成方式：AI 严格 JSON 树，或规则骨架（标题层级 + 要点分组） */
export type MindmapSkeletonMode = 'ai' | 'rule'

/**
 * 同步节点的来源凭据（PD55 覆盖式同步）：
 * source='sync' 的节点可被下一次同步覆盖；用户改名/拖动后标记 userEdited，永不删除。
 */
export interface MindMapNodeProvenance {
  source: 'sync'
  /** 本次拆解内容指纹（sha256），同一内容重复同步据此幂等 */
  syncId?: string
  /** 批处理批次标识（单篇同步为 null） */
  batchId?: string | null
  /** 节点文本指纹，用于识别「用户改过名」 */
  contentHash?: string
  /** 写入时的原始文本/坐标，和当前值不同即视为用户编辑 */
  originText?: string
  originX?: number
  originY?: number
  userEdited?: boolean
  /** 从根到该节点的主题路径（供调试/再生成使用） */
  topicPath?: string[]
}

/** 地图上最后一次同步的水位标记（老文件没有该字段，视为从未同步） */
export interface MindMapSyncState {
  syncId: string
  batchId?: string | null
  mode?: MindmapSkeletonMode
  nodeIds: string[]
  updatedAt?: string
}

/** 思维地图节点：树结构由 parentId 表达；x/y 是面板画布内的左上角坐标（px） */
export interface MindMapNode {
  id: string
  parentId: string | null
  text: string
  x: number
  y: number
  /**
   * 节点来源标记：'ai-generated' 表示由「AI 展开子节点」写入，
   * 'digest' 表示由「论文拆解结果同步」写入。
   * 仅作为可撤销/角标的依据，随整份 JSON 一起落盘（不新增数据库表）。
   */
  source?: MindMapSource
  /**
   * 聚合地图（全部/分组/单篇范围）中指回源范围的标记；
   * 单篇地图与既有 JSON 不带该字段，保持向后兼容。
   */
  ref?: MindmapScopeNodeRef
  /** PD55：覆盖式同步的来源凭据；无该字段的老节点一律视为用户节点 */
  provenance?: MindMapNodeProvenance
  /** PD55：节点对应的原文点锚点（找支撑后保存，可再次定位到同一处） */
  anchor?: MindmapAnchor
}

/** 思维地图节点来源（手工/大纲导入的节点不带该字段） */
export type MindMapSource = 'ai-generated' | 'digest'

/** 单篇文献的思维地图（按 items.key 存 data/mindmap/<key>.json，不进数据库） */
export interface MindMapDoc {
  version: 1
  itemId: number
  rootId: string
  nodes: MindMapNode[]
  updatedAt: string
  /** PD55：最后一次覆盖式同步的水位（老文件没有该字段仍可正常读取） */
  sync?: MindMapSyncState
}

/** 单篇「拆解 → 思维地图」覆盖式同步入参（PD55） */
export interface MindmapSyncInput {
  itemId: number
  markdown: string
  title?: string | null
  /** 批处理批次标识；单篇同步省略或 null */
  batchId?: string | null
}

/** 覆盖式同步结果：新增 / 删除 / 保留（用户改过的节点）与骨架来源 */
export interface MindmapSyncResult {
  itemId: number
  points: number
  added: number
  removed: number
  kept: number
  mode: MindmapSkeletonMode
  syncId: string
  warnings: string[]
}

/** 深链解析结果（paperdesk://open?attachment=..&page=..&annotation=..） */
export interface DeepLinkTarget {
  attachmentKey: string
  page: number
  annotationKey: string | null
}

/** ===== M3 元数据 / 引用 ===== */
export interface AuthorRef {
  id: number
  name: string
  orcid: string | null
}

export interface ReferenceView {
  id: number
  refIndex: number | null
  raw: string | null
  resolved: boolean
  doi: string | null
  title: string | null
}

export interface MetadataView {
  item: Item | null
  authors: AuthorRef[]
  references: ReferenceView[]
}

export interface ExtractSummary {
  itemId: number | null
  pageCount: number
  source: string
  authorCount: number
  referenceCount: number
  resolvedCount: number
  warnings: string[]
}

/** 部分翻译的来源：划词选中 / 当前页 */
export interface PartialText {
  text: string
  kind: 'selection' | 'page'
  /** 划词「翻译选中」：期望打开面板后立即翻译（不必再点一次） */
  auto?: boolean
  /** 选区来源页码（1 起，可空）：用于在翻译面板标注「p.N 选区」 */
  page?: number | null
}

/** ===== 结构提取：公式 / 定理 ===== */
export interface EquationItem {
  page: number
  text: string
  number: string | null
}

export interface TheoremItem {
  page: number
  kind: string
  number: string | null
  statement: string
}

export interface StructureResult {
  pageCount: number
  equations: EquationItem[]
  theorems: TheoremItem[]
  counts: { equations: number; theorems: number }
  warnings: string[]
}

/** ===== M4 相关论文 / 引文图谱 ===== */
export type GraphNodeKind = 'seed' | 'reference' | 'citation' | 'related' | 'ai' | 'library'

/** 相关论文数据源：自动 / OpenAlex(含 Crossref 回退) / AI 辅助 */
export type DiscoverySource = 'auto-ai' | 'auto' | 'openalex' | 'ai' | 'topic'

export interface GraphNode {
  id: string
  doi: string | null
  title: string | null
  year: number | null
  venue: string | null
  citedBy: number
  kind: GraphNodeKind
}

/** 文献检索来源（用于标注「这条结果来自哪里」） */
export type WorkSource = 'openalex' | 'crossref' | 'google' | 'semantic'

/** 文献检索结果条目（关键词检索用） */
export interface WorkHit {
  id: string
  doi: string | null
  title: string | null
  year: number | null
  venue: string | null
  citedBy: number
  authors: string[]
  /** 开放获取 PDF 链接（若有） */
  oaUrl: string | null
  isOa: boolean
  /** 摘要（OpenAlex 倒排索引还原；Crossref 无则为空） */
  abstract?: string | null
  /** 主要来源（OpenAlex / Crossref / Google Scholar / Semantic Scholar） */
  source?: WorkSource
  /** 去重合并后的全部来源（同一条论文可能被多个库命中） */
  sources?: WorkSource[]
  /** 「用 AI 找论文」的推荐理由（模型给的一句话，可空） */
  reason?: string | null
}

/** 某篇论文的被引信息：Google Scholar（SerpAPI）优先，Semantic Scholar 兜底 */
export interface CitationInfo {
  provider: 'google' | 'semantic' | 'none'
  /** 被引次数；未知为 null */
  count: number | null
  /** 被引详情 / 检索页（通常是 Google Scholar 搜索页） */
  url: string | null
  /** 未配置 Key、限流、未匹配等可读说明 */
  message?: string
}

/** 条目「主要思想」：来自已保存的论文拆解小节，或退回摘要 */
export interface ItemInsight {
  /** 小节标题（如「论文拆解（fine）」）或「摘要」 */
  title: string
  /** 纯文本/Markdown 片段 */
  markdown: string
  source: 'analysis' | 'abstract'
}

export interface GraphEdge {
  source: string
  target: string
  type: 'cites' | 'related'
}

export interface DiscoveryGraph {
  seed: GraphNode | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  warnings: string[]
  stats: {
    references: number
    citations: number
    related: number
    local?: number
    ai?: number
    /** 种子论文在数据源里的总量（用于提示「已取 M / 共 N」） */
    refsTotal?: number
    citesTotal?: number
    relatedTotal?: number
  }
}

/** 相关论文自检：定位「OpenAlex 没作用」的原因 */
export interface DiscoveryDiagnosis {
  itemTitle: string | null
  doi: string | null
  localCitations: number
  openalex: {
    ok: boolean
    error?: string
    references?: number
    related?: number
    mailto: string
    hasKey: boolean
  }
  crossref: { ok: boolean; error?: string; references?: number }
  notes: string[]
}

export interface AddMetadataInput {
  title?: string | null
  doi?: string | null
  year?: number | null
  venue?: string | null
  /** 归入某条目的「空间」下（相关论文/AI 建议加入文库时用） */
  parentId?: number | null
}

/** 译文定位（文件面板点击译文产物 → 切到「译文」视图） */
export interface TranslationTarget {
  translation: Translation
  itemId: number | null
}

/** 中英对照：翻译技能（按内容类型的 prompt） */
export interface TranslateSkill {
  id: string
  match: string
  label: string
  skip: boolean
  system: string
  /** 适用范围：all（全文）| first（仅首页）| rest（第 2 页起） */
  scope: string
  /** 版本号（每次保存自增；导入时用于冲突判断） */
  version: number
  updated_at: string
  path: string
}

/** 翻译自检：为什么翻译不出来 */
export interface TranslateDiagnosis {
  pageCount: number
  textChars: number
  textBlocks: number
  /** 基本无文本层（多为扫描件） */
  scanned: boolean
  engine: string
  backend: string
  model: string
  baseUrl: string
  /** 是否已配置真实模型（否则为离线占位） */
  configured: boolean
  /** 接口协议或模型路由不兼容时给出提示 */
  endpointHint: string | null
  /** 人类可读的结论 */
  notes: string[]
}

/** ===== M5 保版式翻译 ===== */
export interface Translation {
  id: number
  key: string
  attachment_id: number
  lang: string
  path: string
  /** 另存的可读 HTML（可选） */
  html_path: string | null
  /** 中英对照 HTML（可选） */
  bilingual_path: string | null
  /** 译文 Markdown（可选，便于放入笔记体系） */
  md_path: string | null
  /** 中英对照 Markdown（可选） */
  bilingual_md_path: string | null
  engine: string | null
  backend: string | null
  status: string
  /** 质量自检结果（JSON） */
  qa: string | null
  /** 是否标记为基线（收藏）；清理时永不被删 */
  pinned: number
  date_added: string
}

export interface TranslateOptions {
  requestId?: string
  lang?: string
  engine?: string
  backend?: string
  /** 已废弃：网页译文（HTML）已移除，保留字段仅为兼容旧调用 */
  format?: 'html' | 'pdf' | 'both'
  /** 翻译模式：fine=精译（默认）；coarse=粗译（个人阅读，优先速度） */
  mode?: 'fine' | 'coarse'
  /**
   * 版式：
   * - reflow（默认）：可读优先，允许段落在页内上下推挤/回收空白
   * - strict：严格保版式，段顶固定、宽度不越过原文段落右缘、不跨栏
   */
  layout?: 'reflow' | 'strict'
  /** 强制重新翻译（默认复用已有译文，不重复调用模型） */
  force?: boolean
  /**
   * 译文正文字号增量（pt）：0 = 与原文同字号；默认 1.5（设置 mt.fontDelta 可改）。
   * 参与复用判定——改了字号必须重新生成译文，否则看到的还是旧字号。
   */
  fontDelta?: number
}

export interface TranslateProgress {
  requestId?: string
  stage: string
  message?: string
  /** 0–1 的真实进度（用于确定型进度条） */
  progress?: number
}

/** 块级映射：源块矩形 → 译文实际落版矩形（PDF 坐标，**左下原点**，与选区/批注一致） */
export interface TranslationMapBlock {
  id: string | null
  page: number
  src: [number, number, number, number]
  dst: [number, number, number, number]
  /**
   * 句级片段（与 dstSegs 一一对应）。
   * 只有源/译文句数一致时才提供；缺失时只能整段映射，不猜。
   */
  srcSegs?: Array<[number, number, number, number]>
  dstSegs?: Array<[number, number, number, number]>
  /**
   * 句级多对多对齐：[源句矩形, 译句矩形]。
   * - 两侧句数不一致（模型合并/拆句）时也能按**累计字数比例**给出映射；
   * - 每项是**紧凑的句级片段**（一句跨多行时按行切分后再与对侧片段配对），
   *   不是整段并集框：客户端按片段与选区的真实交叠判断「选区落在句内」或
   *   「整句被选中」，选中半句 / 一句只落在对应译文上，不会扩展到整块；
   * - 旋转块、写回校验不通过（页面行文本与译文对不上）或旧译文没有句级字段时
   *   **不提供**；客户端此时不再整块兜底（只有整段全选才给块矩形）。
   */
  segs?: Array<
    [[number, number, number, number], [number, number, number, number]]
  >
  /**
   * 已从**翻译输入/译文**移除的文献角标（原文保持不动）。
   * 坐标与 src/dst 一致（左下原点）；origStart/cleanPos 用于文本偏移映射。
   */
  citations?: Array<{
    text: string
    page: number
    bbox: [number, number, number, number]
    origStart: number
    origEnd: number
    cleanPos: number
    context?: string
  }>
}

export interface TranslationMap {
  pageCount: number
  blocks: TranslationMapBlock[]
}

/** ===== M6 检索 / RAG ===== */
/** 检索模式 */
export type SearchHitKind = 'item' | 'note' | 'chunk' | 'translation'

export interface SearchHit {
  kind: SearchHitKind
  id: number
  itemId: number | null
  attachmentId: number | null
  page: number | null
  title: string | null
  snippet: string
  score: number
  /** kind='translation' 时：译文语言（用于切到译文视图） */
  translationLang?: string | null
}

export interface Citation {
  index: number
  chunkId: number
  itemId: number | null
  attachmentId: number | null
  page: number
  snippet: string
  /** 结构化模块定位（有则可精确跳转 + 高亮；没有则只按页码跳） */
  moduleId?: string | null
  moduleKind?: string | null
  /** 底边原点（y 向上，与 pdf.js 一致） */
  rect?: [number, number, number, number] | null
}

/** AI 问答：对话（记录对应论文与「第一份附件」，多份附件只取第一份用于展示） */
export interface AiConversation {
  id: number
  title: string
  itemId: number | null
  attachmentId: number | null
  /** 论文标题（用于展示） */
  itemTitle: string | null
  /** 第一份附件的文件名（用于展示） */
  attachmentName: string | null
  createdAt: string
  updatedAt: string
}

export interface AiConversationSummary extends AiConversation {
  messageCount: number
}

export interface AiChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  /** 提问时附带的选区上下文（完整原文/附件/页码）；老消息为 null */
  context?: AskSelection | null
  createdAt: string
}

/** 联网检索命中的网页来源（界面上以 [W1] 标注，与论文引用 [n] 区分） */
export interface WebSource {
  /** 序号（1 起）：正文里写作 [W1] */
  index: number
  title: string
  url: string
  /** 站点域名（展示用） */
  site: string | null
  /** 摘要/摘录（优先取页面正文） */
  snippet: string | null
  /** 是否成功抓取到页面正文 */
  fetched: boolean
}

export interface AskResult {
  answer: string
  citations: Citation[]
  backend: string
  mode?: string
  /**
   * 联网检索状态：
   * - off：未启用（设置关闭 / 本轮显式关闭）——行为与旧版完全一致
   * - on：已联网（webSources 非空）
   * - failed：尝试联网但失败，回答已降级为只读论文
   */
  web?: 'off' | 'on' | 'failed'
  /** web=failed 时的可读原因（超时 / DNS / HTTP 状态码） */
  webError?: string | null
  /**
   * 联网关闭但用户明确要求联网/最新信息时的说明：
   * 「本轮没有发送搜索请求」——避免把「没搜」显示成「搜了没有结果」。
   */
  webHint?: string | null
  /** 联网命中的网页来源 */
  webSources?: WebSource[]
  /** 本轮实际生效的联网模式（三态） */
  webMode?: AskWebMode
  /** 是否启用「严格依据文献」（只用检索到的论文/知识库，不给模型通用知识） */
  strict?: boolean
  /** 知识库（已发布条目）命中，与论文引用 [n]/网页 [Wn] 并列展示 */
  knowledgeHits?: KnowledgeHitRef[]
  /** 本轮实际检索范围的人类可读标签，如「本文 + 知识库(3) + 网页(2)」 */
  scopeLabel?: string
  /**
   * 模型/翻译失败时的可读原因（鉴权 401 / 限流 / 超时 / 网络）。
   * 非空表示本轮没有拿到模型回答；webSources / knowledgeHits 仍然有效，
   * 界面应把「失败原因」和「已经检索到的来源」一起显示。
   */
  error?: string | null
  /** 翻译结果元信息（task='translate' 时） */
  translation?: {
    sourceText: string
    /** 目标语言：zh | en */
    targetLang: string
    /** 分段数（长文自动分段） */
    chunks: number
    /** 是否被用户取消（保留已完成的段落） */
    cancelled: boolean
    /** 已完成的段数（取消时 < chunks） */
    completed?: number
  }
}

/** 知识库命中引用（轻量，供界面展示与跳转） */
export interface KnowledgeHitRef {
  id: number
  key: string
  kind: string
  title: string
  snippet: string
  /** 条目来源论文（若有） */
  itemId: number | null
  attachmentId: number | null
}

/** 问答/翻译的进度事件（主进程经 EVT.aiProgress 推给界面） */
export interface AskProgress {
  phase: 'retrieve' | 'knowledge' | 'web' | 'translate' | 'model'
  done: number
  total: number
  /** 可直接展示的中文进度文案 */
  message: string
}

/** 进度事件在通道上的载荷（带上请求标识，界面据此过滤、并支持多请求并存） */
export interface AskProgressEvent extends AskProgress {
  requestId: string
}

/**
 * 问答/翻译请求参数（主进程 `ask()` 的 opts，IPC 与 preload 共用）。
 * 渲染层只传「用户意图」，检索范围由主进程按 scope 再判定。
 */
export interface AskRequest {
  backend?: string
  limit?: number
  mode?: RetrievalMode
  task?: AskTask
  /** 多轮对话上下文（长原文也会保留，主进程只做轻量压缩） */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 限定在当前论文（附件）内检索 */
  attachmentId?: number | null
  /** 分组级问答：对某个分组（含子分组）的全部论文提问 */
  groupName?: string | null
  /** 全库/自定义论文集合（分组问答之外的显式范围） */
  itemIds?: number[] | null
  /** 联网三态；boolean 兼容旧调用（true=always、false=off） */
  web?: boolean | AskWebMode
  /** 严格依据文献：只允许引用检索到的论文/知识库/网页 */
  strict?: boolean
  /** 用户提供、要求翻译的原文（优先于选区与历史） */
  sourceText?: string
  /** 选区上下文：完整文本 + 附件 + 页码 */
  selection?: AskSelection | null
  /** 目标语言；缺省按原文自动判断 */
  targetLang?: 'zh' | 'en'
  /** 请求标识（取消 / 进度过滤） */
  requestId?: string
  /** 工具模式（仅单篇 QA 生效） */
  tools?: boolean
  /** 流式通道标识 */
  streamId?: string
}

/** 「用 AI 找论文」的结果：已去重、带来源标注 */
export interface PaperFindResult {
  /** 实际用于检索的关键词（模型润色或启发式提取） */
  query: string
  /** 关键词是否由模型生成 */
  queryByAi: boolean
  /** 论文结果（同 DOI/同标题已合并） */
  works: WorkHit[]
  /** 参与本次检索的来源 */
  providers: WorkSource[]
  /** 可读提示（无结果 / 检索失败等） */
  warnings: string[]
  /** 是否至少有一个学术库返回了结果 */
  online: boolean
}

/** 统一的「模型服务」配置（一个 Base URL + 一个 Key，全功能共用） */
export interface ProviderSettings {
  protocol?: 'openai' | 'anthropic'
  baseUrl: string
  apiKeySet: boolean
  chatModel: string
  embedModel: string
  mtModel: string
  /** auto：配了就用真模型，没配自动离线；mock：强制离线 */
  mode: string
}

export interface PublicSettings {
  provider: ProviderSettings
  /** 翻译引擎：simple（内置，保版式）| pdf2zh */
  mt: {
    engine: string
    keepVersions: string
    glossary: string
    autoGlossary: string
    thinking: string
    /** 译文正文字号增量（pt，0–4，默认 1.5） */
    fontDelta: string
  }
  /** 语义检索：1 开 / 0 关（历史兼容） */
  embed: { enabled: string; /** local（默认离线）| provider（走真模型）| off */ mode: string }
  batch: { concurrency: string; offPeakOnly: string; offPeakStart: string; offPeakEnd: string }
  /**
   * 论文拆解：长文分段 / 多篇卡片的并发（1–8，字符串与其它设置一致），
   * 以及模型路由（快速模型 / 强模型，留空 = 用默认对话模型）。
   */
  analysis: { workers: string; cardWorkers: string; fastModel: string; strongModel: string }
  /** 元数据提取：Crossref 消解默认开启（对无 DOI 的参考文献限量匹配） */
  metadata: { crossref: string; crossrefLimit: string }
  /**
   * 状态接口只回传「是否已设置」，明文 Key 不出主进程（PD42）。
   * apiKey 字段仅为兼容旧渲染层保留：getPublicSettings 不填值，导出时整字段删除。
   */
  openalex: { mailto: string; apiKey?: string; apiKeySet?: boolean }
  scholar: { apiKey?: string; apiKeySet?: boolean }
  semantic: { apiKey?: string; apiKeySet?: boolean }
  grobid: { url: string }
  /**
   * 检索（PD42）：rerank='1' 才尝试真正的语义重排，默认 '0'。
   * 嵌入后端为 none / local-hash-64 时即使打开也降级为词法，不静默冒充语义。
   */
  retrieval?: { rerank: string }
  /**
   * 联网检索（AI 问答）：enabled='1' 始终 / 'auto' 自动 / 其他（缺省）关闭；
   * proxy 显式代理（如 http://127.0.0.1:7993），留空 = 先试系统代理，再直连。
   */
  websearch: { enabled: string; proxy: string }
  /**
   * 「严格依据文献」模式：'1' 开启（只用检索到的论文/知识库，无依据就明确说没有）；
   * 缺省 '0'，允许模型用通用知识解释并标注为【模型知识】。
   */
  strictEvidence?: string
  ui: { theme: string }
  /**
   * 结构化解析适配层（blocks）开关：true 才会在下次启动侧车时注入
   * PAPERDESK_BLOCKS_ADAPTER=1；缺省/未设置 = false（默认关闭，与现状一致）。
   * 只影响**新解析**的文档，已有文档需要重新解析。
   */
  blocksAdapter?: boolean
}

/**
 * 知识库占位状态（PD31）：本轮只做接口桩——不实现检索/索引/向量化/上传解析。
 * 刻意不并入 PublicSettings / SettingsPatch，避免污染设置导出导入与 normalize/save。
 */
export interface KnowledgeStatus {
  enabled: boolean
  status: 'placeholder'
  /** 数据目录下的 knowledge 目录（首次读取时创建，已存在则不动） */
  root: string
}

/* ---------------- 知识库阶段 1a（PD33）：条目 / 提案 / 审核 / 发布 ---------------- */

/** 知识条目类型。与「内容性质」分开：类型说是什么，性质说谁负责 */
export type KnowledgeKind =
  | 'paper'
  | 'concept'
  | 'method'
  | 'result'
  | 'dataset'
  | 'metric'
  | 'claim'
  | 'note'
  | 'decision'
  | 'question'

/**
 * 内容性质（谁对这条内容负责）。AI 产物只能是 ai_suggestion / ai_inference，
 * 不允许把 AI 来源的内容标成 user_decision（见 services/knowledge-ai.ts）。
 */
export type KnowledgeNature =
  | 'user_decision'
  | 'user_hypothesis'
  | 'author_claim'
  | 'observation'
  | 'ai_inference'
  | 'ai_suggestion'

/** 证据来源类型：论文/译文/笔记/批注/对话/用户口头结论/论文拆解结果/批处理产物 */
export type KnowledgeSourceType =
  | 'paper'
  | 'translation'
  | 'note'
  | 'annotation'
  | 'conversation'
  | 'user'
  | 'digest'
  | 'batch'

/** 证据定位精度；缺定位时服务层降到 document 并标「待核验」，绝不编造页码 */
export type KnowledgeEvidencePrecision = 'module' | 'page' | 'document' | 'message'

/** 来源可信度：pending=待核验（缺可定位来源），verified=已定位到原文 */
export type KnowledgeVerification = 'pending' | 'verified'

export type KnowledgeProposalOp = 'create' | 'update'

/**
 * 提案审核状态。approved = 用户已接受、等待发布（发布是独立动作）。
 * draft 预留给后续工作流自动生成的草稿；published 只能由发布事务写入。
 */
export type KnowledgeProposalStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'needs_edit'
  | 'rejected'
  | 'published'
  | 'withdrawn'

export type KnowledgeBatchStatus =
  | 'draft'
  | 'ready'
  | 'partially_published'
  | 'published'
  | 'abandoned'

export type KnowledgeReviewAction = 'accept' | 'reject' | 'edit_accept' | 'publish'

export type KnowledgeEntryState = 'active' | 'archived'

export type KnowledgeBatchOrigin = 'user' | 'ai_workflow' | 'import'

export type KnowledgeBatchScopeType = 'library' | 'item' | 'conversation' | 'selection' | 'manual'

/** 证据草案（创建/编辑提案时提交；发布时落成 evidence_links 行） */
export interface KnowledgeEvidenceInput {
  sourceType: KnowledgeSourceType
  /** 非论文来源的定位：conversationId / messageId / noteId / translationId 等（禁止放密钥） */
  sourceRef?: Record<string, string | number | boolean | null> | null
  itemId?: number | null
  attachmentId?: number | null
  /** 0 基页码（与 reader 模块一致）；对话/笔记来源留空，禁止填占位页码 */
  pageIndex?: number | null
  pageEnd?: number | null
  moduleId?: string | null
  rect?: string | null
  charStart?: number | null
  charEnd?: number | null
  /** 原文片段；为空的证据不计入「已验证」 */
  quote: string
  sectionPath?: string | null
  /** 省略时按可用定位推导（page > module > message > document） */
  precision?: KnowledgeEvidencePrecision | null
}

/** 提案正文（用户/AI 提出、用户编辑的对象） */
export interface KnowledgeContent {
  kind: KnowledgeKind
  title: string
  body: string
}

export interface CreateKnowledgeBatchInput {
  title: string
  /** 生成该批次的任务（如 'ai-extract-claims'、'manual'） */
  task: string
  scopeType?: KnowledgeBatchScopeType
  scopeRef?: string | null
  origin?: KnowledgeBatchOrigin
  aiConfigRef?: string | null
  workflowVersion?: string | null
  skillVersion?: string | null
  /** 重复提交同一幂等键返回既有批次，不新建 */
  idempotencyKey?: string | null
}

export interface CreateKnowledgeProposalInput {
  op: KnowledgeProposalOp
  /** 提案归属论文（可按论文过滤待审队列） */
  itemId?: number | null
  /** update 必填：目标条目 id 或 key（二选一） */
  targetEntryId?: number | null
  targetKey?: string | null
  /** update 必填：提案基于的条目版本，发布时用于冲突检测 */
  baseVersion?: number | null
  content: KnowledgeContent
  contentNature: KnowledgeNature
  sourceType: KnowledgeSourceType
  sourceRef?: Record<string, string | number | boolean | null> | null
  evidence?: KnowledgeEvidenceInput[]
  reason?: string
}

export interface KnowledgeBatchCounts {
  total: number
  pending: number
  approved: number
  published: number
  rejected: number
  /** 批次内涉及的论文数（按 item_id 去重；批处理批次用于显示「来自批处理（N 篇）」） */
  papers?: number
}

export interface KnowledgeBatch {
  id: number
  key: string
  title: string
  task: string
  status: KnowledgeBatchStatus
  scopeType: KnowledgeBatchScopeType
  scopeRef: string | null
  origin: KnowledgeBatchOrigin
  aiConfigRef: string | null
  workflowVersion: string | null
  skillVersion: string | null
  counts: KnowledgeBatchCounts
  createdAt: string
  updatedAt: string
}

export interface KnowledgeProposalSummary {
  id: number
  key: string
  batchId: number
  itemId: number | null
  op: KnowledgeProposalOp
  status: KnowledgeProposalStatus
  verification: KnowledgeVerification
  kind: KnowledgeKind
  title: string
  /** 提案来源论文的标题（PD43：暂存区按论文展开/筛选时显示，非论文来源为 null） */
  itemTitle?: string | null
  contentNature: KnowledgeNature
  sourceType: KnowledgeSourceType
  sourceRef: Record<string, string | number | boolean | null>
  /**
   * 内容指纹（PD41 起由 mapProposal 恒填）：kind+标题+正文的规范化 sha256。
   * 与发布后 knowledge_entries.content_hash 同源，用于「这条提案进知识库后是哪条内容」。
   */
  contentHash: string
  targetEntryId: number | null
  targetKey: string | null
  baseVersion: number | null
  reason: string
  /** 来源缺失/未定位：UI 显示「待核验」，发布会被拒绝 */
  needsVerification: boolean
  /** 提案程序检查的问题列表（中文，可直接展示） */
  problems: string[]
  createdAt: string
  updatedAt: string
}

/* ---------------- 知识库阶段 1b（PD38）：论文拆解结果同步 ---------------- */

/**
 * 「同步到知识库」的输入：拆解产出的 markdown 原文。
 * 服务层把它切成要点、生成一个 source=digest 的提案批次（待审核），不直接发布。
 */
export interface DigestSyncInput {
  itemId: number
  markdown: string
  /** 批次标题；省略时由文献标题与拆解要点数推导 */
  title?: string | null
}

/**
 * 「同步到知识库」的结果。重复同步同一份拆解（同指纹）会命中幂等：
 * 批次与提案都不新建，createdProposals=0、reusedProposals=已有点数。
 */
export interface DigestSyncResult {
  itemId: number
  batchId: number
  batchKey: string
  /** 拆解内容指纹（同内容同指纹，用于幂等标注） */
  fingerprint: string
  /** 拆解要点数（= 该批次应收的提案数） */
  pointCount: number
  /** 本次新建的提案数 */
  createdProposals: number
  /** 幂等命中而跳过的提案数 */
  reusedProposals: number
}

/* ---------------- 知识库阶段 2（PD43）：批处理产物同步 ---------------- */

/**
 * 批处理里一篇论文的拆解结果（主进程按批次标识 + 每题最新 done 明细从输出目录读出）。
 * markdown 来自该题产出的 *.analysis.md；缺失/无要点时不会进入 papers。
 */
export interface BatchDigestPaper {
  itemId: number
  attachmentId: number | null
  /** 该论文所属批次的批次标识 */
  batchRunId: string
  batchJobId: number
  batchItemId: number
  title: string
  markdown: string
}

/** 未能同步的论文：告诉用户「哪些没进来、为什么」，不静默丢数据 */
export interface BatchSyncSkippedPaper {
  itemId: number | null
  batchItemId: number
  title: string
  reason: string
}

/**
 * 「批处理产物 → 知识库」的结果：一次批处理 = 一个提案批次。
 * 只创建 pending_review 提案，绝不自动发布；重跑幂等、追加只补新增论文。
 */
export interface BatchSyncResult {
  runId: string
  batchId: number
  batchKey: string
  /** 本次参与同步的论文数 */
  papers: number
  /** 这批论文的要点总数（= 该批次应收的提案数） */
  pointCount: number
  /** 本次新建的提案数 */
  createdProposals: number
  /** 幂等命中而跳过的提案数（已存在的不重复插入、不覆盖） */
  reusedProposals: number
  /** 没能同步的论文及原因 */
  skippedPapers: BatchSyncSkippedPaper[]
  /** 同步目标（PD44；旧调用方不传时按 knowledge 处理） */
  target?: BatchSyncTarget
  /** 逐篇成功 / 跳过 / 失败计数（PD44） */
  success?: number
  skipped?: number
  failed?: number
  /** 逐篇结果，含原因（PD44；失败不阻塞其余论文） */
  items?: BatchSyncItemResult[]
}

/* ---------------- 知识库阶段 2（PD44）：批处理产物勾选同步 ---------------- */

/** 批处理产物同步目标：待审提案（知识库）或该论文的思维地图节点 */
export type BatchSyncTarget = 'knowledge' | 'mindmap'

/** 批处理同步入参：勾选论文（itemIds 为空 = 整批 done 论文） */
export interface BatchSyncInput {
  jobId: number
  target: BatchSyncTarget
  itemIds?: number[]
}

export type BatchSyncItemStatus = 'success' | 'skipped' | 'failed'

/** 单篇论文的同步结果：success/skipped/failed 都要带原因，失败不阻塞后续论文 */
export interface BatchSyncItemResult {
  itemId: number | null
  batchItemId: number | null
  title: string
  status: BatchSyncItemStatus
  reason: string
  /** 知识库：本次新建的待审提案数 */
  createdProposals: number
  /** 思维地图：本次新增节点数 */
  added: number
  /** 思维地图：幂等命中而保留的节点数 */
  reused: number
  /** 思维地图（PD55）：本次覆盖删除的旧同步节点数 */
  removed?: number
  /** 思维地图（PD55）：用户改过而保留的旧同步节点数 */
  kept?: number
  /** 思维地图（PD55）：骨架来源 */
  mode?: MindmapSkeletonMode
  /** 思维地图（PD55）：骨架回退等可读提示 */
  warnings?: string[]
}

/** 暂存区「按论文筛选」用的行：该论文在这批提案里的条数与待审数 */
export interface KnowledgeBatchPaper {
  itemId: number
  title: string | null
  total: number
  pending: number
}

/* ---------------- 知识库阶段 2（PD41）：笔记 / 译文导入 ---------------- */

/**
 * 可导入知识库的「我自己的内容」：
 * - note：我在阅读器里写的笔记（notes 表，按 item_id 归属）
 * - translation：已完成的译文段落（translations 表，经 attachments 归属到条目）
 * 论文原文与 AI 拆解不在此列（前者是 paper 来源、后者走 PD38 的 digest 同步）。
 */
export type KnowledgeImportSourceType = 'note' | 'translation'

/**
 * 导入入口的输入：选定的文献 + 要导入的来源种类。
 * PD51 起目标由「当前打开的论文」自动推导，attachmentId 仅供界面回显与后续
 * 附件级收窄使用；主进程仍按 item_id（论文级）收集笔记 / 译文。
 */
export interface KnowledgeImportInput {
  itemId: number
  attachmentId?: number | null
  source: KnowledgeImportSourceType
}

/**
 * 导入结果：始终只产出 pending_review 提案（绝不自动发布）。
 * 重复导入同一份内容会命中幂等：批次不新建、createdProposals=0。
 */
export interface KnowledgeImportResult {
  itemId: number
  source: KnowledgeImportSourceType
  batchId: number
  batchKey: string
  /** 计划中的要点数（= 该批次应收的提案数，不含跨来源重复段） */
  pointCount: number
  /** 本次新建的提案数 */
  createdProposals: number
  /** 幂等命中（同批次已有同内容提案）而跳过的数量 */
  reusedProposals: number
  /** 跨来源 / 跨批次的同内容重复段数量（笔记与译文同段内容只进一次） */
  skippedDuplicates: number
}

export interface KnowledgeProposalReview {
  id: number
  action: KnowledgeReviewAction
  reason: string
  reviewer: string
  editedPatch: unknown
  createdAt: string
}

/** 提案详情：数据层给 before/content/evidence，差异行由 IPC 层用 shared/diff.ts 生成 */
export interface KnowledgeProposalDetail extends KnowledgeProposalSummary {
  content: KnowledgeContent
  /** update 的基线快照（创建提案时的条目内容）；create 为 null */
  before: (KnowledgeContent & { version: number }) | null
  evidence: KnowledgeEvidenceInput[]
  /** 行级差异（left=发布前，right=提案后）；仅 IPC 返回值带，服务层不含 */
  diff?: import('./diff').DiffRow[]
  diffStats?: { added: number; removed: number; same: number }
  reviews: KnowledgeProposalReview[]
}

export interface KnowledgeProposalFilter {
  batchId?: number | null
  itemId?: number | null
  status?: KnowledgeProposalStatus | KnowledgeProposalStatus[]
  op?: KnowledgeProposalOp
  limit?: number
}

export interface KnowledgeEntrySummary {
  id: number
  key: string
  kind: KnowledgeKind
  title: string
  contentNature: KnowledgeNature
  itemId: number | null
  /**
   * 归属论文（PD50）：`item_id` 命中 items 时取该行 id；
   * `item_id` 为空时用 `attachment_id → attachments.item_id` 兜底；
   * 两条都没有（或指向已删除的文献）时为 null，前端归入「未关联论文」。
   */
  paperItemId: number | null
  /** 归属论文标题；与 paperItemId 同源，取不到时为 null */
  paperTitle: string | null
  version: number
  state: KnowledgeEntryState
  createdAt: string
  updatedAt: string
}

export interface KnowledgeEvidenceLink {
  id: number
  entryId: number
  proposalId: number | null
  sourceType: KnowledgeSourceType
  sourceRef: Record<string, string | number | boolean | null>
  itemId: number | null
  attachmentId: number | null
  pageIndex: number | null
  pageEnd: number | null
  moduleId: string | null
  quote: string
  sectionPath: string | null
  precision: KnowledgeEvidencePrecision
  contentHash: string
  verified: boolean
  createdAt: string
}

export interface KnowledgeEntryDetail extends KnowledgeEntrySummary {
  body: string
  attachmentId: number | null
  sourceType: KnowledgeSourceType
  sourceRef: Record<string, string | number | boolean | null>
  contentHash: string
  evidence: KnowledgeEvidenceLink[]
  versions: { version: number; changeReason: string; proposalId: number | null; createdAt: string }[]
}

export interface KnowledgePublishConflict {
  proposalId: number
  key: string
  reason: string
}

export interface KnowledgePublishResult {
  ok: boolean
  /** 本次请求的提案此前已全部发布（未新增任何条目/版本） */
  alreadyPublished: boolean
  publishedProposalIds: number[]
  entryIds: number[]
  conflicts: KnowledgePublishConflict[]
  batchStatus: KnowledgeBatchStatus
}

/** 提交时 apiKey 才明文；留空表示不修改 */
export interface SettingsPatch {
  provider?: {
    protocol?: 'openai' | 'anthropic'
    baseUrl?: string
    apiKey?: string
    chatModel?: string
    embedModel?: string
    mtModel?: string
    mode?: string
  }
  mt?: {
    engine?: string
    keepVersions?: string
    glossary?: string
    autoGlossary?: string
    thinking?: string
    /** 译文正文字号增量（pt，0–4，默认 1.5）：整篇 / 单页重译 / 批处理共用 */
    fontDelta?: string
  }
  embed?: { enabled?: string; mode?: string }
  batch?: { concurrency?: string; offPeakOnly?: string; offPeakStart?: string; offPeakEnd?: string }
  /** 拆解：并发 / 卡片并发（1–8）+ 快速模型 / 强模型（留空 = 默认模型） */
  analysis?: { workers?: string; cardWorkers?: string; fastModel?: string; strongModel?: string }
  metadata?: { crossref?: string; crossrefLimit?: string }
  /** 检索（PD42）：'1' 开启语义重排 / '0' 关闭（默认）；哈希后端下仍会降级为词法 */
  retrieval?: { rerank?: string }
  openalex?: { mailto?: string; apiKey?: string }
  /** Google Scholar 检索（SerpAPI）Key；留空则只能在浏览器打开 */
  scholar?: { apiKey?: string }
  /** Semantic Scholar API Key（可选，提高免费配额） */
  semantic?: { apiKey?: string }
  grobid?: { url?: string }
  /** 联网检索：三态（'1' 始终 / 'auto' 自动 / '0' 关闭）与显式代理（留空 = 系统代理 → 直连） */
  websearch?: { enabled?: string; proxy?: string }
  /** 「严格依据文献」：'1' 开启 / '0' 关闭（缺省关闭） */
  strictEvidence?: string
  ui?: { theme?: string }
  /**
   * 结构化解析适配层开关：true = 下次启动侧车时注入 PAPERDESK_BLOCKS_ADAPTER=1；
   * false = 不注入（保持与旧版一致，绝不写 '0'）。缺省 = 不修改。
   */
  blocksAdapter?: boolean
}

/** 服务自检结果（设置里的「服务自检」） */
export interface SystemHealth {
  python: { ok: boolean; error?: string; mineru?: boolean; pdf2zh?: boolean }
  provider: { configured: boolean; mode: string; baseUrl: string; chatModel: string; embedModel: string }
}

/** 模型服务连通性测试结果 */
export interface ProviderTestResult {
  ok: boolean
  error?: string
  model: string
  baseUrl: string
  latencyMs: number
}

/** 检索模式 */
export type RetrievalMode = 'lexical' | 'semantic' | 'hybrid'

/** AI 面板任务：问答 / 名词解释 / 翻译（翻译不再依赖检索命中，见 docs/CODE-MAP.md 4.1） */
export type AskTask = 'qa' | 'term' | 'translate'

/**
 * 联网检索模式（三态）：
 * - off：不发任何搜索请求（设置关闭或用户本轮选择关闭）
 * - auto：只在本地检索没有给出任何依据时才联网（术语解释、文库外概念）
 * - always：本轮总是联网
 */
export type AskWebMode = 'off' | 'auto' | 'always'

/**
 * 选区/粘贴文本的独立上下文（随消息持久化到 ai_messages.context_json）。
 * 翻译与「翻译上面这段」靠它拿到完整原文 + 出处页码，而不是依赖被截断的历史消息。
 */
export interface AskSelection {
  /** 完整原文（不截断） */
  text: string
  /** 来源附件（粘贴文本为 null） */
  attachmentId: number | null
  /** 1 起页码（粘贴文本为 null） */
  page: number | null
  /** 来源：PDF 选区 / 用户粘贴 */
  origin: 'selection' | 'paste'
}

/** ===== 作者信息搜索 ===== */
export interface AuthorSummary {
  /** OpenAlex 作者 ID（如 A123…），或本地作者 local:<id> */
  id: string
  name: string
  orcid: string | null
  worksCount: number
  citedBy: number
  hIndex: number | null
  affiliation: string | null
  source: 'openalex' | 'local'
  /** 若本地 authors 表已有同名/已关联记录，则为该本地作者 id */
  localAuthorId?: number | null
}

export interface AuthorWork {
  id: string
  title: string | null
  year: number | null
  venue: string | null
  doi: string | null
  citedBy: number
}

export interface AuthorProfile {
  author: AuthorSummary
  works: AuthorWork[]
  warnings: string[]
}

/** 把 OpenAlex 作者关联/合并到本地 authors 表 */
export interface LinkAuthorInput {
  openalexId: string
  name: string
  orcid?: string | null
}

export interface LinkAuthorResult {
  /** 本地 authors.id */
  authorId: number
  /** 是否新建了本地作者记录 */
  created: boolean
  /** 合并掉的重复本地作者条数 */
  merged: number
  openalexId: string
}

/** 整理本地作者的结果 */
export interface AuthorCleanupResult {
  /** 合并掉的同名重复作者条数 */
  merged: number
  /** 通过 ORCID 从 OpenAlex 补齐 openalex_id 的条数 */
  enriched: number
  /** 尝试富化的本地作者数（含 orcid 但缺 openalex_id） */
  scanned: number
}

/** 按 ORCID 批量导入本地作者的结果 */
export interface ImportAuthorsResult {
  added: number
  updated: number
  skipped: number
  errors: string[]
}

/** ===== 文件面板（VSCode 式打开 / Obsidian 式可视化） ===== */
export interface FsEntry {
  name: string
  /** 相对 data/ 的路径（POSIX 分隔符） */
  path: string
  absPath: string
  isDir: boolean
  size: number
  mtime: number
}

export interface FsListing {
  /** 当前目录（相对 data/，根为 ''） */
  path: string
  /** 上级目录（相对 data/，根为 null） */
  parent: string | null
  entries: FsEntry[]
}

/** 打开文件的结果：是否用 VS Code 打开，或已回退到系统方式 */
export interface OpenInResult {
  ok: boolean
  /** true 表示没能用 VS Code，已回退系统默认程序/资源管理器 */
  fallback: boolean
  error?: string
}

/** 批量导入文件夹的结果 */
export interface ImportFolderResult {
  imported: number
  skipped: number
  errors: string[]
}

/** ===== 批处理 ===== */
export type BatchJobStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface BatchJob {
  id: number
  key: string
  /**
   * PD43 批次标识：同一次批处理（含它的重试 / 追加作业）共享。
   * 批处理产物同步到知识库时按它幂等——一次批处理只对应一个提案批次。
   */
  batch_run_id: string
  task: string
  title: string
  params: string
  status: BatchJobStatus
  off_peak_only: number
  total: number
  done: number
  message: string | null
  out_dir: string | null
  error: string | null
  date_created: string
  date_started: string | null
  date_finished: string | null
}

export interface BatchItemRow {
  id: number
  job_id: number
  item_id: number | null
  attachment_id: number | null
  label: string | null
  status: string
  output: string | null
  message: string | null
}

export interface BatchParamField {
  key: string
  label: string
  type: 'select' | 'text' | 'textarea'
  options?: Array<{ value: string; label: string }>
  /** textarea 的预置模板 */
  presets?: Array<{ name: string; value: string }>
  placeholder?: string
  default?: string
  /** textarea 行数 */
  rows?: number
  hint?: string
}

export interface BatchTaskInfo {
  id: string
  title: string
  description: string
  input: 'attachment' | 'item'
  usesLlm: boolean
  paramFields: BatchParamField[]
}

export interface CreateBatchInput {
  task: string
  scope: 'all' | 'item' | 'attachment' | 'select' | 'group' | 'tag'
  itemId?: number | null
  attachmentId?: number | null
  /** scope='select' 时选中的条目 id */
  itemIds?: number[]
  /** scope='group' 时的分组路径；含全部后代分组 */
  group?: string | null
  /** scope='tag' 时的手动标签名 */
  tag?: string | null
  params?: Record<string, string>
  offPeakOnly?: boolean
}

export interface BatchProgress {
  jobId: number
  status: BatchJobStatus
  done: number
  total: number
  message?: string
}

export interface BatchWindowStatus {
  inOffPeak: boolean
  enabled: boolean
  start: string
  end: string
  label: string
}

/** ===== Zotero 连接器（本地 HTTP 接收端） ===== */
export interface ConnectorStatus {
  running: boolean
  port: number
  token: string
  enabled: boolean
  /** 形如 http://127.0.0.1:23124 */
  url: string
}

/** ===== 测试副本可控故障注入（FA01/FA02） ===== */
export type TestFaultName = 'copy-fail' | 'search-fail'

/** 设置页「数据安全」只读展示的注入状态；正式版恒为 { isTestCopy: false, fault: null } */
export interface TestFaultStatus {
  /** 当前进程是否运行在隔离测试副本 */
  isTestCopy: boolean
  /** 当前生效的注入，null 表示未启用 */
  fault: TestFaultName | null
}
