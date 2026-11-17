import type {
  OrganizeApplyResult,
  OrganizeDraft,
  OrganizePreviewRequest,
  OrganizePreviewResult,
  OrganizeVersionRow
} from './organize'
import type {
  Item,
  Attachment,
  ImportPdfResult,
  ImportPdfBatchResult,
  ImportFolderResult,
  FsListing,
  OpenInResult,
  AuthorSummary,
  AuthorProfile,
  AuthorCleanupResult,
  ImportAuthorsResult,
  LinkAuthorInput,
  LinkAuthorResult,
  Annotation,
  NewAnnotation,
  Note,
  NoteWithContent,
  MindMapDoc,
  MindMapNode,
  ExtractSummary,
  StructureResult,
  MetadataView,
  DiscoveryGraph,
  DiscoverySource,
  DiscoveryDiagnosis,
  WorkHit,
  CitationInfo,
  AddMetadataInput,
  Translation,
  TranslateOptions,
  TranslateProgress,
  TranslationTarget,
  TranslateDiagnosis,
  TranslateSkill,
  SearchHit,
  AskResult,
  AskRequest,
  AskProgressEvent,
  AskWebMode,
  AskTask,
  RetrievalMode,
  PaperFindResult,
  PublicSettings,
  SettingsPatch,
  TestFaultStatus,
  KnowledgeStatus,
  CreateKnowledgeBatchInput,
  CreateKnowledgeProposalInput,
  DigestSyncInput,
  DigestSyncResult,
  KnowledgeImportInput,
  KnowledgeImportResult,
  KnowledgeBatch,
  KnowledgeContent,
  KnowledgeEntryDetail,
  KnowledgeEntryState,
  KnowledgeEntrySummary,
  KnowledgeEvidenceInput,
  KnowledgeKind,
  KnowledgeProposalDetail,
  KnowledgeProposalFilter,
  KnowledgeProposalOp,
  KnowledgeProposalStatus,
  KnowledgeProposalSummary,
  KnowledgePublishConflict,
  KnowledgePublishResult,
  KnowledgeReviewAction,
  KnowledgeSourceType,
  BatchDigestPaper,
  BatchSyncInput,
  BatchSyncResult,
  BatchSyncSkippedPaper,
  KnowledgeBatchPaper,
  SystemHealth,
  ProviderTestResult,
  BatchJob,
  BatchItemRow,
  BatchTaskInfo,
  CreateBatchInput,
  BatchProgress,
  BatchWindowStatus,
  ConnectorStatus,
  LibraryGroup,
  LibraryTag
} from './types'
import type { AiToolState, AiToolUpdateInput, AiToolsResult } from './ai-tools'
import type { BatchEstimate } from './batch-estimate'
import type { BiblioGraph, BiblioKind } from './biblio'
import type {
  MindmapExpansionResult,
  MindmapMapOptimizeResult,
  MindmapOptimizeResult,
  MindmapSummaryResult,
  MindmapSupportResult
} from './mindmap-ai'
import type { MindmapSyncInput, MindmapSyncResult } from './types'
import type { MindmapExportFormat } from './mindmap-export'
import type { MindmapScope, MindmapScopeDoc } from './mindmap-scope'

/** 删除分组的结果：removed 是实际删掉的全部分组路径（含 withDescendants 的子树） */
export interface DeleteGroupResult {
  /** 被删除的根分组完整路径 */
  name: string
  /** 根分组的父分组（文献落点）；null = 未分组 */
  parent_name: string | null
  /** 实际删除的全部分组路径（叶子删除时只有根分组本身） */
  removed: string[]
  /** 文献落点：父分组路径，null = 未分组 */
  movedTo: string | null
  /** 被移出该（子）树的文献条数 */
  movedItems: number
}

