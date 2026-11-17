// IPC 通道常量：主进程注册、渲染进程调用的唯一来源
export const CH = {
  library: {
    list: 'library:list',
    get: 'library:get',
    importPdf: 'library:importPdf',
    importPdfs: 'library:importPdfs',
    importFolder: 'library:importFolder',
    importFromUrl: 'library:importFromUrl',
    importManyFromUrls: 'library:importManyFromUrls',
    addMetadata: 'library:addMetadata',
    rename: 'library:rename',
    delete: 'library:delete',
    /** 设置条目分组（null = 移出分组） */
    setGroup: 'library:setGroup',
    /** 批量设置分组（一次事务、一次变更广播） */
    setGroupMany: 'library:setGroupMany',
    /** 列出全部分组（含空分组与父子关系） */
    listGroups: 'library:listGroups',
    /** 新建分组（parent 为空 = 顶层） */
    createGroup: 'library:createGroup',
    /** 单个分组详情（介绍/计数） */
    getGroup: 'library:getGroup',
    /** 编辑分组（改名/移动/介绍） */
    updateGroup: 'library:updateGroup',
    /** 删除分组（叶子文献并入父级；withDescendants=true 整棵删除） */
    deleteGroup: 'library:deleteGroup',
    /** 手动标签 */
    listTags: 'library:listTags',
    tagsForItems: 'library:tagsForItems',
    setTags: 'library:setTags',
    enrich: 'library:enrich'
  },
  attachments: {
    listByItem: 'attachments:listByItem',
    readBytes: 'attachments:readBytes',
    getByKey: 'attachments:getByKey',
    getByPath: 'attachments:getByPath'
  },
  reader: {
    listAnnotations: 'reader:listAnnotations',
    createAnnotation: 'reader:createAnnotation',
    deleteAnnotation: 'reader:deleteAnnotation',
    figures: 'reader:figures',
    modules: 'reader:modules',
    formulas: 'reader:formulas',
    saveModuleLatex: 'reader:saveModuleLatex',
    figureImage: 'reader:figureImage',
    /** 页面编辑（删除页 + 版本撤销/恢复） */
    pageThumbs: 'reader:pageThumbs',
    deletePages: 'reader:deletePages',
    pageEdits: 'reader:pageEdits',
    restorePageEdit: 'reader:restorePageEdit'
  },
  notes: {
    listByItem: 'notes:listByItem',
    getForItem: 'notes:getForItem',
    getByPath: 'notes:getByPath',
    create: 'notes:create',
    save: 'notes:save',
    delete: 'notes:delete',
    addAnnotation: 'notes:addAnnotation'
  },
  mindmap: {
    load: 'mindmap:load',
    save: 'mindmap:save',
    /** AI：给选中节点生成摘要（复用 settings 里的 provider 配置） */
    summarize: 'mindmap:summarize',
    /** AI：把选中节点展开成 2–4 个子节点，返回文本由渲染层写入地图 */
    expand: 'mindmap:expand',
    /** AI：从正文找能支撑选中节点的原文段落（核对不上返回 found:false） */
    findSupport: 'mindmap:findSupport',
    /** AI：把选中节点现有子节点整理成分组（PD55） */
    optimize: 'mindmap:optimize',
    /** AI：整图优化——按整张地图大纲重新分组，不需要选中节点（PD58） */
    optimizeMap: 'mindmap:optimizeMap',
    /** 拆解覆盖式同步：生成骨架并写回地图（PD55） */
    syncDigest: 'mindmap:syncDigest',
    /** 导出当前地图（markdown 大纲 / mermaid 图）：只写用户在选择框里选中的路径 */
    export: 'mindmap:export',
    /** 读取聚合地图（全部论文 / 分组 / 单篇范围），只读不落盘 */
    loadScope: 'mindmap:loadScope',
    /** 在独立窗口打开某篇论文的思维地图（同篇复用窗口） */
    openPaper: 'mindmap:openPaper'
  },
  metadata: {
    extract: 'metadata:extract',
    structure: 'metadata:structure',
    get: 'metadata:get'
  },
  discovery: {
    graph: 'discovery:graph',
    cached: 'discovery:cached',
    diagnose: 'discovery:diagnose'
  },
  works: {
    search: 'works:search',
    savePdf: 'works:savePdf',
    /** 只读本地被引记录（详情页打开/切换/重启都不联网） */
    citation: 'works:citation',
    /** 用户主动查询被引次数（仅 SerpAPI Google Scholar，写入本地记录） */
    citationQuery: 'works:citationQuery',
    /** 在系统浏览器打开 Google Scholar 检索（次级入口，非自动请求） */
    openScholar: 'works:openScholar'
  },
  publication: {
    /** 只读发表信息（类型/期刊/会议/预印本 + 目录匹配） */
    get: 'publication:get',
    /** 联网补全发表信息（Crossref → OpenAlex，DOI 精确优先） */
    enrich: 'publication:enrich',
    /** 手动修正发表类型/期刊/会议名等（写 userFixed） */
    save: 'publication:save'
  },
  survey: {
    /** 领域调研：种子论文 → 检索 → 并发拆解 → 多视角推荐 */
    run: 'survey:run'
  },
  translate: {
    run: 'translate:run',
    retranslatePage: 'translate:retranslatePage',
    cancel: 'translate:cancel',
    get: 'translate:get',
    getByPath: 'translate:getByPath',
    history: 'translate:history',
    getById: 'translate:getById',
    remove: 'translate:remove',
    prune: 'translate:prune',
    setPinned: 'translate:setPinned',
    previewPrune: 'translate:previewPrune',
    rollback: 'translate:rollback',
    readMarkdown: 'translate:readMarkdown',
    orphans: 'translate:orphans',
    cleanOrphans: 'translate:cleanOrphans',
    saveReport: 'translate:saveReport',
    diagnose: 'translate:diagnose',
    read: 'translate:read',
    /** 块级映射（源矩形 -> 译文落版矩形），用于跨窗高亮 */
    map: 'translate:map',
    readHtml: 'translate:readHtml',
    readHtmlMarked: 'translate:readHtmlMarked',
    readBilingual: 'translate:readBilingual',
    readBilingualMarked: 'translate:readBilingualMarked',
    openHtml: 'translate:openHtml',
    saveHtml: 'translate:saveHtml',
    saveMarkdown: 'translate:saveMarkdown',
    exportToNote: 'translate:exportToNote',
    exportZip: 'translate:exportZip',
    archiveAll: 'translate:archiveAll',
    exportQa: 'translate:exportQa',
    exportQaToNote: 'translate:exportQaToNote',
    saveSnapshot: 'translate:saveSnapshot',
    text: 'translate:text'
  },
  system: {
    health: 'system:health',
    testProvider: 'system:testProvider'
  },
  search: {
    query: 'search:query',
    index: 'search:index'
  },
  ai: {
    ask: 'ai:ask',
    askStream: 'ai:askStream',
    formula: 'ai:formula',
    table: 'ai:table',
    formulaCandidates: 'ai:formulaCandidates',
    latex: 'ai:latex',
    listConversations: 'ai:listConversations',
    getConversation: 'ai:getConversation',
    createConversation: 'ai:createConversation',
    appendMessage: 'ai:appendMessage',
    renameConversation: 'ai:renameConversation',
    deleteConversation: 'ai:deleteConversation',
    generateTitle: 'ai:generateTitle',
    /** 用 AI 找论文：一句话需求 → 去重后的结构化论文列表 */
    findPapers: 'ai:findPapers',
    /** 取消进行中的问答/翻译（按 requestId；省略则取消该窗口全部） */
    cancel: 'ai:cancel'
  },
  settings: {
    get: 'settings:get',
    save: 'settings:save',
    export: 'settings:export',
    import: 'settings:import',
    /** 联网检索三态（off 关闭 / auto 自动 / always 始终）：问答时是否允许搜索网页 */
    webSearchGet: 'settings:webSearchGet',
    webSearchSet: 'settings:webSearchSet',
    /** 「严格依据文献」模式（'1' 开 / '0' 关）：只允许引用检索到的文献 */
    strictEvidenceGet: 'settings:strictEvidenceGet',
    strictEvidenceSet: 'settings:strictEvidenceSet',
    /** 知识库占位状态（PD31：只读，不实现检索） */
    knowledgeStatus: 'settings:knowledgeStatus'
  },
  data: {
    backupDir: 'data:backupDir',
    backup: 'data:backup',
    restore: 'data:restore',
    backupTo: 'data:backupTo',
    restoreFrom: 'data:restoreFrom',
    /** 测试副本故障注入状态（FA02：设置页只读展示） */
    testFault: 'data:testFault'
  },
  batch: {
    tasks: 'batch:tasks',
    create: 'batch:create',
    list: 'batch:list',
    items: 'batch:items',
    cancel: 'batch:cancel',
    remove: 'batch:remove',
    openOutput: 'batch:openOutput',
    status: 'batch:status',
    estimate: 'batch:estimate',
    retryFailed: 'batch:retryFailed',
    retryAllFailed: 'batch:retryAllFailed',
    startPending: 'batch:startPending',
    runOnce: 'batch:runOnce'
  },
  /** 批处理后「智能整理」：草稿预览 → 应用 → 版本/撤销 */
  organize: {
    preview: 'organize:preview',
    apply: 'organize:apply',
    versions: 'organize:versions',
    restore: 'organize:restore',
    candidates: 'organize:candidates'
  },
  app: {
    openExternal: 'app:openExternal',
    copyText: 'app:copyText'
  },
  journals: {
    summarize: 'journals:summarize'
  },
  // 注：ai.* 见上方 search 段（ask/formula/latex 同属 AI 能力）
  analysis: {
    run: 'analysis:run',
    compare: 'analysis:compare',
    getSkill: 'analysis:getSkill',
    saveSkill: 'analysis:saveSkill',
    resetSkill: 'analysis:resetSkill',
    listSkills: 'analysis:listSkills',
    copySkill: 'analysis:copySkill',
    deleteSkill: 'analysis:deleteSkill'
  },
  skills: {
    list: 'skills:list',
    save: 'skills:save',
    reset: 'skills:reset',
    export: 'skills:export',
    import: 'skills:import',
    applyImport: 'skills:applyImport'
  },
  /**
   * AI 工具库（PD54）：集中管理「有哪些 AI 能力、各自需要什么权限、是否启用」。
   * 只有 list / update / reset —— 没有任何「让 AI 自己批准或发布」的通道。
   */
  aiTools: {
    list: 'aiTools:list',
    update: 'aiTools:update',
    reset: 'aiTools:reset'
  },
  files: {
    list: 'files:list',
    open: 'files:open',
    reveal: 'files:reveal',
    vscode: 'files:vscode'
  },
  authors: {
    search: 'authors:search',
    profile: 'authors:profile',
    forItem: 'authors:forItem',
    forItemLocal: 'authors:forItemLocal',
    /** 批量：一次查询多个条目的已存作者（替代逐条 N+1 IPC） */
    forItemsLocal: 'authors:forItemsLocal',
    link: 'authors:link',
    cleanup: 'authors:cleanup',
    importByOrcid: 'authors:importByOrcid'
  },
  biblio: {
    get: 'biblio:get',
    export: 'biblio:export'
  },
  connector: {
    status: 'connector:status',
    setEnabled: 'connector:setEnabled'
  },
  /**
   * 知识库（PD33）：提案（AI/用户都能建）与发布在频道层就分开。
   * publishBatch 只由渲染层用户点击触发；AI 工具适配层
   * （services/knowledge-ai.ts）无法访问任何 IPC 频道。
   */
  knowledge: {
    batchCreate: 'knowledge:batchCreate',
    batchList: 'knowledge:batchList',
    batchGet: 'knowledge:batchGet',
    proposalCreate: 'knowledge:proposalCreate',
    proposalList: 'knowledge:proposalList',
    proposalGet: 'knowledge:proposalGet',
    proposalAccept: 'knowledge:proposalAccept',
    proposalReject: 'knowledge:proposalReject',
    proposalEditAccept: 'knowledge:proposalEditAccept',
    entryList: 'knowledge:entryList',
    entryGet: 'knowledge:entryGet',
    /** 发布：用户显式触发；单事务 + 版本冲突检测 + 幂等 */
    publishBatch: 'knowledge:publishBatch',
    /**
     * 论文拆解结果同步（PD38）：只创建 source=digest 的提案批次（全部待审核），
     * 不发布任何正式条目；发布仍然只能走 publishBatch。
     */
    digestSync: 'knowledge:digestSync',
    /**
     * 笔记 / 译文导入（PD41）：同样只创建待审核提案批次（source=note / translation）。
     * 这两个通道只由界面按钮触发——知识库 AI 适配层（knowledge-ai.ts）没有对应工具，
     * 也拿不到通道名，因此 AI 无法自行把内容塞进知识库。
     */
    noteImport: 'knowledge:noteImport',
    translationImport: 'knowledge:translationImport',
    /**
     * 批处理产物同步（PD43）：一次批处理（batch_run_id）只写一个提案批次。
     * 只由批处理面板按钮触发；入参只有 jobId，批次标识由主进程按作业行查得，
     * 渲染层无法伪造 runId 或指定提案内容。
     */
    batchSync: 'knowledge:batchSync',
    /** 批次内论文聚合（PD43）：暂存区「按论文筛选」的选项与计数 */
    batchPapers: 'knowledge:batchPapers'
  }
} as const

/** 渲染进程订阅的事件通道 */
export const EVT = {
  deeplink: 'deeplink',
  translateProgress: 'translate:progress',
  batchProgress: 'batch:progress',
  libraryChanged: 'library:changed',
  aiStream: 'ai:stream',
  /** 知识库条目/提案变化（发布后由主进程广播，供暂存区/知识库面板刷新） */
  knowledgeChanged: 'knowledge:changed',
  /**
   * AI 工具库变化（PD54）：开关/权限改动后由主进程广播，
   * 让问答、批处理、拆解、思维地图（含独立窗口）立刻生效，无需重启。
   */
  aiToolsChanged: 'aiTools:changed',
  /** 问答/翻译进度（检索 → 知识库 → 联网 → 分段翻译 → 模型） */
  aiProgress: 'ai:progress'
} as const