// 暴露给渲染进程的 API 契约（preload 实现，renderer 消费）
export interface PaperdeskApi {
  library: {
    list(): Promise<Item[]>
    get(id: number): Promise<Item | null>
    importPdf(group?: string | null): Promise<ImportPdfResult | null>
    /**
     * 多选 PDF：一次选择多份并逐份导入。
     * 返回 { canceled, items, message, itemIds }；itemIds 只含本次新增条目，
     * 重复文件不计入（渲染层不再用导入前后的全库 id 差集推断归属）。
     */
    importPdfs(group?: string | null): Promise<ImportPdfsOutcome>
    /** 选择文件夹并批量导入其中的 PDF；itemIds 只含本次新增条目 */
    importFolder(group?: string | null): Promise<ImportFolderOutcome | null>
    /** 从链接 / DOI / arXiv 嗅探并下载 PDF 后导入（DOI 已存在时 skipped: true） */
    importFromUrl(input: string, group?: string | null): Promise<ImportUrlOutcome>
    /** 批量导入：多行 DOI / arXiv / 网页链接（自动去重） */
    importManyFromUrls(text: string, group?: string | null): Promise<ImportManyOutcome>
    addMetadata(input: AddMetadataInput): Promise<Item>
    /** 重命名条目；有附件时同步重命名磁盘 PDF */
    rename(itemId: number, title: string): Promise<Item>
    /** 删除条目（含附件/批注/引用与空间目录） */
    delete(itemId: number): Promise<void>
    /** 设置条目分组；group 为 null / 空串表示移出分组 */
    setGroup(itemId: number, group: string | null): Promise<Item>
    /** 批量设置分组（一次事务 + 一次变更广播），返回实际更新条数 */
    setGroupMany(itemIds: number[], group: string | null): Promise<number>
    /** 全部分组（含空分组与父子关系） */
    listGroups(): Promise<LibraryGroup[]>
    /** 新建分组；parent 为空 = 顶层，支持多层 */
    createGroup(name: string, parent?: string | null): Promise<LibraryGroup>
    getGroup(name: string): Promise<LibraryGroup | null>
    /** 编辑分组；position（1 起）= 目标同层位次（移动/重排时使用，只传 position 即同层重排） */
    updateGroup(
      name: string,
      patch: {
        leaf?: string
        parent?: string | null
        description?: string | null
        position?: number | null
      }
    ): Promise<LibraryGroup>
    /**
     * 删除分组。叶子分组的文献并入父分组（无父 = 未分组）；
     * 带子分组时默认拒绝，只有 withDescendants:true 才整棵删除。
     */
    deleteGroup(
      name: string,
      options?: {
        withDescendants?: boolean
      }
    ): Promise<DeleteGroupResult>
    /** 手动标签（跨分组，用于筛选与批处理范围） */
    listTags(): Promise<LibraryTag[]>
    tagsForItems(itemIds: number[]): Promise<Record<number, string[]>>
    setTags(itemId: number, names: string[]): Promise<string[]>
    /** 为元数据条目补齐摘要/来源（Crossref / OpenAlex） */
    enrich(itemId: number): Promise<Item>
  }
  attachments: {
    listByItem(itemId: number): Promise<Attachment[]>
    readBytes(id: number): Promise<Uint8Array>
    getByKey(key: string): Promise<Attachment | null>
    /** 按相对 data/ 的路径（POSIX）反查附件（文件面板「在应用内打开」用） */
    getByPath(path: string): Promise<Attachment | null>
  }
  reader: {
    /** 页面缩略图（base64 PNG）：删除前核对用，只读不改文件 */
    pageThumbs(
      attachmentId: number,
      pages?: number[]
    ): Promise<{ pageCount: number; thumbs: { page: number; png: string }[] }>
    /** 删除指定页（0 基）：生成新版本，返回新页数与版本号 */
    deletePages(
      attachmentId: number,
      pages: number[]
    ): Promise<{
      attachmentId: number
      versionId: number
      pageCount: number
      removed: number[]
      translationRegenerated: boolean
      warnings: string[]
    }>
    /** 该附件的编辑历史（含已撤销） */
    pageEdits(attachmentId: number): Promise<
      Array<{
        id: number
        kind: string
        removed: number[]
        pageMap: number[]
        pageCountFrom: number
        pageCountTo: number
        createdAt: string
        undoneAt: string | null
      }>
    >
    /** 撤销/恢复某个页面编辑版本 */
    restorePageEdit(versionId: number): Promise<{
      attachmentId: number
      versionId: number
      pageCount: number
      translationRegenerated: boolean
      warnings: string[]
    }>
    listAnnotations(attachmentId: number): Promise<Annotation[]>
    /** 每页的矢量图形区域 + 图表题注（侧车脚本计算），用于点击图表引用时精确裁剪预览 */
    figures(attachmentId: number): Promise<
      Array<{
        page: number
        w: number
        h: number
        rects: number[][]
        captions: Array<{ n: number; letter: string; kind: string; rect: number[] }>
      }>
    >
    /** 结构化模块层（章节/段落/图片/表格/图注/表注/公式/定理/参考文献 + 关联关系） */
    modules(attachmentId: number): Promise<import('./modules').StructuredDoc>
    /** 公式明细（逐公式查询/统计；含质量标记与结构树） */
    formulas(attachmentId: number): Promise<import('./modules').FormulaModule[]>
    /** 选择公式最终结果（低置信度回退为候选，不覆盖原文） */
    saveModuleLatex(
      attachmentId: number,
      moduleId: string,
      latex: string,
      source: 'extracted' | 'recognized',
      validation?: import('./formula-validate').FormulaValidation
    ): Promise<boolean>
    /** 把某页某区域渲染成 PNG（base64），供网页译文里的图表预览 */
    figureImage(
      attachmentId: number,
      page: number,
      rect: number[],
      scale: number
    ): Promise<{ png: string; w: number; h: number } | null>
    createAnnotation(payload: NewAnnotation): Promise<Annotation>
    deleteAnnotation(id: number): Promise<void>
  }
  notes: {
    listByItem(itemId: number): Promise<Note[]>
    getForItem(itemId: number): Promise<NoteWithContent | null>
    /** 按相对 data/ 的路径（POSIX）反查笔记（文件面板「.md → 笔记面板」用） */
    getByPath(path: string): Promise<Note | null>
    create(itemId: number, title?: string): Promise<NoteWithContent>
    save(id: number, body: string): Promise<Note>
    delete(id: number): Promise<void>
    addAnnotation(itemId: number, annotationId: number): Promise<NoteWithContent>
  }
  mindmap: {
    /** 读取该文献的思维地图；还没有时返回 null（渲染层会新建空白地图） */
    load(itemId: number): Promise<MindMapDoc | null>
    /** 覆盖保存整份地图，返回带服务端 updatedAt 的最终文档 */
    save(itemId: number, doc: MindMapDoc): Promise<MindMapDoc>
    /** AI：给选中节点生成摘要；未配置/失败时 reject 带可读文案的 Error */
    summarize(itemId: number, nodeId: string): Promise<MindmapSummaryResult>
    /** AI：把选中节点展开成 2–4 个子节点（返回文本，由渲染层写入地图后整份保存） */
    expand(itemId: number, nodeId: string): Promise<MindmapExpansionResult>
    /** AI：从本文找支撑段落；核对不上时 found:false（绝不编造页码） */
    findSupport(itemId: number, nodeId: string): Promise<MindmapSupportResult>
    /** AI：把选中节点现有子节点整理成 2–6 个分组（PD55） */
    optimize(itemId: number, nodeId: string): Promise<MindmapOptimizeResult>
    /** AI：整图优化——按整张地图大纲重新分组（PD58） */
    optimizeMap(itemId: number): Promise<MindmapMapOptimizeResult>
    /** 拆解 → 思维地图覆盖式同步：写入三层骨架并返回 added/removed/kept/mode（PD55） */
    syncDigest(input: MindmapSyncInput): Promise<MindmapSyncResult>
    /** 导出当前地图为 Markdown 大纲 / Mermaid 图；用户取消保存框返回 null */
    export(
      itemId: number,
      format: MindmapExportFormat,
      doc: MindMapDoc
    ): Promise<string | null>
    /** 读取聚合地图（全部论文 / 分组 / 单篇范围）；只读，不写回任何单篇地图 */
    loadScope(scope: MindmapScope): Promise<MindmapScopeDoc>
    /** 在独立窗口打开某篇论文的思维地图；同篇重复调用复用同一窗口 */
    openPaper(itemId: number): Promise<{ ok: boolean; windowId: number | null; error?: string }>
  }
  metadata: {
    extract(
      attachmentId: number,
      opts?: { forceVision?: boolean; forceTitle?: boolean }
    ): Promise<ExtractSummary>
    /** 快速提取公式与定理类环境（本地） */
    structure(attachmentId: number): Promise<StructureResult>
    get(itemId: number): Promise<MetadataView>
  }
  discovery: {
    graph(
      itemId: number,
      source?: DiscoverySource,
      query?: string,
      sort?: 'recent' | 'cited'
    ): Promise<DiscoveryGraph>
    /** 读取已缓存的相关论文结果（查一次即可，避免重复联网） */
    cached(itemId: number): Promise<{ graph: DiscoveryGraph; cachedAt: string } | null>
    diagnose(itemId: number): Promise<DiscoveryDiagnosis>
  }
  works: {
    /** 关键词检索论文（OpenAlex 为主，Crossref 兜底） */
    search(
      query: string,
      opts?: {
        yearFrom?: number | null
        yearTo?: number | null
        minCited?: number | null
        oaOnly?: boolean
        page?: number
        mode?: 'keyword' | 'author' | 'doi'
        /** auto=OpenAlex+Crossref；google=Google Scholar（SerpAPI）；openalex=仅 OpenAlex */
        provider?: 'auto' | 'google' | 'semantic' | 'openalex'
        /** 排序：recent=最新优先；cited=被引降序；relevance=默认相关度 */
        sort?: 'relevance' | 'cited' | 'recent'
      }
    ): Promise<{
      results: WorkHit[]
      total: number
      source: string
      warnings: string[]
    }>
    /** 导出某条结果的 PDF（选择保存位置后下载，不加入文库） */
    savePdf(url: string, name: string): Promise<string | null>
    /** 只读本地被引记录（详情页打开/切换/重启都只调这个，绝不联网） */
    citation(itemId: number): Promise<import('./publication').CitationRecord>
    /** 用户点击「查询被引次数 / 刷新」后才联网（仅 SerpAPI Google Scholar） */
    citationQuery(
      itemId: number,
      opts?: { force?: boolean; candidateId?: string }
    ): Promise<import('./publication').CitationRecord>
    /** 在系统浏览器打开 Google Scholar 检索（次级入口） */
    openScholar(query: string): Promise<void>
  }
  /** 发表信息：期刊 / 会议 / 预印本（含手动修正与来源） */
  publication: {
    get(itemId: number): Promise<{
      info: import('./publication').PublicationInfo
      line: string
      catalog: string
    }>
    enrich(
      itemId: number,
      opts?: { force?: boolean }
    ): Promise<{
      info: import('./publication').PublicationInfo
      line: string
      catalog: string
      warnings: string[]
    }>
    save(
      itemId: number,
      patch: Partial<import('./publication').PublicationInfo>
    ): Promise<{
      info: import('./publication').PublicationInfo
      line: string
      catalog: string
    }>
  }
  /** 领域调研：几篇种子论文 → 检索 → 并发快速拆解 → 多视角推荐 */
  survey: {
    run(opts: import('./survey').SurveyRunOptions): Promise<import('./survey').SurveyResult>
  }
  translate: {
    run(attachmentId: number, opts?: TranslateOptions): Promise<Translation>
    /** 只重译译文 PDF 的某一页（1 基），其余页不动 */
    retranslatePage(id: number, page: number): Promise<Translation>
    /** 取消正在进行的翻译 */
    cancel(requestId: string): Promise<void>
    get(attachmentId: number, lang: string): Promise<Translation | null>
    /** 某附件 + 语言的译文历史（最新在前） */
    history(attachmentId: number, lang: string): Promise<Translation[]>
    /** 按 id 取某份译文 */
    getById(id: number): Promise<Translation | null>
    /** 删除某份译文（默认连同磁盘产物） */
    remove(id: number, removeFiles?: boolean): Promise<void>
    /** 只保留最近 keep 份译文（其余连文件删除），返回删除数量 */
    prune(attachmentId: number, lang: string, keep: number): Promise<number>
    /** 标记/取消「基线」（清理时永不删除） */
    setPinned(id: number, pinned: boolean): Promise<void>
    /** 预览「只保留最近 N 份」将删除哪些版本 */
    previewPrune(
      attachmentId: number,
      lang: string,
      keep: number
    ): Promise<Array<{ id: number; engine: string; date_added: string; pinned: number; bytes: number }>>
    /** 回滚：把某个历史版本设为「最新」 */
    rollback(id: number): Promise<void>
    /** 读取译文的 Markdown 文本 */
    readMarkdown(id: number, which: 'translation' | 'bilingual'): Promise<string>
    /** 扫描未被引用的译文产物（孤儿文件） */
    orphans(): Promise<{
      dir: string
      orphans: Array<{ name: string; bytes: number }>
      bytes: number
    }>
    /** 删除孤儿文件（names 省略则先扫描），返回删除数量 */
    cleanOrphans(names?: string[]): Promise<number>
    /** 把文本报告另存到用户指定位置（返回路径，取消为 null） */
    saveReport(defaultName: string, content: string): Promise<string | null>
    /** 按译文产物路径（相对 data/）反查译文（文件面板「译文 PDF/HTML」用） */
    getByPath(path: string): Promise<TranslationTarget | null>
    /** 翻译自检：为什么翻译不出来 */
    diagnose(attachmentId: number): Promise<TranslateDiagnosis>
    read(translationId: number): Promise<Uint8Array>
  /** 块级映射：源矩形 -> 译文实际落版矩形（没有映射时返回 null） */
  map(translationId: number): Promise<import('./types').TranslationMap | null>
    /** 读取译文的 HTML 版本（可读网页） */
    readHtml(translationId: number): Promise<string>
    /** 读取单语网页译文 HTML 并高亮命中词 */
    readHtmlMarked(translationId: number, query: string): Promise<string>
    /** 读取中英对照 HTML */
    readBilingual(translationId: number): Promise<string>
    /** 读取中英对照 HTML 并高亮命中词 */
    readBilingualMarked(translationId: number, query: string): Promise<string>
    /** 用系统默认浏览器打开 HTML 译文 */
    openHtml(translationId: number): Promise<void>
    /** 另存 HTML，返回保存路径（取消则 null） */
    saveHtml(translationId: number): Promise<string | null>
    /** 另存 Markdown（translation=译文；bilingual=中英对照），返回保存路径（取消则 null） */
    saveMarkdown(
      translationId: number,
      which: 'translation' | 'bilingual'
    ): Promise<string | null>
    /** 把译文/对照 Markdown 归档进该条目的笔记 */
    exportToNote(
      translationId: number,
      which: 'translation' | 'bilingual'
    ): Promise<{ noteKey: string } | null>
    /** 打包导出（PDF+HTML+对照+Markdown → ZIP），返回 zip 绝对路径 */
    exportZip(translationId: number): Promise<string>
    /** 一键归档：译文+对照入笔记 + 打包 ZIP */
    archiveAll(translationId: number): Promise<{ noteKey: string; zip: string }>
    /** 导出质量自检清单为 Markdown，返回文件绝对路径 */
    exportQa(translationId: number): Promise<string>
    /** 把质量自检清单归档进该条目的笔记 */
    exportQaToNote(translationId: number): Promise<{ noteKey: string }>
    /** 把当前视图（含命中高亮）另存为 HTML 快照（返回路径，取消为 null） */
    saveSnapshot(translationId: number, query: string, theme: string, kind?: 'bilingual' | 'html'): Promise<string | null>
    /** 划词翻译：翻译一段文本 */
    text(text: string, lang?: string): Promise<{ text: string; backend: string }>
  }
  system: {
    health(): Promise<SystemHealth>
    testProvider(): Promise<ProviderTestResult>
  }
  search: {
    query(text: string, limit?: number): Promise<SearchHit[]>
    index(attachmentId: number): Promise<{ indexed: number; model: string }>
  }
  ai: {
    ask(question: string, opts?: AskRequest): Promise<AskResult>
    /** 流式问答：逐段回调 delta（同一套检索/引用）；进度走 onProgress */
    askStream(
      question: string,
      opts: AskRequest & { streamId: string },
      onDelta: (delta: string) => void
    ): Promise<AskResult>
    /** 订阅问答/翻译进度（返回取消订阅） */
    onProgress(cb: (p: AskProgressEvent) => void): () => void
    /** 取消进行中的问答/翻译（按 requestId；省略则取消本窗口全部） */
    cancel(requestId?: string): Promise<boolean>
    /** 图片 → 公式 / LaTeX（视觉模型） */
    formula(
      imageB64: string,
      mime?: string
    ): Promise<{ latex: string; kind: string; note?: string | null }>
    /** 表格图片 → GitHub 风格 Markdown 表格（视觉模型） */
    table(
      imageB64: string,
      mime?: string
    ): Promise<{ markdown: string; found: boolean; note?: string | null }>
    /** 公式识别**候选**（多引擎，各自置信度；不在此选择） */
    formulaCandidates(
      imageB64: string,
      rawText: string
    ): Promise<{
      candidates: import('./formula-ocr').OcrCandidate[]
      unavailable: string[]
      errors: Array<{ engine: string; error: string }>
    }>
    /** 选中文字 → LaTeX（纯文本转换） */
    latex(text: string): Promise<{ latex: string }>
    /** 对话历史：列表 / 详情 / 新建 / 追加消息 / 重命名 / 删除 / 生成标题 */
    listConversations(limit?: number): Promise<import('./types').AiConversationSummary[]>
    getConversation(
      id: number
    ): Promise<{ conversation: import('./types').AiConversation; messages: import('./types').AiChatMessage[] } | null>
    createConversation(input: {
      itemId?: number | null
      attachmentId?: number | null
      title?: string
    }): Promise<import('./types').AiConversation>
    appendMessage(
      conversationId: number,
      msg: {
        role: 'user' | 'assistant'
        content: string
        citations?: unknown
        /** 选区上下文（完整原文/附件/页码），随消息持久化 */
        context?: import('./types').AskSelection | null
      }
    ): Promise<number>
    renameConversation(id: number, title: string): Promise<boolean>
    deleteConversation(id: number): Promise<boolean>
    generateTitle(id: number, force?: boolean): Promise<string>
    /** 用 AI 找论文：一句话需求 → 结构化、已去重的论文结果（供一键入库） */
    findPapers(
      question: string,
      opts?: {
        limit?: number
        sort?: 'relevance' | 'cited' | 'recent'
        yearFrom?: number | null
        yearTo?: number | null
        minCited?: number | null
        oaOnly?: boolean
        /** 是否让模型润色检索式（默认 true） */
        useAi?: boolean
      }
    ): Promise<PaperFindResult>
  }
  settings: {
    get(): Promise<PublicSettings>
    save(patch: SettingsPatch): Promise<PublicSettings>
    /** 导出设置为 JSON（不含 API Key） */
    exportFile(): Promise<string | null>
    /** 从 JSON 导入设置（返回新设置，取消为 null） */
    importFile(): Promise<PublicSettings | null>
    /** 联网检索三态：读（off 关闭 / auto 自动 / always 始终） */
    webSearchGet(): Promise<import('./types').AskWebMode>
    /** 联网检索三态：写（返回写入后的模式） */
    webSearchSet(mode: import('./types').AskWebMode): Promise<import('./types').AskWebMode>
    /** 「严格依据文献」模式：读 */
    strictEvidenceGet(): Promise<boolean>
    /** 「严格依据文献」模式：写 */
    strictEvidenceSet(on: boolean): Promise<boolean>
    /** 知识库占位状态（PD31：只读；首次读取会创建空目录，不实现检索） */
    knowledgeStatus(): Promise<KnowledgeStatus>
  }
  /**
   * 知识库（PD33 阶段 1a）：提案 → 审核 → 发布。
   * AI 只能创建/修改提案；正式条目只在用户调用 `publishBatch` 时由主进程事务写入。
   */
  knowledge: {
    /** 新建提案批次；带同一 idempotencyKey 重复调用返回既有批次 */
    createBatch(input: CreateKnowledgeBatchInput): Promise<KnowledgeBatch>
    listBatches(limit?: number): Promise<KnowledgeBatch[]>
    getBatch(batchId: number): Promise<KnowledgeBatch | null>
    /** 创建提案（未接受前不影响任何正式条目） */
    createProposal(
      batchId: number,
      input: CreateKnowledgeProposalInput
    ): Promise<KnowledgeProposalSummary>
    /** 待审列表：按批次 / 论文 / 状态过滤 */
    listProposals(filter?: KnowledgeProposalFilter): Promise<KnowledgeProposalSummary[]>
    /** 单条提案：内容、基线快照、差异、来源证据、审核记录 */
    getProposal(proposalId: number): Promise<KnowledgeProposalDetail | null>
    /** 接受（只改提案状态，仍需单独发布） */
    acceptProposal(proposalId: number, reason?: string): Promise<KnowledgeProposalSummary>
    /** 拒绝（必须写理由，便于审计） */
    rejectProposal(proposalId: number, reason: string): Promise<KnowledgeProposalSummary>
    /** 编辑后接受：改写内容/证据并置为已接受 */
    editAndAccept(
      proposalId: number,
      patch: {
        content?: KnowledgeContent
        evidence?: KnowledgeEvidenceInput[]
        reason?: string
      }
    ): Promise<KnowledgeProposalSummary>
    /** 已发布条目列表 */
    listEntries(
      filter?: { itemId?: number | null; kind?: KnowledgeKind; state?: KnowledgeEntryState }
    ): Promise<KnowledgeEntrySummary[]>
    /** 条目详情（含来源证据与版本历史） */
    getEntry(entryId: number): Promise<KnowledgeEntryDetail | null>
    /**
     * 发布（用户显式触发）：单 SQLite 事务；版本冲突或来源待核验 → 整批不写并返回 conflicts；
     * 重复发布同一提案不新增条目/版本（alreadyPublished=true）。
     */
    publishBatch(batchId: number, proposalIds?: number[]): Promise<KnowledgePublishResult>
    /**
     * 论文拆解结果 → 知识库（PD38）：把拆解 markdown 切成要点，生成一个 source=digest
     * 的提案批次（全部 pending_review）。重复同步同一份内容幂等，不会重复建批次/提案；
     * 绝不直接发布正式条目。
     */
    syncDigest(input: DigestSyncInput): Promise<DigestSyncResult>
    /**
     * 我的笔记 → 知识库（PD41）：把一个条目下所有笔记的正文切成要点，生成
     * source=note 的提案批次（全部 pending_review），绝不自动发布。
     * 同一段内容重复导入（含与译文导入重复）不会重复生成提案。
     */
    noteImport(input: KnowledgeImportInput): Promise<KnowledgeImportResult>
    /**
     * 已完成的译文 → 知识库（PD41）：生成 source=translation 的提案批次（全部待审核）。
     * 同一 attachment+lang+内容指纹只产生一条提案；笔记里已导入过的同段内容会跳过。
     */
    translationImport(input: KnowledgeImportInput): Promise<KnowledgeImportResult>
    /**
     * 批次内的论文列表（PD43）：按 item_id 聚合条数与待审数，供暂存区「按论文筛选」。
     */
    batchPapers(batchId: number): Promise<KnowledgeBatchPaper[]>
    /**
     * 批处理产物同步（PD43/PD44）：一次批处理（batch_run_id）只对应一个知识库提案批次；
     * PD44 增加按勾选论文、并支持 target='mindmap' 写入各论文思维地图。
     * 知识库只创建 pending_review 提案；两目标都幂等、不覆盖用户已改名节点；绝不自动发布。
     */
    batchSync(input: BatchSyncInput): Promise<BatchSyncResult>
  }
  /** 数据安全：数据库备份 / 恢复 */
  data: {
    /** 自动安全备份目录 */
    backupDir(): Promise<string>
    /** 打开「另存备份」对话框（返回备份路径，取消为 null） */
    backup(): Promise<string | null>
    /** 打开「从备份恢复」对话框 */
    restore(): Promise<{ restored: string; safety: string | null } | null>
    /** 程序化备份（无对话框，供测试/自动化） */
    backupTo(dest: string): Promise<string>
    /** 程序化恢复（恢复前会自动安全备份当前库） */
    restoreFrom(src: string): Promise<{ restored: string; safety: string | null }>
    /** 当前测试副本的故障注入状态（正式版恒为未启用） */
    testFault(): Promise<TestFaultStatus>
  }
  batch: {
    tasks(): Promise<BatchTaskInfo[]>
    create(input: CreateBatchInput): Promise<BatchJob>
    list(): Promise<BatchJob[]>
    items(jobId: number): Promise<BatchItemRow[]>
    cancel(jobId: number): Promise<void>
    remove(jobId: number): Promise<void>
    openOutput(jobId: number): Promise<void>
    status(): Promise<BatchWindowStatus>
    /** 仅估算（不创建作业）：目标数量 + 预计模型调用次数 */
    estimate(input: CreateBatchInput): Promise<BatchEstimate>
    /** 为已结束作业新建「只重试失败项」作业 */
    retryFailed(jobId: number): Promise<BatchJob>
    /** 跨作业「一键重跑全部失败项」：按任务聚合所有终态作业中的失败项 */
    retryAllFailed(): Promise<BatchJob[]>
    /** 「开始执行」：把所有「待办（低峰计划）」作业立即开始 */
    startPending(): Promise<BatchJob[]>
    /** 「立即执行」：复用同一 task.run 单次运行（不进入队列） */
    runOnce(
      taskId: string,
      target: { attachmentId?: number | null; itemId?: number | null },
      params?: Record<string, string>
    ): Promise<{ ok: boolean; message: string; outputs: string[] }>
  }
  /** 批处理后「智能整理」：先出草稿、再预览/修改、最后保存（可撤销） */
  organize: {
    preview(request: OrganizePreviewRequest): Promise<OrganizePreviewResult>
    apply(
      drafts: OrganizeDraft[],
      opts: { scopeKey: string; label?: string | null }
    ): Promise<OrganizeApplyResult>
    versions(scopeKey?: string | null): Promise<OrganizeVersionRow[]>
    restore(versionId: number): Promise<{ ok: boolean; message: string }>
    candidates(): Promise<{ itemId: number; title: string; hasText: boolean }[]>
  }
  app: {
    openExternal(url: string): Promise<void>
    /** 复制文本到系统剪贴板 */
    copyText(text: string): Promise<void>
  }
  /** 期刊速查：用 AI 生成投稿要求摘要 + checklist */
  journals: {
    summarize(journalId: string): Promise<{ text: string; backend: string }>
  }
  /** 论文拆解（paper-analysis 技能） */
  analysis: {
    run(opts: {
      attachmentId: number
      focus?: string
      depth?: 'brief' | 'standard' | 'deep'
      /** 只输出这些维度（1–8）；留空=全部 */
      sections?: number[]
      /** 使用的技能名；留空=内置 paper-analysis */
      skill?: string
    }): Promise<{
      markdown: string
      backend: string
      pages: number
      chars: number
      truncated: boolean
      empty: boolean
      reduced?: boolean
      sections?: number[]
      calls?: number
    }>
    compare(opts: {
      attachmentIds: number[]
      focus?: string
      skill?: string
    }): Promise<{
      cards: Array<{ attachmentId: number; title: string; markdown: string }>
      compare: string
      backend: string
    }>
    /** 读取技能文本（文件优先）；name 留空=内置 paper-analysis */
    getSkill(name?: string): Promise<string>
    /** 保存技能文本到 data/skills/analysis/<name>.md */
    saveSkill(text: string, name?: string): Promise<string>
    /** 恢复内置技能文本（写入该名字对应的文件） */
    resetSkill(name?: string): Promise<string>
    /** 列出可用技能名（内置优先） */
    listSkills(): Promise<string[]>
    /** 另存为：把 from 的内容复制到 to */
    copySkill(from: string, to: string): Promise<string>
    /** 删除自定义技能（内置不可删），返回剩余技能名 */
    deleteSkill(name: string): Promise<string[]>
  }
  /** 文件面板：data/ 目录树 + VSCode 式打开 */
  files: {
    list(path?: string): Promise<FsListing>
    open(path: string): Promise<void>
    reveal(path: string): Promise<void>
    /** 用 VS Code 打开；找不到则回退系统默认方式 */
    vscode(path: string): Promise<OpenInResult>
  }
  /** 作者信息搜索（OpenAlex + 本地兜底） */
  authors: {
    search(query: string, limit?: number): Promise<{ authors: AuthorSummary[]; warnings: string[] }>
    /** 取某条目的作者名（OpenAlex / 视觉 AI 优先，本地兜底）——作者面板初始填充用 */
    forItem(itemId: number): Promise<{ names: string[]; warnings: string[] }>
    /** 仅查本地库的作者名（不联网、不调模型），用于文库列表展示 */
    forItemLocal(itemId: number): Promise<string[]>
    /**
     * 批量查本地库的作者名：一次 IPC + 一次 SQL，返回 itemId → 作者名数组。
     * 用于文库列表（避免可见行逐个 IPC 的 N+1）。
     */
    forItemsLocal(itemIds: number[]): Promise<Record<number, string[]>>
    profile(id: string): Promise<AuthorProfile>
    /** 把 OpenAlex 作者关联/合并到本地 authors 表（去重同名记录） */
    link(input: LinkAuthorInput): Promise<LinkAuthorResult>
    /** 整理本地作者：合并同名重复项 + 按 ORCID 从 OpenAlex 补齐 openalex_id */
    cleanup(): Promise<AuthorCleanupResult>
    /** 按 ORCID 批量导入本地作者（OpenAlex 查询；支持逗号/换行分隔） */
    importByOrcid(orcidText: string): Promise<ImportAuthorsResult>
  }
  /** 文献网络：作者合著 / 关键词共现 / 文献耦合 / 共被引（基于本地文库） */
  biblio: {
    get(kind: BiblioKind, limit?: number): Promise<BiblioGraph>
    /** 导出文献网络为 Pajek .net / GEXF 文件（返回保存路径，取消为 null） */
    export(kind: BiblioKind, format: 'pajek' | 'gexf'): Promise<string | null>
  }
  /** Zotero 连接器：本地 HTTP 接收端状态 / 启用切换 */
  connector: {
    status(): Promise<ConnectorStatus>
    setEnabled(enabled: boolean): Promise<ConnectorStatus>
  }
  /** 翻译技能（按内容类型的 prompt，可编辑） */
  skills: {
    list(): Promise<TranslateSkill[]>
    save(id: string, system: string, skip: boolean, scope: string): Promise<TranslateSkill[]>
    reset(): Promise<TranslateSkill[]>
    /** 导出整套技能到 JSON 文件（返回路径，取消为 null） */
    exportFile(): Promise<string | null>
    /** 选择并解析技能 JSON 文件（仅预览，返回待导入项；取消为 null） */
    importFile(): Promise<TranslateSkill[] | null>
    /** 重试最近一次导入：force=true 则覆盖版本冲突项；only 指定仅这些技能 */
    applyImport(
      force: boolean,
      only?: string[]
    ): Promise<{
      skills: TranslateSkill[]
      imported: number
      conflicts: string[]
      updates: string[]
    }>
  }
  /** 订阅来自主进程的深链（paperdesk://...），返回取消订阅函数 */
  onDeepLink(cb: (url: string) => void): () => void
  /** 订阅翻译进度，返回取消订阅函数 */
  onTranslateProgress(cb: (p: TranslateProgress) => void): () => void
  /** 订阅批处理进度，返回取消订阅函数 */
  onBatchProgress(cb: (p: BatchProgress) => void): () => void
  /** 文库条目新增/改名/删除/元数据更新，返回取消订阅函数 */
  onLibraryChanged(cb: () => void): () => void
  /**
   * 知识库批次/提案变化（PD38：拆解同步在后台写入批次后，暂存区据此刷新）。
   * 返回取消订阅函数。
   */
  onKnowledgeChanged(cb: () => void): () => void
  /**
   * AI 工具库（PD54）：集中列出 / 开关 / 重置各 AI 能力与权限。
   * 只做可用性与权限管理 —— 没有任何让 AI 自行发布内容的通道。
   */
  aiTools: {
    list(): Promise<AiToolsResult>
    /** 更新单个工具：enabled 覆盖开关，permissions 按 key 合并 */
    update(input: AiToolUpdateInput): Promise<AiToolsResult>
    /** 恢复默认（全部启用、权限全开） */
    reset(): Promise<AiToolsResult>
  }
  /** 订阅 AI 工具库变化（含独立思维地图窗口），返回取消订阅函数 */
  onAiToolsChanged(cb: (result: AiToolsResult) => void): () => void
}

/* ==================== 知识库暂存区（PD34）：纯逻辑 ==================== */

/**
 * 这些函数为什么放在 `shared/api.ts`：PD34 的 6 条单测要求「纯逻辑从已定位文件导出」，
 * 本任务只授权 `src/shared/api.ts` 这一个共享模块。分组 / 发布计划 / 编辑补丁 / 冲突文案 /
 * 状态刷新全部是无 IPC、无 DB、无 React 的纯函数：渲染层（StagingPanel）与单测
 * （scripts/test-unit.ts）共用同一份实现，不复制逻辑，也不需要新建未授权的 staging-model.ts。
 */

export type StagingGroupId = KnowledgeProposalOp

export interface StagingGroup {
  id: StagingGroupId
  label: string
  proposals: KnowledgeProposalSummary[]
  /** 组内提案总数（含已拒绝/已发布等） */
  count: number
  /** 组内仍可审核（pending_review / needs_edit / approved）的数量 */
  reviewable: number
}

export const STAGING_GROUP_LABELS: Record<StagingGroupId, string> = {
  create: '新增条目',
  update: '修改条目'
}

export const PROPOSAL_STATUS_LABELS: Record<KnowledgeProposalStatus, string> = {
  draft: '草稿',
  pending_review: '待审核',
  approved: '已接受·待发布',
  needs_edit: '需修改',
  rejected: '已拒绝',
  published: '已发布',
  withdrawn: '已撤回'
}

export function proposalStatusLabel(status: KnowledgeProposalStatus): string {
  return PROPOSAL_STATUS_LABELS[status] ?? status
}

export type StagingTone = 'pending' | 'ok' | 'warn' | 'muted'

export function proposalStatusTone(status: KnowledgeProposalStatus): StagingTone {
  switch (status) {
    case 'approved':
      return 'ok'
    case 'pending_review':
      return 'pending'
    case 'needs_edit':
      return 'warn'
    default:
      return 'muted'
  }
}

/** 仍可审核的提案：待审核 / 需修改 / 已接受（已接受还能再拒绝或改写） */
export function isProposalReviewable(status: KnowledgeProposalStatus): boolean {
  return status === 'pending_review' || status === 'needs_edit' || status === 'approved'
}

/**
 * 暂存区列表分组：固定「新增 → 修改」顺序，空组也保留（数量显示 0），
 * 避免批次里只有一类提案时界面结构跳动。
 */
export function groupProposalsByOp(
  proposals: ReadonlyArray<KnowledgeProposalSummary>
): StagingGroup[] {
  const groups: StagingGroup[] = (['create', 'update'] as const).map((id) => ({
    id,
    label: STAGING_GROUP_LABELS[id],
    proposals: [],
    count: 0,
    reviewable: 0
  }))
  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    const group = proposal.op === 'update' ? groups[1] : groups[0]
    group.proposals.push(proposal)
    group.count += 1
    if (isProposalReviewable(proposal.status)) group.reviewable += 1
  }
  return groups
}

export interface StagingPublishPlan {
  /** 已勾选（或整批）的提案数 */
  selected: number
  /** 可发布：approved 且来源已核验 */
  publishable: number
  /** 此前已发布，发布时会被跳过 */
  alreadyPublished: number
  /** 阻塞：未接受 / 来源待核验 */
  blocked: number
  /** 风险：修改类会覆盖现有条目，发布前需重点确认 */
  risky: number
  publishableIds: number[]
  blockedIds: number[]
  riskyIds: number[]
}

/**
 * 发布前展示的「受影响条目数」。与主进程 publishBatch 的检查保持一致：
 * 只有 approved + verified 才会真正写入正式条目；published 只跳过不报错。
 */
export function buildPublishPlan(
  proposals: ReadonlyArray<KnowledgeProposalSummary>
): StagingPublishPlan {
  const plan: StagingPublishPlan = {
    selected: 0,
    publishable: 0,
    alreadyPublished: 0,
    blocked: 0,
    risky: 0,
    publishableIds: [],
    blockedIds: [],
    riskyIds: []
  }
  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    plan.selected += 1
    if (proposal.status === 'published') {
      plan.alreadyPublished += 1
      continue
    }
    if (proposal.status === 'approved' && proposal.verification === 'verified') {
      plan.publishable += 1
      plan.publishableIds.push(proposal.id)
      if (proposal.op === 'update') {
        plan.risky += 1
        plan.riskyIds.push(proposal.id)
      }
    } else {
      plan.blocked += 1
      plan.blockedIds.push(proposal.id)
    }
  }
  return plan
}

/** 修改类提案会覆盖现有条目：列表里单独突出，发布前提示风险 */
export function proposalNeedsAttention(op: KnowledgeProposalOp): boolean {
  return op === 'update'
}

export interface StagingEditDraft {
  title: string
  body: string
  reason?: string
}

export interface StagingEditResult {
  ok: boolean
  errors: string[]
  patch?: { content: KnowledgeContent; reason?: string }
}

/**
 * 「编辑后接受」的提交前校验：标题/正文去掉首尾空白后不得为空；
 * 内容与基线完全一致且没写理由时提示「内容未修改」，避免无意义审核记录。
 */
export function buildEditAcceptPatch(
  current: Pick<KnowledgeContent, 'kind' | 'title' | 'body'>,
  draft: StagingEditDraft
): StagingEditResult {
  const title = String(draft?.title ?? '').trim()
  const body = String(draft?.body ?? '').trim()
  const reason = String(draft?.reason ?? '').trim()
  const errors: string[] = []
  if (!title) errors.push('标题不能为空')
  if (!body) errors.push('正文不能为空')
  const unchanged = title === current.title.trim() && body === current.body.trim()
  if (!unchanged && errors.length === 0) {
    return {
      ok: true,
      errors: [],
      patch: {
        content: { kind: current.kind, title, body },
        ...(reason ? { reason } : {})
      }
    }
  }
  if (unchanged && errors.length === 0 && reason) {
    return {
      ok: true,
      errors: [],
      patch: {
        content: { kind: current.kind, title, body },
        reason
      }
    }
  }
  if (unchanged && errors.length === 0) {
    errors.push('内容未修改：请先编辑内容或填写修改理由')
  }
  return { ok: false, errors }
}

export type StagingConflictKind =
  | 'version_conflict'
  | 'not_approved'
  | 'unverified'
  | 'missing_target'
  | 'duplicate_key'
  | 'other'

export interface StagingConflictView {
  proposalId: number
  key: string
  kind: StagingConflictKind
  message: string
}

/** 把主进程返回的冲突原因归类：版本冲突要单独点名，其余按发布检查项区分 */
export function classifyPublishConflict(conflict: KnowledgePublishConflict): StagingConflictView {
  const reason = String(conflict?.reason ?? '')
  let kind: StagingConflictKind = 'other'
  if (reason.includes('版本冲突')) kind = 'version_conflict'
  else if (reason.includes('尚未接受')) kind = 'not_approved'
  else if (reason.includes('待核验')) kind = 'unverified'
  else if (reason.includes('已不存在')) kind = 'missing_target'
  else if (reason.includes('已存在')) kind = 'duplicate_key'
  return {
    proposalId: Number(conflict?.proposalId ?? 0),
    key: String(conflict?.key ?? ''),
    kind,
    message: reason || '发布未通过检查'
  }
}

export function describePublishConflicts(
  conflicts: ReadonlyArray<KnowledgePublishConflict>
): StagingConflictView[] {
  return (Array.isArray(conflicts) ? conflicts : []).map(classifyPublishConflict)
}

export interface StagingPublishNotice {
  ok: boolean
  tone: 'ok' | 'warn' | 'error'
  message: string
}

/** 发布结果文案：成功给写入数量，失败给具体原因（版本冲突单独计数） */
export function describePublishResult(result: KnowledgePublishResult): StagingPublishNotice {
  const conflicts = describePublishConflicts(result?.conflicts ?? [])
  const versionConflicts = conflicts.filter((c) => c.kind === 'version_conflict').length
  if (result?.ok) {
    if (result.alreadyPublished && result.publishedProposalIds.length === 0) {
      return { ok: true, tone: 'ok', message: '所选提案均已发布，未新增条目或版本' }
    }
    return {
      ok: true,
      tone: 'ok',
      message: `已发布 ${result.publishedProposalIds.length} 条提案，写入 ${result.entryIds.length} 条正式条目`
    }
  }
  const head = `发布失败：${conflicts.length} 条提案未通过检查`
  const detail = conflicts.length
    ? `；${conflicts
        .slice(0, 3)
        .map((c) => c.message)
        .join('；')}`
    : ''
  const tail = versionConflicts ? `（含 ${versionConflicts} 条版本冲突）` : ''
  return { ok: false, tone: 'error', message: `${head}${tail}${detail}` }
}

/** 审核后立即刷新本地状态（不重新拉整批，避免闪烁） */
export function applyProposalStatus(
  proposals: ReadonlyArray<KnowledgeProposalSummary>,
  proposalId: number,
  status: KnowledgeProposalStatus
): KnowledgeProposalSummary[] {
  return (Array.isArray(proposals) ? proposals : []).map((proposal) =>
    proposal.id === proposalId ? { ...proposal, status } : proposal
  )
}

/** 发布成功后把命中的提案置为 published */
export function applyPublishedProposals(
  proposals: ReadonlyArray<KnowledgeProposalSummary>,
  publishedIds: ReadonlyArray<number>
): KnowledgeProposalSummary[] {
  const ids = new Set(Array.isArray(publishedIds) ? publishedIds : [])
  return (Array.isArray(proposals) ? proposals : []).map((proposal) =>
    ids.has(proposal.id) ? { ...proposal, status: 'published' } : proposal
  )
}

/** 暂存区只展示未发布提案：发布后立即从待审列表消失，避免重复发布 */
export function selectStagingProposals(
  proposals: ReadonlyArray<KnowledgeProposalSummary>
): KnowledgeProposalSummary[] {
  return (Array.isArray(proposals) ? proposals : []).filter(
    (proposal) => proposal.status !== 'published'
  )
}

/* ==================== 暂存区一键批准 / 导入归属（PD51）：纯逻辑 ==================== */

export interface StagingApproveAllBlocked {
  id: number
  title: string
  reason: string
}

export interface StagingApproveAllPlan {
  /** 待审条数（pending_review / needs_edit）：确认文案与按钮禁用都按它判断 */
  pending: number
  /** 需要先逐条接受的提案（待审且来源已核验） */
  acceptIds: number[]
  /** 接受后可以一次性发布的提案（含此前已接受、尚未发布的） */
  publishableIds: number[]
  /** 已发布 / 已拒绝 / 已撤回：本次不处理，计入「跳过」 */
  skippedIds: number[]
  /** 待审但来源未核验、或已接受但未核验：一键批准无法发布，计入「失败」明细 */
  blocked: StagingApproveAllBlocked[]
}

/**
 * 「全部批准」的提交前计划。判定与主进程 publishBatch 保持一致：
 * - pending_review / needs_edit 先调 acceptProposal（只改状态，不核验证据）；
 * - 只有 verification === 'verified' 才能在接受后写入正式条目；
 * - 已发布 / 已拒绝 / 已撤回不参与本次操作，只计数为跳过。
 */
export function buildApproveAllPlan(
  proposals: ReadonlyArray<KnowledgeProposalSummary>
): StagingApproveAllPlan {
  const plan: StagingApproveAllPlan = {
    pending: 0,
    acceptIds: [],
    publishableIds: [],
    skippedIds: [],
    blocked: []
  }
  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    if (proposal.status === 'pending_review' || proposal.status === 'needs_edit') plan.pending += 1
    if (!isProposalReviewable(proposal.status)) {
      plan.skippedIds.push(proposal.id)
      continue
    }
    if (proposal.verification !== 'verified') {
      plan.blocked.push({
        id: proposal.id,
        title: proposal.title,
        reason: '来源未核验，需先在提案详情里补齐证据后才能发布'
      })
      continue
    }
    if (proposal.status !== 'approved') plan.acceptIds.push(proposal.id)
    plan.publishableIds.push(proposal.id)
  }
  return plan
}

/** 无待审条目时禁用「全部批准」；返回 null 表示可用，返回文案即按钮 title */
export function approveAllDisabledTitle(plan: StagingApproveAllPlan): string | null {
  if (plan.pending > 0) return null
  if (plan.publishableIds.length > 0) {
    return '没有待审提案；已接受的提案请用「发布所选」'
  }
  return '本批次没有待审提案，无需全部批准'
}

/** 一键批准的二次确认文案：必须写明待审条数与将要发布/失败/跳过的数量 */
export function describeApproveAllConfirm(plan: StagingApproveAllPlan): string {
  const pending = Math.max(0, Math.floor(Number(plan.pending) || 0))
  const parts: string[] = []
  if (plan.acceptIds.length > 0) parts.push(`先接受其中 ${plan.acceptIds.length} 条`)
  if (plan.publishableIds.length > 0) parts.push(`再一次性发布 ${plan.publishableIds.length} 条`)
  if (plan.blocked.length > 0) parts.push(`${plan.blocked.length} 条来源待核验会记为失败`)
  if (plan.skippedIds.length > 0) parts.push(`${plan.skippedIds.length} 条已处理会跳过`)
  const tail = parts.length > 0 ? `：${parts.join('，')}` : ''
  return `将发布本批次全部 ${pending} 条待审提案${tail}。`
}

export type StagingApproveAllOutcomeKind = 'published' | 'skipped' | 'failed'

export interface StagingApproveAllDetail {
  id: number
  title: string
  outcome: StagingApproveAllOutcomeKind
  reason: string
}

export interface StagingApproveAllOutcome {
  published: number
  skipped: number
  failed: number
  details: StagingApproveAllDetail[]
}

/**
 * 把「计划 + 实际发布结果」聚合成界面上的统计与明细。
 * 失败明细同时覆盖 blocked（来源未核验）与发布冲突（版本 / 目标缺失等），
 * 这样用户能一眼看到「哪些没进知识库、为什么」。
 */
export function buildApproveAllOutcome(
  proposals: ReadonlyArray<KnowledgeProposalSummary>,
  plan: StagingApproveAllPlan,
  input: {
    publishedIds: ReadonlyArray<number>
    failureReasons?: ReadonlyArray<{ id: number; reason: string }>
  }
): StagingApproveAllOutcome {
  const list = Array.isArray(proposals) ? proposals : []
  const published = new Set(Array.isArray(input?.publishedIds) ? input.publishedIds : [])
  const failureReasons = new Map(
    (Array.isArray(input?.failureReasons) ? input.failureReasons : []).map((failure) => [
      failure.id,
      String(failure.reason || '').trim() || '发布未完成'
    ])
  )
  const titleOf = (id: number): string => {
    const proposal = list.find((item) => item.id === id)
    return proposal?.title?.trim() || `提案 #${id}`
  }
  const details: StagingApproveAllDetail[] = []
  for (const id of plan.publishableIds) {
    details.push(
      published.has(id)
        ? { id, title: titleOf(id), outcome: 'published', reason: '已写入知识库' }
        : {
            id,
            title: titleOf(id),
            outcome: 'failed',
            reason: failureReasons.get(id) ?? '发布未完成'
          }
    )
  }
  for (const item of plan.blocked) {
    details.push({
      id: item.id,
      title: item.title?.trim() || titleOf(item.id),
      outcome: 'failed',
      reason: item.reason
    })
  }
  for (const id of plan.skippedIds) {
    details.push({
      id,
      title: titleOf(id),
      outcome: 'skipped',
      reason: '不在本次处理范围（已发布 / 已拒绝 / 已撤回）'
    })
  }
  const count = (kind: StagingApproveAllOutcomeKind): number =>
    details.filter((detail) => detail.outcome === kind).length
  return {
    published: count('published'),
    skipped: count('skipped'),
    failed: count('failed'),
    details
  }
}

/** 一键批准结果的固定文案：已发布 N · 跳过 M · 失败 K（明细另用 details 展开） */
export function describeApproveAllResult(outcome: StagingApproveAllOutcome): string {
  const published = Math.max(0, Math.floor(Number(outcome?.published) || 0))
  const skipped = Math.max(0, Math.floor(Number(outcome?.skipped) || 0))
  const failed = Math.max(0, Math.floor(Number(outcome?.failed) || 0))
  return `已发布 ${published} · 跳过 ${skipped} · 失败 ${failed}`
}

export interface StagingImportTargetItem {
  id: number
  title: string
}

export interface StagingImportTargetInput {
  /** 当前打开论文的 itemId（来自 paperdesk.docs.active）；没有打开论文时为 null */
  activeItemId: number | null
  /** 当前查看的附件 id（来自 paperdesk.doc.<itemId>，可能没有） */
  attachmentId?: number | null
  /** 文库列表：用 itemId 反查论文标题，标题同时回显在导入结果里 */
  items: ReadonlyArray<StagingImportTargetItem>
}

export interface StagingImportTarget {
  itemId: number
  attachmentId: number | null
  title: string
}

export type StagingImportTargetResult =
  | { ok: true; target: StagingImportTarget }
  | { ok: false; reason: string }

export const STAGING_IMPORT_NO_ACTIVE_PAPER =
  '当前没有打开的论文：先在阅读区打开一篇论文，再把它的笔记 / 译文导入知识库。'

/**
 * 导入归属推导（PD51）：不再让用户在下拉里挑文献，而是从「当前打开的论文」自动推导。
 * 只认真实存在于文库里的 itemId，避免把提案挂到已删除的文献上。
 */
export function resolveStagingImportTarget(
  input: StagingImportTargetInput
): StagingImportTargetResult {
  const itemId = Number(input?.activeItemId)
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false, reason: STAGING_IMPORT_NO_ACTIVE_PAPER }
  }
  const items = Array.isArray(input?.items) ? input.items : []
  const found = items.find((item) => Number(item?.id) === itemId)
  const title = String(found?.title ?? '').trim()
  if (!found || !title) {
    return {
      ok: false,
      reason: `当前论文（#${itemId}）不在文库列表中，无法确定导入归属；请在阅读区重新打开一篇论文。`
    }
  }
  const attachmentId = Number(input?.attachmentId)
  return {
    ok: true,
    target: {
      itemId,
      attachmentId: Number.isInteger(attachmentId) && attachmentId > 0 ? attachmentId : null,
      title
    }
  }
}

export interface StagingEvidenceTarget {
  itemId: number | null
  attachmentId: number | null
  /** 1 基页码（reader 的 openTarget 口径）；证据里的 pageIndex 是 0 基 */
  page: number | null
  rect: [number, number, number, number] | null
  conversationId: number | null
  messageId: number | null
}

/** 解析证据里的 rect 字符串（"x,y,w,h"），非法值一律当没有定位 */
export function parseEvidenceRect(
  rect: string | null | undefined
): [number, number, number, number] | null {
  if (typeof rect !== 'string' || !rect.trim()) return null
  const parts = rect.split(/[,;\s]+/u).map((part) => Number(part))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return [parts[0], parts[1], parts[2], parts[3]]
}

function refNumber(
  ref: Record<string, string | number | boolean | null> | null | undefined,
  key: string
): number | null {
  const value = ref?.[key]
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 证据 → 跳转目标：论文按页（0 基 → 1 基），对话按 conversationId/messageId 高亮 */
export function evidenceTarget(evidence: KnowledgeEvidenceInput): StagingEvidenceTarget {
  const pageIndex = evidence?.pageIndex
  return {
    itemId: evidence?.itemId ?? null,
    attachmentId: evidence?.attachmentId ?? null,
    page:
      typeof pageIndex === 'number' && Number.isFinite(pageIndex) && pageIndex >= 0
        ? Math.floor(pageIndex) + 1
        : null,
    rect: parseEvidenceRect(evidence?.rect ?? null),
    conversationId: refNumber(evidence?.sourceRef, 'conversationId'),
    messageId: refNumber(evidence?.sourceRef, 'messageId')
  }
}

/* ==================== 知识库入口可见性（PD36）：纯逻辑 ==================== */

/**
 * 暂存区的数据来源。界面卡片与单测共用这一份，避免「说明里写三类、实现只认一类」。
 * 三类来源目前都由后续同步任务（论文拆解 / 批处理 / AI 助手）调用 proposal 接口产生；
 * 无论谁产生，都只能停在提案层，发布必须由用户在暂存区显式点击。
 */
export type StagingSourceId = 'analysis' | 'batch' | 'assistant'

export interface StagingSourceGuide {
  id: StagingSourceId
  /** 界面卡片标题（单测按精确字符串断言） */
  label: string
  /** 谁产生这类数据 */
  producer: string
  /** 这批数据是什么、为什么先进暂存区 */
  detail: string
}

export const STAGING_SOURCE_GUIDES: StagingSourceGuide[] = [
  {
    id: 'analysis',
    label: '论文拆解',
    producer: '论文拆解 / 精读完成后自动整理',
    detail: '把拆解出的概念、方法、结论整理成「新增条目」提案，先进暂存区等你审核。'
  },
  {
    id: 'batch',
    label: '批处理整理',
    producer: '批处理任务逐条完成后生成',
    detail: '批处理里翻译 / 拆解的论文完成整理后，可为该篇生成提案，同样不直接发布。'
  },
  {
    id: 'assistant',
    label: 'AI 助手提案',
    producer: 'AI 助手（问答或节点级操作中）',
    detail: 'AI 只能提交新增 / 修改提案；接受与发布都只能由你在暂存区点击。'
  }
]

/** 暂存区定位：只存提案与审核记录；正式条目必须经过用户显式发布 */
export const STAGING_SCOPE_NOTE =
  '暂存区只存放「待审核的提案」：审核通过并由你显式发布后，才会写入知识库正式条目。'

export interface StagingEmptyState {
  title: string
  detail: string
}

export interface StagingEmptyInput {
  batchCount: number
  hasActiveBatch: boolean
  proposalCount: number
}

/**
 * 暂存区空态：按「有没有批次 / 选没选批次 / 批次里有没有提案」分三支。
 * 未选批次时不再误显示「该批次没有待审提案」，而是引导先选批次；
 * 有提案时返回 null（由列表渲染）。PD51 起只保留一句话说明：不再给五步引导。
 */
export function stagingEmptyState(input: StagingEmptyInput): StagingEmptyState | null {
  const batchCount = Math.max(0, Math.floor(Number(input?.batchCount) || 0))
  const proposalCount = Math.max(0, Math.floor(Number(input?.proposalCount) || 0))
  if (proposalCount > 0) return null
  if (batchCount === 0) {
    return {
      title: '暂存区还是空的',
      detail:
        '拆解论文、批处理整理或 AI 助手生成的知识提案会先出现在这里；它们不会自动进入知识库。'
    }
  }
  if (!input?.hasActiveBatch) {
    return {
      title: '先选择一个提案批次',
      detail: '左侧列出了已有的提案批次；选中批次后才能查看其中的待审提案。'
    }
  }
  return {
    title: '该批次没有待审提案',
    detail: '这个批次的提案可能都已发布、已撤回，或尚未生成。'
  }
}

export interface KnowledgeEmptyState {
  title: string
  detail: string
  steps: string[]
}

/** 知识库空态：只展示已发布条目；空时把用户引到「暂存区审核 → 发布」这条链路 */
export function knowledgeEmptyState(entryCount: number): KnowledgeEmptyState | null {
  if (Math.max(0, Math.floor(Number(entryCount) || 0)) > 0) return null
  return {
    title: '知识库还没有正式条目',
    detail:
      '知识库只展示「已发布」的条目；拆解、批处理与 AI 助手产生的知识会先进入暂存区，审核通过并由你显式发布后才会出现在这里。',
    steps: [
      '打开暂存区，查看来自论文拆解 / 批处理整理 / AI 助手的提案',
      '逐条接受、拒绝或编辑后接受',
      '确认发布，条目才会写入知识库'
    ]
  }
}

/* ==================== 论文拆解同步（PD38）：纯逻辑 ==================== */

/**
 * 为什么放在 `shared/api.ts`：拆解要点切分、内容指纹、提案计划必须由渲染层（按钮提示）、
 * 主进程（批次/提案写入）与单测共用同一份实现。本文件只做纯计算，不 import 运行时模块，
 * 因此 `scripts/test-unit.ts` 能用 Node ESM 直接 import。
 */

/** 拆解同步生成的批次 task 标记（暂存区据此显示「论文拆解」来源） */
export const DIGEST_BATCH_TASK = 'digest-sync'

/** 单次同步最多拆出的要点数（避免拆解超长时生成过大的批次） */
export const DIGEST_MAX_POINTS = 12

/** 单条要点的正文上限（字符）；超出部分截断，不丢要点本身 */
export const DIGEST_POINT_MAX_CHARS = 1200

/** 单条要点标题上限 */
const DIGEST_POINT_TITLE_MAX = 160

export type DigestPointKind =
  | 'concept'
  | 'method'
  | 'result'
  | 'dataset'
  | 'metric'
  | 'claim'
  | 'question'

/** 一条拆解要点：标题 + 正文，kind 由标题关键词推导 */
export interface DigestPoint {
  /** 稳定 id（'dg-' + 8 位十六进制），同一标题+正文恒定，用于幂等与地图节点去重 */
  id: string
  kind: DigestPointKind
  title: string
  body: string
}

/** 同步计划：主进程照此创建「1 个批次 + N 个提案」，全部 pending_review */
export interface DigestKnowledgePlan {
  itemId: number
  fingerprint: string
  title: string
  points: DigestPoint[]
  batch: CreateKnowledgeBatchInput
  proposals: CreateKnowledgeProposalInput[]
}

const DIGEST_HEADING_RE = /^(#{1,6})\s+(.+)$/

/** FNV-1a 32 位（纯 JS，不依赖 crypto，保证测试环境与 Electron 结果一致） */
function digestHash32(input: string, seed: number): string {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 要点稳定 id：同一标题+正文得到同一 id，重复同步据此跳过 */
export function digestPointId(title: string, body: string): string {
  const normalized = `${String(title ?? '').trim()}\n${String(body ?? '').trim()}`
  return `dg-${digestHash32(normalized, 0x811c9dc5)}`
}

/** 拆解内容指纹：要点顺序与文本共同决定；重复同步同一份拆解命中同一指纹 */
export function digestFingerprint(points: ReadonlyArray<Pick<DigestPoint, 'title' | 'body'>>): string {
  const normalized = points
    .map((point) => `${String(point?.title ?? '').trim()}|${String(point?.body ?? '').trim()}`)
    .join('\n')
  return `${digestHash32(normalized, 0x811c9dc5)}${digestHash32(normalized, 0x01000193)}`
}

/** 清掉 markdown 记号与序号，得到可读标题 */
function cleanDigestHeading(raw: string): string {
  let text = String(raw ?? '')
    .replace(/[*_`>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/^[（(]?\d+[）).、:：]\s*/, '')
  text = text.replace(/^[一二三四五六七八九十]+[、.)）：]\s*/, '')
  text = text.replace(/^第[一二三四五六七八九十\d]+[章节部分]\s*/, '')
  return text.trim()
}

function cleanDigestBody(lines: ReadonlyArray<string>): string {
  return lines
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按标题关键词推断条目类型（只做确定性映射，不调模型） */
export function digestPointKind(title: string): DigestPointKind {
  const text = String(title ?? '')
  if (/问题|局限|不足|挑战|风险|争议/.test(text)) return 'question'
  if (/数据集|数据来源|样本|语料/.test(text)) return 'dataset'
  if (/指标|评估|度量|benchmark|评测/i.test(text)) return 'metric'
  if (/结果|发现|结论|效果|表现|提升/.test(text)) return 'result'
  if (/方法|实验|设计|流程|步骤|实现|框架|训练|算法/.test(text)) return 'method'
  if (/概念|定义|背景|理论|术语|动机/.test(text)) return 'concept'
  return 'claim'
}

/**
 * 把拆解 markdown 切成要点：优先取最深的可用标题层级（拆解默认 H3），
 * 无标题时退化为「顶层要点列表 → 空行段落 → 整段」。
 * 同一要点（标题+正文相同）只保留一次，最多 {@link DIGEST_MAX_POINTS} 条。
 */
export function digestPointsFromMarkdown(markdown: string): DigestPoint[] {
  const source = String(markdown ?? '').replace(/\r\n/g, '\n').trim()
  if (!source) return []
  const lines = source.split('\n')

  interface HeadingRow {
    level: number
    text: string
    index: number
  }
  const headings: HeadingRow[] = []
  lines.forEach((line, index) => {
    const matched = DIGEST_HEADING_RE.exec(line.trim())
    if (matched) headings.push({ level: matched[1].length, text: matched[2].trim(), index })
  })

  const sections: Array<{ title: string; lines: string[] }> = []
  const headingLevel = headings.some((row) => row.level === 3)
    ? 3
    : headings.some((row) => row.level === 2)
      ? 2
      : 0

  if (headingLevel > 0) {
    const picked = headings.filter((row) => row.level === headingLevel)
    picked.forEach((row, index) => {
      const end = index + 1 < picked.length ? picked[index + 1].index : lines.length
      sections.push({ title: row.text, lines: lines.slice(row.index + 1, end) })
    })
  } else {
    const bullets = lines.filter((line) => /^[-*+]\s+\S/.test(line.trim()))
    if (bullets.length >= 2) {
      bullets.forEach((line) => {
        const text = line.trim().replace(/^[-*+]\s+/, '')
        const head = text.split(/[。；;：:]/)[0] ?? text
        sections.push({ title: head, lines: [text] })
      })
    } else {
      const paragraphs = source
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean)
      paragraphs.forEach((block) => {
        const head = block.split('\n')[0] ?? block
        sections.push({ title: head, lines: block.split('\n') })
      })
    }
  }

  const points: DigestPoint[] = []
  const seen = new Set<string>()
  for (const section of sections) {
    const title = cleanDigestHeading(section.title).slice(0, DIGEST_POINT_TITLE_MAX)
    if (!title) continue
    const body = (cleanDigestBody(section.lines) || title).slice(0, DIGEST_POINT_MAX_CHARS)
    const id = digestPointId(title, body)
    if (seen.has(id)) continue
    seen.add(id)
    points.push({ id, kind: digestPointKind(title), title, body })
    if (points.length >= DIGEST_MAX_POINTS) break
  }
  return points
}

/** 批次标题：用户给了就用，否则由要点数推导（不伪造论文标题） */
export function digestBatchTitle(pointCount: number, explicit?: string | null): string {
  const trimmed = String(explicit ?? '').trim()
  if (trimmed) return trimmed.slice(0, 300)
  const count = Math.max(0, Math.floor(Number(pointCount) || 0))
  return `论文拆解同步 · ${count} 条要点`
}

/**
 * 构建「拆解 → 知识库」计划：一个 source=digest 的提案批次 + 每要点一条新增提案。
 * `idempotencyKey = digest:<itemId>:<fingerprint>` 由共享纯函数生成，主进程与单测同源。
 */
export function buildDigestKnowledgePlan(input: {
  itemId: number
  markdown: string
  title?: string | null
}): DigestKnowledgePlan {
  const itemId = Math.floor(Number(input?.itemId) || 0)
  if (itemId <= 0) throw new Error('缺少文献 id，无法同步拆解结果')
  const points = digestPointsFromMarkdown(input?.markdown ?? '')
  if (points.length === 0) throw new Error('这段拆解没有可同步的要点')
  const fingerprint = digestFingerprint(points)
  const batchTitle = digestBatchTitle(points.length, input?.title)
  const batch: CreateKnowledgeBatchInput = {
    title: batchTitle,
    task: DIGEST_BATCH_TASK,
    scopeType: 'item',
    scopeRef: String(itemId),
    origin: 'ai_workflow',
    aiConfigRef: null,
    workflowVersion: 'pd38',
    skillVersion: null,
    idempotencyKey: `digest:${itemId}:${fingerprint}`
  }
  const proposals: CreateKnowledgeProposalInput[] = points.map((point, index) => ({
    op: 'create',
    itemId,
    content: { kind: point.kind, title: point.title, body: point.body },
    contentNature: 'ai_suggestion',
    sourceType: 'digest',
    sourceRef: { digestFingerprint: fingerprint, digestPointId: point.id },
    evidence: [
      {
        sourceType: 'digest',
        itemId,
        quote: point.body.slice(0, 300) || point.title,
        sectionPath: point.title,
        precision: 'document'
      }
    ],
    reason: `论文拆解结果同步（要点 ${index + 1}/${points.length}）`
  }))
  return { itemId, fingerprint, title: batchTitle, points, batch, proposals }
}

/** 导入批次的 task 标记（与 main/services/knowledge.ts 的常量同值） */
export const NOTE_IMPORT_BATCH_TASK = 'note-import'
export const TRANSLATION_IMPORT_BATCH_TASK = 'translation-import'

/**
 * 批处理产物勾选同步（PD44）的批次 task 标记。
 * 与 PD43 共用同一个 `batch:<runId>` 幂等键，因此同一批处理不会产生第二个提案批次。
 */
export const BATCH_SYNC_BATCH_TASK = 'batch-sync'

/** 批次 task → 暂存区来源标签 */
export function batchSourceLabel(task: string): string {
  const value = String(task ?? '').trim()
  switch (value) {
    case DIGEST_BATCH_TASK:
      return '论文拆解'
    case NOTE_IMPORT_BATCH_TASK:
      return '我的笔记'
    case TRANSLATION_IMPORT_BATCH_TASK:
      return '我的译文'
    case BATCH_DIGEST_BATCH_TASK:
      return '批处理拆解'
    case BATCH_SYNC_BATCH_TASK:
      return '批处理'
    case 'manual':
      return '手工创建'
    case 'ai-extract-claims':
      return 'AI 提取'
    default:
      return value || '未知来源'
  }
}

/** 同步结果的用户可读文案（暂存区/拆解面板共用） */
export function describeDigestSyncResult(result: DigestSyncResult): string {
  const points = Math.max(0, Math.floor(Number(result?.pointCount) || 0))
  if (points === 0) return '这段拆解没有可同步的要点'
  const created = Math.max(0, Math.floor(Number(result?.createdProposals) || 0))
  if (created > 0) {
    return `已提交 ${points} 条要点到暂存区（批次 #${result.batchId}，待审核后才会进入知识库）`
  }
  return `这份拆解已同步过（批次 #${result.batchId}），没有重复写入`
}

/**
 * 笔记 / 译文导入结果的用户可读文案（PD41，暂存区导入区用）。
 * 三件事必须说清楚：进了几条、在哪个批次、还有几条因为重复被跳过。
 * PD51 起追加「归属论文」：导入目标由当前论文自动推导，结果里要能让用户核对。
 */
export function describeImportResult(
  result: KnowledgeImportResult,
  paperTitle?: string | null
): string {
  const label = result.source === 'note' ? '笔记' : '译文'
  const created = Math.max(0, Math.floor(Number(result?.createdProposals) || 0))
  const skipped = Math.max(0, Math.floor(Number(result?.skippedDuplicates) || 0))
  const reused = Math.max(0, Math.floor(Number(result?.reusedProposals) || 0))
  const batch = `批次 #${result.batchId}`
  const owner = String(paperTitle ?? '').trim()
  const ownerText = owner ? ` · 归属论文「${owner}」` : ''
  if (created > 0) {
    const skippedText = skipped > 0 ? `，另有 ${skipped} 段内容重复已跳过` : ''
    return `已把 ${created} 条${label}要点提交到暂存区（${batch}，待你逐条接受后才进入知识库）${skippedText}${ownerText}`
  }
  if (reused > 0) {
    return `这些${label}已经导入过（${batch}），没有重复写入${ownerText}`
  }
  if (skipped > 0) {
    return `这些${label}内容都已存在于知识库或暂存区，本次没有新增（${batch}）${ownerText}`
  }
  return `${label}导入没有产生新提案（${batch}）${ownerText}`
}

/* ==================== 批处理产物同步（PD43）：纯逻辑 ==================== */

/**
 * 批处理拆解批次的 task 标记（与 main/services/knowledge.ts 的常量同值）。
 * 一次批处理（batch_run_id）只产生一个该 task 的提案批次，暂存区据此显示「来自批处理（N 篇）」。
 */
export const BATCH_DIGEST_BATCH_TASK = 'batch-digest'

/** 会产出拆解报告、可同步到知识库的批处理任务 */
export const BATCH_DIGEST_TASK_IDS = ['analyze-paper', 'translate-analyze'] as const

/** 该批处理任务能否把产物同步到知识库（纯判定，UI 与主进程共用） */
export function isBatchDigestTask(task: string): boolean {
  return (BATCH_DIGEST_TASK_IDS as readonly string[]).includes(String(task ?? '').trim())
}

/** 计划里的一篇论文：拆解结果 + 切出的要点数 */
export interface BatchDigestPlanPaper extends BatchDigestPaper {
  pointCount: number
}

/** 「一次批处理 = 一个提案批次」的完整计划（主进程与单测同源） */
export interface BatchKnowledgePlan {
  runId: string
  batch: CreateKnowledgeBatchInput
  papers: BatchDigestPlanPaper[]
  proposals: CreateKnowledgeProposalInput[]
  /** 参与不了同步的论文（文件缺失、无要点等），由主进程采集时一并传入 */
  skippedPapers: BatchSyncSkippedPaper[]
}

/**
 * 构建「批处理产物 → 知识库」计划：
 * - 一个批次：`idempotencyKey = batch:<runId>`，同一次批处理重跑命中同一批次；
 * - 每篇论文的每个要点一条新增提案，sourceRef 带 batchRunId / batchJobId / batchItemId /
 *   digestFingerprint / digestPointId，能追溯到具体论文与拆解任务；
 * - 只生成 pending_review 提案（contentNature=ai_suggestion），发布仍需用户手动确认。
 */
export function buildBatchKnowledgePlan(input: {
  runId: string
  papers: BatchDigestPaper[]
  title?: string | null
  skipped?: BatchSyncSkippedPaper[]
  /** 批次 task 标记（PD44 传 batch-sync；缺省保持 PD43 的 batch-digest） */
  task?: string
  /** 证据来源类型（PD44 传 batch；缺省保持 PD43 的 digest） */
  sourceType?: KnowledgeSourceType
}): BatchKnowledgePlan {
  const runId = String(input?.runId ?? '').trim()
  if (!runId) throw new Error('缺少批处理批次标识，无法同步产物')
  const task = String(input?.task ?? '').trim() || BATCH_DIGEST_BATCH_TASK
  const sourceType: KnowledgeSourceType = input?.sourceType ?? 'digest'
  const isBatchSync = task === BATCH_SYNC_BATCH_TASK
  const reasonPrefix = isBatchSync ? '批处理同步' : '批处理拆解同步'
  const skipped: BatchSyncSkippedPaper[] = [...(input?.skipped ?? [])]
  const papers: BatchDigestPlanPaper[] = []
  const proposals: CreateKnowledgeProposalInput[] = []

  for (const paper of input?.papers ?? []) {
    const itemId = Math.floor(Number(paper?.itemId) || 0)
    const batchItemId = Math.floor(Number(paper?.batchItemId) || 0)
    const batchJobId = Math.floor(Number(paper?.batchJobId) || 0)
    const title = String(paper?.title ?? '').trim() || `论文 #${itemId}`
    if (itemId <= 0) {
      skipped.push({ itemId: null, batchItemId, title, reason: '缺少文献 id，无法归属提案' })
      continue
    }
    const points = digestPointsFromMarkdown(paper?.markdown ?? '')
    if (points.length === 0) {
      skipped.push({ itemId, batchItemId, title, reason: '这篇拆解没有可同步的要点' })
      continue
    }
    const fingerprint = digestFingerprint(points)
    const batchRunId = String(paper?.batchRunId ?? '').trim() || runId
    papers.push({
      itemId,
      attachmentId: paper?.attachmentId ?? null,
      batchRunId,
      batchJobId,
      batchItemId,
      title,
      markdown: paper?.markdown ?? '',
      pointCount: points.length
    })
    points.forEach((point, index) => {
      proposals.push({
        op: 'create',
        itemId,
        content: { kind: point.kind, title: point.title, body: point.body },
        contentNature: 'ai_suggestion',
        sourceType,
        sourceRef: {
          batchRunId,
          batchJobId,
          batchItemId,
          digestFingerprint: fingerprint,
          digestPointId: point.id
        },
        evidence: [
          {
            sourceType,
            itemId,
            quote: point.body.slice(0, 300) || point.title,
            sectionPath: point.title,
            precision: 'document'
          }
        ],
        reason: `${reasonPrefix}（${title.slice(0, 80)} · 要点 ${index + 1}/${points.length}）`
      })
    })
  }

  if (proposals.length === 0) {
    const reason = skipped[0]?.reason
    throw new Error(reason ? `这一批没有可同步的拆解要点（${reason}）` : '这一批还没有完成任何论文拆解，无法同步')
  }

  const explicit = String(input?.title ?? '').trim()
  const batch: CreateKnowledgeBatchInput = {
    title: explicit
      ? explicit.slice(0, 300)
      : `${isBatchSync ? '批处理同步' : '批处理拆解'} · ${papers.length} 篇`,
    task,
    scopeType: 'library',
    scopeRef: runId,
    origin: 'ai_workflow',
    aiConfigRef: null,
    workflowVersion: isBatchSync ? 'pd44' : 'pd43',
    skillVersion: null,
    idempotencyKey: `batch:${runId}`
  }
  return { runId, batch, papers, proposals, skippedPapers: skipped }
}

/** 批处理同步结果的用户可读文案（批处理面板用） */
export function describeBatchSyncResult(result: BatchSyncResult): string {
  const papers = Math.max(0, Math.floor(Number(result?.papers) || 0))
  const points = Math.max(0, Math.floor(Number(result?.pointCount) || 0))
  const created = Math.max(0, Math.floor(Number(result?.createdProposals) || 0))
  const failed = Math.max(0, Math.floor(Number(result?.failed) || 0))
  const skippedCount = Math.max(0, Math.floor(Number(result?.skipped) || 0))
  const success = Math.max(0, Math.floor(Number(result?.success) || 0))
  const firstProblem =
    result?.items?.find((item) => item.status === 'failed') ??
    result?.items?.find((item) => item.status === 'skipped') ??
    null
  const tail = firstProblem ? `；${firstProblem.title}：${firstProblem.reason}` : ''

  if (result?.target === 'mindmap') {
    const added = (result?.items ?? []).reduce(
      (sum, item) => sum + Math.max(0, Math.floor(Number(item?.added) || 0)),
      0
    )
    const reused = (result?.items ?? []).reduce(
      (sum, item) => sum + Math.max(0, Math.floor(Number(item?.reused) || 0)),
      0
    )
    const saved = skippedCount > 0 ? `；跳过 ${skippedCount} 篇` : ''
    const failedText = failed > 0 ? ` · 失败 ${failed} 篇` : ''
    if (added > 0) {
      return `已把 ${papers} 篇论文的 ${points} 条拆解要点同步到思维地图（新增 ${added} 个节点，保留 ${reused} 个已有节点${failedText}）${saved}${tail}`
    }
    if (papers === 0 || points === 0) {
      return `没有可同步到思维地图的要点（成功 ${success} 篇 · 跳过 ${skippedCount} 篇 · 失败 ${failed} 篇）${tail}`
    }
    return `思维地图里已经有这些节点，没有重复写入（${papers} 篇论文 · ${points} 条要点${failedText}）${saved}${tail}`
  }

  if (result?.items) {
    const batch = `批次 #${result.batchId}`
    const counts = `成功 ${success} 篇 · 跳过 ${skippedCount} 篇 · 失败 ${failed} 篇`
    if (created > 0) {
      return `已把这一批 ${papers} 篇论文的 ${points} 条要点提交到暂存区（${batch}，待你逐条接受后才进入知识库）；${counts}${tail}`
    }
    if (result.batchId <= 0) {
      return `没有同步任何论文到知识库（${counts}）${tail}`
    }
    return `这一批已经同步过（${batch}），没有重复写入；${counts}${tail}`
  }

  const skipped = result?.skippedPapers?.length ?? 0
  const legacyTail =
    skipped > 0 ? `；${skipped} 篇没有同步（${result.skippedPapers[0].reason}）` : ''
  const batch = `批次 #${result.batchId}`
  if (created > 0) {
    return `已把这一批 ${papers} 篇论文的 ${points} 条要点提交到暂存区（${batch}，待你逐条接受后才进入知识库）${legacyTail}`
  }
  return `这一批已经同步过（${batch}），没有重复写入${legacyTail}`
}

/* ==================== 批处理产物 → 思维地图（PD44）：纯合并逻辑 ==================== */

/** 拆解同步写入的节点来源标记（与渲染层同值） */
export const MINDMAP_DIGEST_SOURCE = 'digest'
/** 思维地图根节点 id（与渲染层同值） */
export const MINDMAP_ROOT_ID = 'root'
/** 文献没有标题时的根节点文案 */
export const MINDMAP_UNTITLED = '未命名文献'

/** 与渲染层一致的自动布局：根节点 (48,48)，拆解节点在其右侧逐行排开 */
export const MINDMAP_DIGEST_LAYOUT = {
  rootX: 48,
  rootY: 48,
  childDx: 248,
  childDy: 72
} as const

export interface MindMapDigestPoint {
  /** 稳定要点 id（缺省时按 title/body 计算） */
  id?: string
  title: string
  body?: string
}

export interface MindMapDigestMerge {
  doc: MindMapDoc
  /** 本次参与合并的要点稳定 id（按输入顺序） */
  ids: string[]
  added: number
  reused: number
}

/** 思维地图节点里保留的拆解摘要字符数（不含标题） */
export const MINDMAP_DIGEST_SNIPPET_CHARS = 90

/** 去掉常见 Markdown 记号并把换行/空白折叠成单个空格 */
export function digestSnippetText(body?: string | null): string {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+[.)]\s+/gm, '')
    .replace(/^[\s]*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

/**
 * 拆解要点写入思维地图的节点文本 = 要点标题 + 摘要片段。
 * 标题是识别条目的锚点，先保留；片段去 Markdown 记号并截断，节点不至于过高。
 */
export function digestPointNodeText(title: string, body?: string | null): string {
  const head = String(title ?? '').trim()
  const snippet = digestSnippetText(body)
  if (!snippet) return head
  const clipped =
    snippet.length > MINDMAP_DIGEST_SNIPPET_CHARS
      ? `${snippet.slice(0, MINDMAP_DIGEST_SNIPPET_CHARS).trimEnd()}…`
      : snippet
  return head ? `${head}\n${clipped}` : clipped
}

/** 新建单篇文献的思维地图（根节点 = 文献标题，保证新文献也有可用根） */
export function createMindMapDoc(itemId: number, title?: string | null): MindMapDoc {
  return {
    version: 1,
    itemId,
    rootId: MINDMAP_ROOT_ID,
    nodes: [
      {
        id: MINDMAP_ROOT_ID,
        parentId: null,
        text: String(title ?? '').trim() || MINDMAP_UNTITLED,
        x: MINDMAP_DIGEST_LAYOUT.rootX,
        y: MINDMAP_DIGEST_LAYOUT.rootY
      }
    ],
    updatedAt: new Date().toISOString()
  }
}

/**
 * 把拆解要点合并进思维地图（主进程与渲染层共用）：
 * - id = digestPointId(title, body)，同 id 已存在即 reused，绝不改标题/位置；
 * - 只给根节点追加子节点，已有节点（含用户改名节点）原样保留；
 * - 没有新增时不复制文档，调用方可据 added===0 跳过写盘。
 */
export function mergeDigestPointsIntoMindMap(
  doc: MindMapDoc,
  points: ReadonlyArray<MindMapDigestPoint>,
  layout: { rootX: number; rootY: number; childDx: number; childDy: number } = MINDMAP_DIGEST_LAYOUT
): MindMapDigestMerge {
  const root = doc?.nodes?.find((node) => node.id === doc.rootId) ?? null
  if (!root) return { doc, ids: [], added: 0, reused: 0 }
  const existing = new Set(doc.nodes.map((node) => node.id))
  const known = new Set<string>()
  const rowStart = doc.nodes.filter((node) => node.parentId === root.id).length
  const created: MindMapNode[] = []
  const ids: string[] = []
  let reused = 0
  for (const point of points ?? []) {
    const title = String(point?.title ?? '').trim()
    if (!title) continue
    const id =
      typeof point?.id === 'string' && point.id.trim()
        ? point.id.trim()
        : digestPointId(title, point?.body ?? '')
    if (!id || known.has(id)) continue
    known.add(id)
    ids.push(id)
    if (existing.has(id)) {
      reused += 1
      continue
    }
    existing.add(id)
    created.push({
      id,
      parentId: root.id,
      text: digestPointNodeText(title, point?.body ?? ''),
      x: layout.rootX + layout.childDx,
      y: layout.rootY + (rowStart + created.length) * layout.childDy,
      source: MINDMAP_DIGEST_SOURCE
    })
  }
  if (created.length === 0) return { doc, ids, added: 0, reused }
  return {
    doc: { ...doc, nodes: [...doc.nodes, ...created] },
    ids,
    added: created.length,
    reused
  }
}

/* ==================== 检索模式标注（PD42）：纯逻辑 ==================== */

/**
 * 为什么放在 `shared/api.ts`：嵌入后端判定、模式降级、RRF 融合与导出脱敏
 * 必须由主进程（search/settings）、渲染层（KnowledgePanel）与单测共用同一份实现。
 * 本文件不 import 运行时模块，因此 `scripts/test-unit.ts` 能直接用 Node ESM 导入。
 */

/** 嵌入后端能力：只有会产出真语义向量的 openai 才 semantic=true */
export interface RetrievalBacking {
  backend: string
  model: string
  /** none 与 mock/local-hash-64 都是 false：哈希相似度不是语义 */
  semantic: boolean
}

/** 与 settings.ts::embedConfig 对齐的最小设置形状（便于单测构造 partial） */
export interface RetrievalSettingsShape {
  embed?: { enabled?: string; mode?: string }
  provider?: { mode?: string; baseUrl?: string; apiKeySet?: boolean; embedModel?: string }
  retrieval?: { rerank?: string }
}

const RETRIEVAL_DEFAULT_MODEL = 'text-embedding-3-small'

/**
 * 把「设置」解析成嵌入后端能力，逐条镜像 settings.ts::embedConfig 的五个分支：
 * - embed.enabled='0' → none
 * - embed.mode='off' → none
 * - embed.mode='provider' 且 provider 非 mock、有 baseUrl/apiKey → openai
 * - embed.mode='provider' 但 provider 不完整 → mock + local-hash-64
 * - 其余（默认 local）→ mock + local-hash-64
 */
export function embedBackingFrom(settings: RetrievalSettingsShape | null | undefined): RetrievalBacking {
  const none: RetrievalBacking = { backend: 'none', model: 'none', semantic: false }
  const hash: RetrievalBacking = {
    backend: 'mock',
    model: 'local-hash-64',
    semantic: false
  }
  const embed = settings?.embed ?? {}
  if ((embed.enabled ?? '1') === '0') return none
  const mode = embed.mode ?? 'local'
  if (mode === 'off') return none
  if (mode === 'provider') {
    const provider = settings?.provider ?? {}
    if (provider.mode !== 'mock' && provider.baseUrl && provider.apiKeySet) {
      const model = provider.embedModel || RETRIEVAL_DEFAULT_MODEL
      return { backend: 'openai', model, semantic: model !== 'local-hash-64' }
    }
    return hash
  }
  return hash
}

/** 检索模式解析结果：mode 是实际生效值，requested 是调用方/用户请求值 */
export interface RetrievalModeInfo {
  mode: RetrievalMode
  requested: RetrievalMode
  backend: string
  model: string
  /** 嵌入后端是否具备真语义能力（哈希/mock 恒 false） */
  semantic: boolean
  /** 语义重排开关是否打开（默认关闭） */
  rerank: boolean
  /** 请求语义但被降级为词法时为 true，UI 必须显示原因 */
  degraded: boolean
  reason: string
}

export interface ResolveRetrievalInput {
  rerank?: boolean
  /** 是否已有向量索引；未知时传 true，只在确认为空时传 false */
  hasIndex?: boolean
}

/**
 * 决定本次检索实际做什么。四条硬规则（PD42 验收）：
 * 1. 嵌入后端为 none / local-hash-64 时一律 lexical，哈希分数不得参与 RRF；
 * 2. 语义重排是可选项且默认关闭，关闭时只做词法；
 * 3. 打开重排但后端是哈希 → 降级 lexical 且 degraded=true，写明原因；
 * 4. 请求 lexical 永不降级、也不显示降级原因。
 */
export function resolveRetrievalMode(
  requested: RetrievalMode | null | undefined,
  backing: RetrievalBacking | null | undefined,
  opts: ResolveRetrievalInput = {}
): RetrievalModeInfo {
  const want: RetrievalMode =
    requested === 'lexical' || requested === 'semantic' || requested === 'hybrid'
      ? requested
      : 'hybrid'
  const semantic = !!backing?.semantic
  const base = {
    requested: want,
    backend: backing?.backend ?? 'none',
    model: backing?.model ?? 'none',
    semantic,
    rerank: opts.rerank === true
  }

  if (want === 'lexical') {
    return { ...base, mode: 'lexical', degraded: false, reason: '' }
  }
  if (!semantic) {
    // 只有用户真的打开了重排开关才算「降级」；默认关闭时只是本来就没有语义
    if (base.backend === 'none') {
      return {
        ...base,
        mode: 'lexical',
        degraded: base.rerank,
        reason: base.rerank
          ? '未启用向量后端，语义重排无法生效，已降级为词法检索（无向量）'
          : '未启用向量后端，当前只有词法检索（无向量）'
      }
    }
    return {
      ...base,
      mode: 'lexical',
      degraded: base.rerank,
      reason: base.rerank
        ? '嵌入后端是本地哈希向量（local-hash-64），不是语义向量，已降级为词法检索'
        : '嵌入后端是本地哈希向量（local-hash-64），不是语义向量，当前只有词法检索'
    }
  }
  if (!base.rerank) {
    return {
      ...base,
      mode: 'lexical',
      degraded: false,
      reason: '语义重排未开启（默认关闭），当前只有词法检索'
    }
  }
  if (opts.hasIndex === false) {
    return {
      ...base,
      mode: 'lexical',
      degraded: true,
      reason: '尚未建立向量索引，已降级为词法检索'
    }
  }
  return { ...base, mode: want, degraded: false, reason: '' }
}

/** 界面徽标文案：词法且没有语义后端时必须明确写「无向量」 */
export function retrievalModeLabel(info: RetrievalModeInfo | null | undefined): string {
  if (!info || info.mode === 'lexical') {
    return info && info.semantic ? '词法检索（语义重排未开启）' : '词法检索（无向量）'
  }
  if (info.mode === 'semantic') return `语义检索 · ${info.model}`
  return `词法 + 语义（RRF）· ${info.model}`
}

export interface FusableHit {
  kind: string
  id: number
  score: number
}

export interface FuseHybridOptions<T extends FusableHit> {
  /** 语义是否有资格参与排序；false = 完全忽略语义命中（哈希后端必须如此） */
  eligible?: boolean
  limit?: number
  /** 语义命中不在词法结果里时，用它补一条可渲染命中；返回 null 则丢弃 */
  materialize?: (chunkId: number, score: number) => T | null
}

/**
 * RRF 融合（K=60）。eligible=false 时**不加任何语义分**，原样返回词法顺序，
 * 这是「mock/哈希后端排序必须与纯词法一致」的实现位置。
 */
export function fuseHybrid<T extends FusableHit>(
  lexical: ReadonlyArray<T>,
  semantic: ReadonlyArray<{ chunkId: number; score: number }>,
  opts: FuseHybridOptions<T> = {}
): T[] {
  const limit =
    opts.limit != null && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : Math.max(lexical.length, 1)
  if (opts.eligible !== true) return lexical.slice(0, limit)

  const K = 60
  const fused = new Map<number, number>()
  const bump = (id: number, rank: number): void => {
    fused.set(id, (fused.get(id) ?? 0) + 1 / (K + rank + 1))
  }
  const lexChunks = lexical.filter((hit) => hit.kind === 'chunk')
  lexChunks.forEach((hit, index) => bump(hit.id, index))
  semantic.forEach((hit, index) => bump(hit.chunkId, index))

  const chunkResults: T[] = []
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1])
  for (const [id, score] of ranked) {
    const fromLex = lexChunks.find((hit) => hit.id === id)
    if (fromLex) {
      chunkResults.push({ ...fromLex, score })
      continue
    }
    const materialized = opts.materialize?.(id, score)
    if (materialized) chunkResults.push(materialized)
  }
  const others = lexical.filter((hit) => hit.kind !== 'chunk')
  return [...chunkResults, ...others].slice(0, limit)
}

/**
 * 导出设置用的净荷载：深拷贝后删掉所有明文 apiKey，只保留 apiKeySet 布尔。
 * 即便调用方传了历史形状（带 apiKey），导出文件也不会出现明文 Key。
 */
export function exportSettingsPayload(settings: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(settings ?? {})) as Record<string, unknown>
  for (const key of ['openalex', 'scholar', 'semantic']) {
    const section = clone[key]
    if (!section || typeof section !== 'object') continue
    const record = section as Record<string, unknown>
    const hadKey = typeof record.apiKey === 'string' && record.apiKey.trim() !== ''
    delete record.apiKey
    record.apiKeySet = record.apiKeySet === true || hadKey
  }
  return clone
}

/* ==================== 知识库论文归属与语义引导（PD50）：纯逻辑 ==================== */

/**
 * 为什么放在 `shared/api.ts`：分组顺序、未关联兜底文案与「语义检索怎么配」的提示
 * 必须由渲染层（KnowledgePanel）与单测共用同一份实现。本文件不 import 运行时模块，
 * 因此 `scripts/test-unit.ts` 能用 Node ESM 直接导入。
 */

/** 没有可识别论文归属时的组名（也用于单条条目的论文 chip） */
export const KNOWLEDGE_UNLINKED_PAPER = '未关联论文'

/** 一条条目在知识库列表里的论文分组 */
export interface KnowledgePaperGroup {
  /** 分组键：论文 id 的字符串，或 `none`（直接拼进 data-testid） */
  key: string
  paperItemId: number | null
  /** 组头显示用的完整论文标题（不用省略号裁切） */
  paperTitle: string
  entries: KnowledgeEntrySummary[]
}

/**
 * 按论文归属分组（PD50）。
 * - 组顺序 = 该论文在入参里第一次出现的顺序（入参来自 `listEntries`，即 updated_at DESC）；
 * - 每组内部保持入参顺序；
 * - 「未关联论文」组恒定排在最后，即使它的条目先出现；
 * - `paperItemId` 有值但标题缺失时退回未关联文案，不伪造标题。
 */
export function groupKnowledgeEntries(
  entries: ReadonlyArray<KnowledgeEntrySummary> | null | undefined
): KnowledgePaperGroup[] {
  const groups: KnowledgePaperGroup[] = []
  const byKey = new Map<string, KnowledgePaperGroup>()
  let unlinked: KnowledgePaperGroup | null = null

  for (const entry of entries ?? []) {
    if (!entry) continue
    const paperId = typeof entry.paperItemId === 'number' ? entry.paperItemId : null
    const title = (entry.paperTitle ?? '').trim()
    if (paperId === null || !title) {
      unlinked ??= {
        key: 'none',
        paperItemId: null,
        paperTitle: KNOWLEDGE_UNLINKED_PAPER,
        entries: []
      }
      unlinked.entries.push(entry)
      continue
    }
    const key = String(paperId)
    let group = byKey.get(key)
    if (!group) {
      group = { key, paperItemId: paperId, paperTitle: title, entries: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.entries.push(entry)
  }

  if (unlinked) groups.push(unlinked)
  return groups
}

/**
 * 语义检索引导文案（PD50）：`retrieval.semantic === false` 时说明当前不是真语义、
 * 以及去哪里配 `/embeddings`；真语义后端返回空串（不需要提示）。
 * 后端为 none 时不能谎称「本地哈希向量」，但也必须保留 local-hash-64 这个可检索关键词。
 */
export function knowledgeEmbedHint(info: RetrievalModeInfo | null | undefined): string {
  if (!info || info.semantic) return ''
  if (info.backend === 'none') {
    return '当前没有启用任何向量后端（也不是 local-hash-64 哈希向量）：只有词法检索生效，不参与语义排序；在设置里配置模型服务的 /embeddings 后可获得真语义。'
  }
  return '当前是本地哈希向量 local-hash-64，只有词法检索生效，不参与语义排序；在设置里配置模型服务的 /embeddings 后可获得真语义。'
}

// ---------------------------------------------------------------------------
// 导入结果的「本次新增」口径（PD02）
//
// 历史实现由渲染层比较「导入前 id 集合」与「导入后全库 id 集合」来推断新条目，
// 再逐条补分组；两个导入并发时差集会互相包含对方条目，导致归错组。
// 现在分组由主进程在入库事务里写入，各入口只返回本次真正新增的 item id。
// ---------------------------------------------------------------------------

/** 一次导入里「本次新增」的条目引用；duplicate 表示命中既有文件/DOI，不算新增 */
export type ImportNewItemRef = {
  itemId?: number | null
  duplicate?: boolean
}

/**
 * 从导入结果中挑出本次真正新增的 item id：
 * - duplicate=true（命中既有 SHA-256/DOI）不是新增，不能借机改已有条目的分组；
 * - 取消 / 解析失败 / 下载失败没有 id，自然被过滤；
 * - 去重并保持出现顺序，调用方不再依赖全库差集。
 */
export function newlyImportedItemIds(refs: readonly ImportNewItemRef[]): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const ref of refs) {
    if (!ref || ref.duplicate) continue
    const id = ref.itemId
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 文件夹批量导入的单文件结果：error 表示该文件失败，duplicate 表示文件已存在 */
export type FolderImportEntry = { duplicate?: boolean; error?: boolean }

/** 文件夹批量导入的计数口径：只有本次新增算 imported，重复与失败都算 skipped */
export function summarizeFolderImport(entries: readonly FolderImportEntry[]): {
  imported: number
  skipped: number
} {
  let imported = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry || entry.error || entry.duplicate) skipped++
    else imported++
  }
  return { imported, skipped }
}

/** 多选文件导入的返回值：与 ImportPdfBatchResult 对齐，并附本次新增 id */
export type ImportPdfsOutcome = ImportPdfBatchResult & { itemIds: number[] }

/** 文件夹导入的返回值：计数 + 本次新增 id */
export type ImportFolderOutcome = ImportFolderResult & { itemIds: number[] }

/** 单条链接 / DOI 导入结果 */
export type ImportUrlOutcome = {
  ok: boolean
  message: string
  /** DOI 已存在并跳过下载时为 true */
  skipped?: boolean
  /** 条目 id：新增时为新 id，跳过时为已存在的 id（跳过条目不会改变分组） */
  itemId?: number
  /** 只含本次新增的 id；跳过 / 失败为空数组 */
  itemIds: number[]
  /** 最终下载到的 PDF 地址（诊断用） */
  pdfUrl?: string
  /** 各解析步骤的尝试记录（失败时用于展示原因） */
  attempts?: string[]
  result?: ImportPdfResult | { skipped: boolean; itemId: number }
}

/** 批量链接导入结果 */
export type ImportManyOutcome = {
  ok: boolean
  total: number
  imported: number
  skipped: number
  failed: number
  message: string
  /** 只含本次新增的 id（并发完成顺序不影响归属） */
  itemIds: number[]
  results: Array<{
    input: string
    ok: boolean
    message: string
    itemId?: number
    skipped?: boolean
  }>
}
